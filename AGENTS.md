# AGENTS.md – `smart` branch (from `dumb` + forecast)

## Stack & Layout

- Branch `smart` is `dumb` plus generic forecast. `src/control.ts:40-64` same dumb curve ` -5→-2000,48→0,50→200,53→1000,55→2400,57→3550`. `src/sun.ts:1` elevation/midday via `decl`+`EoT`. `src/solcast/solcast.ts` stays stub.
- New forecast stack (pluggable): `src/forecast/types.ts` `ForecastProvider` interface, `src/forecast/openMeteoProvider.ts` (default, free no key) + `src/forecast/solcastProvider.ts` (stub for later, `SOLCAST_API_KEY`/`SOLCAST_SITE_ID`), `src/forecast/processor.ts` `calcKWh`/`estimatePower`, `src/forecast/cache.ts` `SqliteForecastStore` (`./data/heat.db`) + `Memory` fallback, `src/forecast/scheduler.ts` 1h poll (Solcast 10/day → set `FORECAST_INTERVAL_MS=21600000`).
- Entrypoint `src/index.ts:12-45` auto-picks provider (`FORECAST_PROVIDER` or `solcast` if configured else `open-meteo`), starts scheduler, `GET /allow` → `PowerService.getAvailablePower()` → `GetStateWithForecast(power, T, heaterOn, forecast, legionellaForced)`. `GET /forecast` debug, `GET /power` uses `PowerService`.
- Support modules: `src/legionella.ts` 60C/7d (`LEGIONELLA_TEMP=60`, `LEGIONELLA_INTERVAL_MS=604800000`), `src/power.ts` fallback `forecastNowKw*1000` (direct, `active_grid_B_power_W` already net), `src/policy.ts` `shouldDeferMorning` + `daily 40C` (06-10 local).
- Influx `src/fluxClient.ts:3` `solar` `active_grid_B_power_W` + `Boiler` writes. No `src/solcast/` logic needed.

## Setup

- `npm ci` (now includes `sqlite3@5.1.7` + `@types/sqlite3`, native build via `prebuild-install`). Node `19` Docker, local `v24` ok use `./node_modules/.bin/*`.
- Env `.env` (see `.env.sample`): required `PORT,INFLUX_URL,INFLUX_TOKEN,ORG`; new `FORECAST_PROVIDER=open-meteo|solcast`, `PV_ARRAYS='[{"kWp":3,"tilt":35,"azimuth":-90},{"kWp":10,"tilt":45,"azimuth":0}]'`, `PV_EFFICIENCY=0.85`, `LAT/LON`, `FORECAST_SQLITE=./data/heat.db`, `SOLCAST_*` if solcast, `LEGIONELLA_*`. `PV_ARRAYS` JSON parses via `parsePvArrays()`.

## Commands (local bins)

- `npm run build` → `dist/` (`tsconfig module NodeNext strict`).
- `npm start` → `node dist/index.js` (ensure `data/` exists, scheduler auto-starts).
- `npm run dev` → `concurrently "npx tsc --watch" "nodemon -q dist/index.js"`.
- `npm test` → `jest` 10 suites 45 tests: `control.test.ts`, `control.calculateRequiredPower.test.ts` (5 dumb points), `control.getState.test.ts` (10, sun mocked via `sun.getSunElevationUTC`), `control.forecast.test.ts` (6, defer+40C+legionella+pluggable), `forecast/processor.test.ts`, `forecast/openMeteoProvider.test.ts` (2 arrays sum), `forecast/cache.test.ts` (sqlite file + `:memory:`), `legionella.test.ts`, `power.test.ts`, `sun.test.ts`. Single: `npm test -- src/forecast/openMeteoProvider.test.ts`.
- Lint/format: `npm run lint` (`eslint@8.47.0`) / `npm run format` (`prettier` `singleQuote, printWidth 100`). `data/*.db` ignored.

## Control Gotchas (`src/control.ts:106-274`)

- Globals `currentState:106`, `retainstateUntil:107`, `StabilizationTime:109` 15s `hrtime.bigint()`. `GetState:171` delegates to `GetStateWithForecast:174` with `forecast=null, legionella=false`. `GetStateWithForecast` short-circuits `<retainstateUntil`, then `required=calculateRequiredPower:174`, `enable=power>required-(heaterOn?2496:0)`.
- Solar gate `control.ts:181-224`: if `legionellaForced` bypass gate; else if `needs40C` (`T<40 && 6<=localHour<=10`) gate `elev>=10||avail>800||mid<90`; else (normal) defer check `shouldDeferMorning:254` (`if forecast && 5<=UTChour<=9 && T<50 && remainingKWh>need+1` → require `power>required+400`), then `elev>=12||avail>2000||mid<120`. `needKWh=(50-T)*0.5`. `avail=p+(heaterOn?2496:0)`.
- Legionella forced ignores sun/defer, still needs power hysteresis. `legionella.ts:7` `LEGIONELLA_TEMP=60` every 7d via `forecastStore.lastHot()`.
- `shouldDeferMorning` extracted inline to avoid cycle, mirrors `policy.ts:18`. `DefaultSettings` interpolation `calculateRequiredPower:136` binary search flat above `57` (`dy=1e6`), slope below `-5` ≈37.7/°C.
- Test hooks `resetControlStateForTest:114`, `getControlStateForTest:119`, `HEATER_WATTS`, `SUN_CONFIG` – mock `hrtime` + `sun.getSunElevationUTC`/`minutesFromSolarMiddayUTC` (not `Date` hours).
- `T=parseFloat(req.query.temp)` can be `NaN` → `enable=false`.

## Forecast / Sun (`src/forecast/*`, `src/sun.ts`)

- `openMeteoProvider:20-60` fetches per array `https://api.open-meteo.com/v1/forecast?latitude&longitude&hourly=global_tilted_irradiance&tilt&azimuth&forecast_days=3&timezone=UTC`, `pv_estimate=irr*kWp*eff/1000`, merges by hour. Mock via `global.fetch` in tests.
- `solcastProvider:1-40` stub – later `GET /rooftop_sites/{id}/forecasts?format=json&api_key=`. `parseJson` helper for offline Solcast JSON.
- `cache.ts:15` ensures `data/` dir, `forecast` + `legionella` tables; `close():Promise` must be awaited before unlink (previous `EBUSY` bug).
- `sun.ts:1-79` both compute `N` fractional day, `decl`, `EoT`, `solarTime`. Mock with `jest.useFakeTimers` + `jest.setSystemTime(iso)` (`sun.test.ts:7`), not `getUTCHours` spy.

## Testing Quirks

- Stabilization tests must use `base + ms` absolute offsets (`control.getState.test.ts:105`), not `nowNs+ms` accumulation (3s drift flipped `TurningOff`→`Off`).
- `openMeteoProvider.test.ts` expects 2 `fetch` calls summed (3kW E +10kW S). `cache.test.ts` uses `data/test-heat-cache.db` – must `await close()` before unlink, uses `:memory:` for empty case.
- `power.test.ts` uses `jest.useFakeTimers` for `calcNowKw` inside forecast period.
