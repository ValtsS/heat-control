# heat-control – smart solar boiler

Heats a ~150L boiler from on-grid solar using a **tank horizon planner**: decide how hot the tank must be _now_ to cover the rest of today and pre-bank when tomorrow's solar is poor. Plus legionella (60 °C/7d), daily 40 °C guarantee, and WiFi-down fallback. Branch `smart` on top of `dumb`.

- Inverter → Influx `solar` (`active_grid_B_power_W`) = net surplus after house load (positive=export, negative=import). Heater 2.4 kW (`HEATER_WATTS=2496`).
- Panels: **3 kW east 35°** + **10 kW south 45°** (configurable via `PV_ARRAYS`).
- Thermostat caps the tank at ~63 °C (`TANK_MAX_TEMP=63`), never assumed above.

---

## Algorithm `src/tank.ts:planTank` + `src/control.ts:GetStateWithForecast`

Called as `GET /allow?temp=48.2&relay=0` → `PowerService.getAvailablePower()` → `GetStateWithForecast(power, T, heaterOn, forecast, legionellaForced, at)`:

### 1. Tank energy model (`src/tank.ts`)

Calibrated from measured stats:

- `energyPerDeg = TANK_LITRES * 0.001161 = 0.174 kWh/°C` (150 L)
- `TANK_LOSS_KWH_PER_DAY = 2.85` (observed 55.8 °C → 50 °C over 8.5 h = 0.68 °C/h)
- `USAGE_KWH_PER_DAY = 6.1` (good-day 8.98 kWh cycle minus 2.85 loss)

### 2. Horizon plan `planTank(at, T, forecast, cfg)` → `{ targetEod, requiredNow, solarToday, solarTomorrow, bankDelta, stale }`

```
needTomorrow  = (TARGET_TEMP-40)*EPD + tankLossKwhPerDay + usageKwhPerDay   // ≈11.6 kWh
solarToday    = calcKWh(forecast, at,   midnight, 0)      // energy still coming today
solarTomorrow = calcKWh(forecast, midnight, +24h, 0)      // energy for next day
bankDelta     = forecast fresh && solarTomorrow < needTomorrow
                ? clamp((needTomorrow - solarTomorrow)/EPD, 0, MAX_BANK_DEG) : 0
targetEod     = clamp(TARGET_TEMP + bankDelta, 40, TANK_MAX_TEMP)   // ≤63 thermostat
requiredNow   = targetEod - (solarToday - lossToEod)/EPD            // temp we must hold now
```

- **Good today & tomorrow** → big `solarToday` → `requiredNow` low → no morning heat (defer to midday).
- **Late day** → `solarToday` small → `requiredNow` climbs → heats on surplus to keep tank hot through evening (usage + overnight loss).
- **Poor tomorrow** → `bankDelta>0` → `targetEod`/`requiredNow` raised → **banks** — but only via `bankable` (today's remaining solar exceeds today's own need), so banking uses real solar surplus, never night grid import.
- **Stale/missing forecast** (`at - fetchedAt > FORECAST_MAX_AGE`) → `solarToday=0` → conservative, sun-gate only.

### 3. Decision `control.ts:GetStateWithForecast`

```
if legionellaForced → enable = true            // unconditional, may draw grid (60 °C / 7 d)
else:
  plan   = planTank(at, T, forecast, cfg)
  morning = MORNING_START_HOUR <= localHour <= MORNING_END_HOUR
  poor    = plan.poor                          // tomorrow worse (can't meet its need)

  if morning && T < MORNING_TEMP:              enable = true      // hard daily floor (may import)
  elif morning && poor && T < MORNING_POOR_TEMP: enable = true    // poor tomorrow → morning import to bare min
  elif plan.stale:                             enable = elev >= MIN_ELEV_DEG && T < requiredNow - HYS   // offline sun gate
  elif poor && plan.bankable:                  enable = T < requiredNow - HYS   // bank with today's surplus solar
  elif plan.solarToday >= MIN_SOLAR_TODAY_KWH: enable = T < requiredNoBank - HYS // decent day: use solar, don't export
  else:                                        enable = false    // crap day: bare minimum only
```

