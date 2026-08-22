# AGENTS.md – `smart` branch (from `dumb` + tank planner → MPC scheduler)

## Stack & Layout

- Branch `smart` is `dumb` + generic forecast + **MPC rolling-horizon scheduler**. Primary decision is `planSchedule()` in `src/energy/planner.ts` (optimizer `solveHorizon()` in `src/energy/solver.ts`); `src/tank.ts` `planTank()` is now the **fallback** for stale/no-forecast (sun-gate). `src/sun.ts:1` `getSunElevationUTC` (decl+EoT, offline fallback). `src/solcast/solcast.ts` stub.
- Forecast stack (pluggable): `src/forecast/types.ts` `ForecastProvider` interface, `src/forecast/openMeteoProvider.ts` (default, free no key) + `src/forecast/solcastProvider.ts` (stub, `SOLCAST_API_KEY`/`SOLCAST_SITE_ID`), `src/forecast/processor.ts` `calcKWh`/`estimatePower`, `src/forecast/cache.ts` `SqliteForecastStore` (`./data/heat.db`, tables `forecast`+`legionella`+`stats`+`decisions`) + `Memory` fallback, `src/forecast/scheduler.ts` 1h poll (Solcast 10/day → `FORECAST_INTERVAL_MS=21600000`).
- Entrypoint `src/index.ts` auto-picks provider, starts scheduler, `GET /allow` → `PowerService.getAvailablePower()` → `GetStateWithForecast(power, T, heaterOn, forecast, legionellaForced)` → logs a **decision row** (see below) → `GET /logs?limit=` returns recent decisions. `GET /forecast`, `GET /power`, `GET /debug` (incl. `mpc` plan + schedule).
- **MPC modules:** `src/energy/model.ts` (pure thermal: `epd(litres)=litres*0.001161`, `stepTemp`), `src/energy/profile.ts` (`solarProfile` hourly boiler-phase kW × `BOILER_PHASE_SHARE`, hour 0 overridden by live surplus), `src/energy/solver.ts` (`solveHorizon` DP over `MPC_HORIZON_HOURS` minimizing **grid import kWh**, temp-state 0.25°C granularity, loss scales with tank temp, hard morning-floor constraint, discounted terminal value), `src/energy/planner.ts` (`planSchedule` hard overrides legionella + morning-floor + **free-surplus soak**, else solver).
- `src/tank.ts` `planTank(at, T, forecast, cfg)` → `{ targetEod, requiredNow, requiredNoBank, solarToday, solarTomorrow, bankDelta, bankable, poor, stale }` (kept as offline/stale fallback + debug). Config from env (defaults calibrated from real stats: `TANK_LITRES=150`, `TARGET_TEMP=55`, `TANK_LOSS_KWH_PER_DAY=2.85` (55.8→50/8.5h), `USAGE_KWH_PER_DAY=6.1` (8.98 kWh cycle), `MAX_BANK_DEG=7`, `TANK_MAX_TEMP=63` thermostat, `BOILER_PHASE_SHARE=0.33`, `FORECAST_MAX_AGE_MS=6h`).
- Support modules: `src/legionella.ts` 60C/7d (`LEGIONELLA_TEMP=60`, `LEGIONELLA_INTERVAL_MS=604800000`), `src/power.ts` fallback chain `influx → forecast*1000 → sun-elev*40 (≤2400) → none`, `src/policy.ts` `estimatePowerFromForecast`/`estimatePowerFromSunElevation`.
- Influx `src/fluxClient.ts` reads `INFLUX_BUCKET`/`INFLUX_MEASUREMENT`/`INFLUX_FIELD` (default `solar`/`inverter-stats`/`active_grid_B_power_W`, the net surplus on the boiler's phase; `INFLUX_RANGE` look-back) + `Boiler` writes.

## Setup

- `npm ci` (sqlite3 native via prebuild-install). Node `19` Docker, local `v24` ok – use `./node_modules/.bin/*`.
- Env `.env` (see `.env.sample`, fully commented): required `PORT,INFLUX_URL,INFLUX_TOKEN,ORG`; `INFLUX_BUCKET/MEASUREMENT/FIELD/RANGE`, `FORECAST_PROVIDER`, `PV_ARRAYS` JSON (`parsePvArrays()`), `PV_EFFICIENCY`, `LAT/LON`, `FORECAST_SQLITE`, `SOLCAST_*`, `TANK_*`, `MORNING_*` (temp + local-hour window), `MPC_HORIZON_HOURS`, `TERMINAL_FACTOR`, `HYSTERESIS_DEG`, `MIN_ELEV_DEG`, `LEGIONELLA_*`. Durations are human-readable (`src/config.ts:parseDuration`) e.g. `FORECAST_INTERVAL=1h`, `FORECAST_MAX_AGE=6h`, `LEGIONELLA_INTERVAL=7d`, `LEGIONELLA_MIN_DURATION=20m`, `INFLUX_RANGE=3m` (not `*_MS`).

## Commands (local bins)

- `npm run build` → `dist/` (`tsconfig module NodeNext strict`).
- `npm start` → `node dist/index.js` (ensure `data/` exists, scheduler auto-starts).
- `npm run dev` → `concurrently "npx tsc --watch" "nodemon -q dist/index.js"`.
- `npm test` → `jest` 12 suites 65 tests: `energy/model.test.ts` (4, thermal), `energy/solver.test.ts` (6, MPC DP), `energy/planner.test.ts` (5, planSchedule), `tank.test.ts` (8, fallback planner), `config.test.ts` (3, human-readable durations), `control.getState.test.ts` (offline sun-gate + stabilization), `control.forecast.test.ts` (8, MPC decisions/legionella/stale/pluggable), `forecast/processor.test.ts`, `forecast/openMeteoProvider.test.ts` (2 arrays sum), `forecast/cache.test.ts` (sqlite file + `:memory:` + decisions), `legionella.test.ts`, `power.test.ts`, `sun.test.ts`. Single: `npm test -- src/energy/solver.test.ts`.
- Lint/format: `npm run lint` (`eslint@8.47.0`) / `npm run format` (`prettier` `singleQuote, printWidth 100`). `data/*.db` ignored.

## Control Gotchas (`src/control.ts`, `src/energy/*`)

- Globals `currentState`, `retainstateUntil`, `StabilizationTime` 15s `hrtime.bigint()`. `GetState` delegates to `GetStateWithForecast(…, forecast=null, legionella=false)`. Short-circuit `<retainstateUntil` skips all re-eval.
- Decision (`control.ts:GetStateWithForecast`): legionellaForced → **unconditionally** `enableHeater=true` (grid). Else `plan = planSchedule(...)` (MPC). Hard overrides in `planner.ts`, in order: legionella → morning-floor (`T<MORNING_TEMP` in local window → heat, may import) → **free-surplus soak** (live phase surplus ≥ `HEATER_WATTS` and `T<maxTemp` → heat, 0 import) → `no-forecast` (caller falls back to `planTank` + sun-gate `elev>=MinElevDeg && T<requiredNow-HYS`). Otherwise `enableHeater = solver's first-step heat`.
- `solveHorizon` DP: minimize Σ `max(0, heatDrawn - solar[h])` (import kWh) over `MPC_HORIZON_HOURS=24` (default) with 0.25°C temp states, **loss-only drain** (usage is NOT a continuous leak — showers are discrete/unpredictable; modeling `USAGE_KWH_PER_DAY/24` as an hourly drain bleeds the tank ~2°C/h and forces continuous reheat = the night-bank bug). Terminal value targets the **morning floor** (not TARGET_TEMP) × `TERMINAL_FACTOR=0.5` discount, so the solver won't import to hold a warm tank at 55 but will still capture free surplus (0-cost heat).
- `planSchedule` reasons: `legionella` | `morning-floor` | `free-surplus` | `import` (solver says heat, paid) | `defer` (solver says wait) | `off` | `no-forecast`. `lastPlan` exposed via `getLastPlanForTest()`.
- Local-hour resolution is **injectable** (`getLocalHour`, default `d.getHours()`); tests pass `(d)=>d.getUTCHours()` for determinism. Morning window uses local hours.
- Stale forecast (`fetchedAt` older than `FORECAST_MAX_AGE_MS`) → `no-forecast` → sun-gate only via `planTank`.
- Decision logging: `/allow` writes one row per poll to `decisions` table (`DecisionLog`: at, temp, livePower, heatCmd, heatOn(relay, actual), reason, importKwh, nextFreeHours, solarToday/Tomorrow). `GET /logs?limit=` reads recent. `stats` (single latest row) + `saveSample` still power `/debug`.
- Test hooks `resetControlStateForTest`, `getControlStateForTest`, `getLastPlanForTest`, `HEATER_WATTS` – mock `process.hrtime.bigint` + `sun.getSunElevationUTC`. `T=NaN` → `enable=false`.
- `sun.ts:1` only `getSunElevationUTC` (removed `minutesFromSolarMiddayUTC` – dead). Mock with `jest.useFakeTimers`+`jest.setSystemTime(iso)`.

## Forecast / Sun

- `openMeteoProvider` fetches per array `https://api.open-meteo.com/v1/forecast?…&hourly=global_tilted_irradiance&tilt&azimuth&forecast_days=3&timezone=UTC`, `pv_estimate=irr*kWp*eff/1000`, sums. Mock `global.fetch`.
- `cache.ts` ensures `data/` dir; `close():Promise` must be awaited before unlink (`EBUSY` bug).

## Testing Quirks

- Stabilization tests use absolute `base + ms` offsets, not `nowNs+ms` accumulation (3s drift flipped `TurningOff`→`Off`).
- Forecast test fixtures: `makeForecast(dayKwh[], fetchedAt?)` starts 05:00 UTC, fresh `fetchedAt=new Date()` by default – pass explicit old date only for the stale test (otherwise `planTank` treats it stale and the test hits the wrong path).
- `cache.test.ts` uses `data/test-heat-cache.db` – `await close()` before unlink, `:memory:` for empty case. `power.test.ts` uses `jest.useFakeTimers` for `calcNowKw`.
