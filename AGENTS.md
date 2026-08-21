# AGENTS.md – `smart` branch (from `dumb` + tank planner)

## Stack & Layout

- Branch `smart` is `dumb` + generic forecast + tank horizon planner. `src/control.ts` has NO static curve anymore – decision is `planTank()` in `src/tank.ts`. `src/sun.ts:1` `getSunElevationUTC` (decl+EoT, offline fallback). `src/solcast/solcast.ts` stub.
- Forecast stack (pluggable): `src/forecast/types.ts` `ForecastProvider` interface, `src/forecast/openMeteoProvider.ts` (default, free no key) + `src/forecast/solcastProvider.ts` (stub, `SOLCAST_API_KEY`/`SOLCAST_SITE_ID`), `src/forecast/processor.ts` `calcKWh`/`estimatePower`, `src/forecast/cache.ts` `SqliteForecastStore` (`./data/heat.db`, tables `forecast`+`legionella`) + `Memory` fallback, `src/forecast/scheduler.ts` 1h poll (Solcast 10/day → `FORECAST_INTERVAL_MS=21600000`).
- Entrypoint `src/index.ts` auto-picks provider, starts scheduler, `GET /allow` → `PowerService.getAvailablePower()` → `GetStateWithForecast(power, T, heaterOn, forecast, legionellaForced)`. `GET /forecast` debug, `GET /power` via `PowerService`.
- `src/tank.ts` `planTank(at, T, forecast, cfg)` → `{ targetEod, requiredNow, solarToday, solarTomorrow, bankDelta, stale }`. Config from env (defaults calibrated from real stats: `TANK_LITRES=150`, `TARGET_TEMP=55`, `TANK_LOSS_KWH_PER_DAY=2.85` (55.8→50/8.5h), `USAGE_KWH_PER_DAY=6.1` (8.98 kWh cycle), `MAX_BANK_DEG=7`, `TANK_MAX_TEMP=63` thermostat, `FORECAST_MAX_AGE_MS=6h`).
- Support modules: `src/legionella.ts` 60C/7d (`LEGIONELLA_TEMP=60`, `LEGIONELLA_INTERVAL_MS=604800000`), `src/power.ts` fallback chain `influx → forecast*1000 → sun-elev*40 (≤2400) → none`, `src/policy.ts` `estimatePowerFromForecast`/`estimatePowerFromSunElevation`.
- Influx `src/fluxClient.ts` reads `INFLUX_BUCKET`/`INFLUX_MEASUREMENT`/`INFLUX_FIELD` (default `solar`/`inverter-stats`/`active_grid_B_power_W`, the net surplus on the boiler's phase; `INFLUX_RANGE` look-back) + `Boiler` writes.

## Setup

- `npm ci` (sqlite3 native via prebuild-install). Node `19` Docker, local `v24` ok – use `./node_modules/.bin/*`.
- Env `.env` (see `.env.sample`, fully commented): required `PORT,INFLUX_URL,INFLUX_TOKEN,ORG`; `INFLUX_BUCKET/MEASUREMENT/FIELD/RANGE`, `FORECAST_PROVIDER`, `PV_ARRAYS` JSON (`parsePvArrays()`), `PV_EFFICIENCY`, `LAT/LON`, `FORECAST_SQLITE`, `SOLCAST_*`, `TANK_*`, `MORNING_*` (temp + local-hour window), `HYSTERESIS_DEG`, `MIN_ELEV_DEG`, `LEGIONELLA_*`. Durations are human-readable (`src/config.ts:parseDuration`) e.g. `FORECAST_INTERVAL=1h`, `FORECAST_MAX_AGE=6h`, `LEGIONELLA_INTERVAL=7d`, `LEGIONELLA_MIN_DURATION=20m`, `INFLUX_RANGE=3m` (not `*_MS`).

## Commands (local bins)

- `npm run build` → `dist/` (`tsconfig module NodeNext strict`).
- `npm start` → `node dist/index.js` (ensure `data/` exists, scheduler auto-starts).
- `npm run dev` → `concurrently "npx tsc --watch" "nodemon -q dist/index.js"`.
- `npm test` → `jest` 10 suites 48 tests: `tank.test.ts` (6, horizon planner), `config.test.ts` (3, human-readable durations), `control.getState.test.ts` (offline sun-gate + stabilization), `control.forecast.test.ts` (8, defer/bank/40C/legionella/pluggable/stale), `forecast/processor.test.ts`, `forecast/openMeteoProvider.test.ts` (2 arrays sum), `forecast/cache.test.ts` (sqlite file + `:memory:`), `legionella.test.ts`, `power.test.ts`, `sun.test.ts`. Single: `npm test -- src/tank.test.ts`.
- Lint/format: `npm run lint` (`eslint@8.47.0`) / `npm run format` (`prettier` `singleQuote, printWidth 100`). `data/*.db` ignored.

## Control Gotchas (`src/control.ts`, `src/tank.ts`)

- Globals `currentState`, `retainstateUntil`, `StabilizationTime` 15s `hrtime.bigint()`. `GetState` delegates to `GetStateWithForecast(…, forecast=null, legionella=false)`. Short-circuit `<retainstateUntil` skips all re-eval.
- Decision (`control.ts:GetStateWithForecast`): legionellaForced → **unconditionally** `enableHeater=true` (grid, regardless of power/sun). Else `plan = planTank(at, T, forecast, defaultTankConfig())`; `solarOk = plan.stale ? elevation>=MinElevDeg : plan.solarToday>0`; cold morning `T<MORNING_TEMP && MORNING_START_HOUR<=localHour<=MORNING_END_HOUR` → `enableHeater = true` (hard daily guarantee, may import); else `enableHeater = T < plan.requiredNow - HYSTERESIS_DEG && solarOk`. No static power curve, no `minutesToMidday`, no `avail>2000` gate, **no instantaneous surplus gate** (plan defers to peak). `MinElevDeg`, `MORNING_*` all env-configurable. Boiler is 2.4 kW single-phase; `active_grid_B_power_W` is that phase's net surplus.
- `planTank` math: `EPD = litres*0.001161`; `solarToday/Tomorrow = ForecastProcessor.calcKWh(forecast, from, to, 0)`; `needTomorrow = (targetTemp-minTemp)*EPD + tankLossKwhPerDay + usageKwhPerDay`; `bankDelta = clamp((needTomorrow - solarTomorrow)/EPD, 0, maxBankDeg)` only if forecast fresh; `targetEod = clamp(targetTemp+bankDelta, minTemp, TANK_MAX_TEMP≤65)`; `requiredNow = targetEod - (solarToday - lossToEod)/EPD`.
- Stale forecast (`fetchedAt` older than `FORECAST_MAX_AGE_MS`) → `solarToday=0, solarTomorrow=0` → conservative requiredNow, sun-gate only.
- Test hooks `resetControlStateForTest`, `getControlStateForTest`, `HEATER_WATTS` – mock `process.hrtime.bigint` + `sun.getSunElevationUTC`. `T=NaN` → `enable=false`.
- `sun.ts:1` only `getSunElevationUTC` (removed `minutesFromSolarMiddayUTC` – dead). Mock with `jest.useFakeTimers`+`jest.setSystemTime(iso)`.

## Forecast / Sun

- `openMeteoProvider` fetches per array `https://api.open-meteo.com/v1/forecast?…&hourly=global_tilted_irradiance&tilt&azimuth&forecast_days=3&timezone=UTC`, `pv_estimate=irr*kWp*eff/1000`, sums. Mock `global.fetch`.
- `cache.ts` ensures `data/` dir; `close():Promise` must be awaited before unlink (`EBUSY` bug).

## Testing Quirks

- Stabilization tests use absolute `base + ms` offsets, not `nowNs+ms` accumulation (3s drift flipped `TurningOff`→`Off`).
- Forecast test fixtures: `makeForecast(dayKwh[], fetchedAt?)` starts 05:00 UTC, fresh `fetchedAt=new Date()` by default – pass explicit old date only for the stale test (otherwise `planTank` treats it stale and the test hits the wrong path).
- `cache.test.ts` uses `data/test-heat-cache.db` – `await close()` before unlink, `:memory:` for empty case. `power.test.ts` uses `jest.useFakeTimers` for `calcNowKw`.