- **Winter (crap days, ~20 W boiler-phase):** `solarToday` (boiler-phase kWh) below `MIN_SOLAR_TODAY_KWH` → no all-day chase. Morning imports to `MORNING_POOR_TEMP` (45, near use → minimal overnight loss); legionella forces 60 °C ~1×/7 d. No night import to "bank" a poor tomorrow.
- **Autumn decent (Oct 31, 10 kWh total-array ≈ 3.3 boiler-phase):** `solarToday` (boiler-phase) ≥ 5 → heat toward `requiredNoBank` during the day, using the solar we generate rather than exporting (imports the ~1.2 kW shortfall on the single phase).
- **Spring/summer good:** `poor=false` in the morning → defer; `requiredNoBank` stays low while solar covers the target → heater idles; midday export surplus absorbed.
- **Banking** happens only when tomorrow is worse **and** today's remaining solar exceeds what's needed to reach the no-bank target (`plan.bankable`) — i.e. bank from real solar surplus, never from grid at night.
- Boiler is **2.4 kW single-phase**; `active_grid_B_power_W` is that phase's net surplus (~3.6-4 kW max). `HEATER_WATTS` is env-configurable.
- 15 s `StabilizationTime` + state machine unchanged. `T=NaN` → `enable=false`.

### 4. Offline / WiFi down `src/power.ts`

Fallback chain when grid data unavailable:

1. **Grid** → `active_grid_B_power_W` (net).
2. **Forecast only** → `estW = forecastNowKw*1000` (gross PV as outage estimate).
3. **Neither** → sun elevation: `estW = min(2400, max(300, elev*40))` (`policy.ts:estimatePowerFromSunElevation`), peak sun → ~2.4 kW heater power.
4. **Nothing (dark + no data)** → `undefined` → daily hot water relies on legionella forcing.

### 5. Legionella `src/legionella.ts`

`needsForcedHeat()` = no `T≥LEGIONELLA_TEMP` (60 °C) in `LEGIONELLA_INTERVAL_MS` (7 d), tracked via `lastHot` in `heat.db`. When forced → control enables unconditionally (may draw grid). Reachable since thermostat allows 63 °C.

### 6. Forecast `src/forecast/*`

- **Pluggable `ForecastProvider` (`types.ts`)** – `fetchForecast():Promise<Forecast>`. `openMeteoProvider.ts` (default, free) fetches per array `https://api.open-meteo.com/v1/forecast?latitude=57&longitude=25&hourly=global_tilted_irradiance&tilt&azimuth&forecast_days=3&timezone=UTC`, `pv_estimate=irr*kWp*PV_EFFICIENCY/1000`, sums E+S. `solcastProvider.ts` stub `GET /rooftop_sites/{id}/forecasts?format=json&api_key=` (same shape).
- **Cache `cache.ts`** `SqliteForecastStore` `./data/heat.db` (auto `mkdir -p data`) tables `forecast`+`legionella`, `Memory` fallback.
- **Scheduler `scheduler.ts`** polls `FORECAST_INTERVAL_MS` (1 h default; 6 h = 21600000 for Solcast 10/day). `GET /allow` reads cache, never blocks on fetch.
- **Staleness:** `FORECAST_MAX_AGE_MS` (default 6 h) – older forecast treated as no-data.

---

## Configuration (`.env.sample`)

```
PORT,INFLUX_URL,INFLUX_TOKEN,ORG          # required
FORECAST_PROVIDER=open-meteo|solcast
PV_ARRAYS=[{"kWp":3,"tilt":35,"azimuth":-90},{"kWp":10,"tilt":45,"azimuth":0}]
PV_EFFICIENCY=0.85 LAT=57 LON=25
FORECAST_SQLITE=./data/heat.db
SOLCAST_API_KEY= SOLCAST_SITE_ID=         # if solcast
FORECAST_INTERVAL=1h                      # poll interval ("6h" for solcast)
FORECAST_MAX_AGE=6h                       # stale forecast → sun-gate only
LEGIONELLA_TEMP=60 LEGIONELLA_INTERVAL=7d LEGIONELLA_MIN_DURATION=20m

TANK_LITRES=150
TARGET_TEMP=55
TANK_MIN_TEMP=40
TANK_LOSS_KWH_PER_DAY=2.85   # 55.8→50 over 8.5h
USAGE_KWH_PER_DAY=6.1        # 8.98 kWh cycle − loss
MAX_BANK_DEG=7
TANK_MAX_TEMP=63             # thermostat
HYSTERESIS_DEG=1
MIN_ELEV_DEG=12              # offline sun gate
MORNING_TEMP=40              # hard daily floor (may import)
MORNING_POOR_TEMP=45         # poor-tomorrow morning import floor
MORNING_START_HOUR=6 MORNING_END_HOUR=10
MIN_SOLAR_TODAY_KWH=5        # below this, crap day: bare minimum only (BOILER-phase kWh)
BOILER_PHASE_SHARE=0.33      # boiler sees ~1/3 of the 13 kWp total array
HEATER_WATTS=2496            # heater draw (single phase)
```

Durations are human-readable (`"1h"`, `"7d"`, `"20m"`, `"90s"`, plain ms) via `src/config.ts:parseDuration`.

## State machine

Heater relay state `PowerState` (`src/control.ts`), with 15 s `StabilizationTime` on transitions:

```
                    enableHeater            !enableHeater
 Undefined ────────────────► TurningOn ────────────────► On
     │ enableHeater=false                (hold 15s)     │ !enableHeater
     └────────────► TurningOff ─────────► Off ◄─────────┘
                     (hold 15s)            │ enableHeater
                                          └──► TurningOn
```

- `Undefined` (startup) → `TurningOn` if `enableHeater` else `TurningOff`.
- `TurningOn`/`TurningOff` hold 15 s (relay stabilization) then **unconditionally** become `On`/`Off` on the next non-gated call.
- `On` → `TurningOff` only when `!enableHeater`; `Off` → `TurningOn` only when `enableHeater`.
- `State2Bool` maps `On`/`TurningOn`→`true`, `Off`/`TurningOff`→`false` (relay `HEATON`/`HEAToff`).
- While `now < retainstateUntil` the state machine short-circuits and returns the current value (no re-eval, no logging).

## Running

```sh
npm ci            # pulls sqlite3 native (pin-exact: package.json has no ^ ranges)
npm test          # 10 suites 54 tests
npm run build && node dist/index.js   # or npm start / npm run dev
npm run security:audit   # npm audit --omit=dev + npm audit signatures
# Docker: sh builddocker.sh then sh startdocker.sh
# startdocker.sh mounts a named volume heat-control-data:/usr/src/app/data so the SQLite
# DB (FORECAST_SQLITE=./data/heat.db) survives restarts and rebuilds.
```

`data/` is gitignored – mount as volume in prod. `GET /power`, `GET /allow?temp=&relay=`, `GET /forecast` for ops.

### Dependency & supply-chain posture

- All versions are **pinned exact** (no `^`/`~`); `package-lock.json` (v3) is committed with integrity hashes so `npm ci` installs byte-for-byte what's on record.
- Runtime deps (`express@4.22.2`, `sqlite3@6.0.1`, `@influxdata/influxdb-client`, `dotenv`, `suncalc`) are the only things that run in production.
- The **multi-stage Dockerfile** installs `--omit=dev` in the runtime stage, so jest/babel/eslint/tar/node-gyp never ship to the deployed image – the shipped tree is just the prod runtime.
- CI (`.github/workflows/audit.yml`) runs on every push/PR: `npm audit signatures` (registry tamper check) + `npm audit --omit=dev` (fails on any runtime vuln) + tests + build.
- Dev-only vulns in the build toolchain are accepted knowingly – they never reach the runtime image. `npm run security:audit` re-checks locally.

## Behaviour vs old `dumb`

- Old static curve (`calculateRequiredPower`) + `minutesToMidday`/`avail>2000` gates are **gone** – replaced by `planTank().requiredNow` + `solarToday>0` solar gate.
- August morning: good day forecast → `requiredNow` low → no trickle heat at 05Z; bulk heat waits for export-limited midday. Poor forecast → heats on whatever surplus is available.
- 2nd half of day: `requiredNow` climbs as `solarToday` shrinks → keeps tank hot through the evening for usage + overnight loss.
