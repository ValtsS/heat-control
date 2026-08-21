# heat-control – smart solar boiler

Heats a ~150L boiler from on-grid solar, with forecast-aware deferral, legionella protection and WiFi-down fallback. Branch `smart` on top of `dumb`.

- Inverter → Influx `solar` (`active_grid_B_power_W`) = grid surplus after house load. Heater is 2.4 kW (`HEATER_WATTS=2496` with hysteresis).
- Panels: **3 kW east 35°** + **10 kW south 45°** (configurable via `PV_ARRAYS`).
- Goal: hot water daily (≥40 °C morning) and **60 °C at least once per 7 days** even on bad weather, otherwise use sun.

---

## Algorithm `src/control.ts:181-281` + `src/power.ts` + `src/legionella.ts`

Called as `GET /allow?temp=48.2&relay=0` → `GetStateWithForecast(power, T, heaterOn, forecast, legionellaForced, at)`:

### 1. Input

- `power` – **available** surplus `W` from `GET /power` → `FluxClient.getPower()` (`fluxClient.ts:26` last 3 min `active_grid_B_power_W`). If `undefined` (WiFi/Inﬂux down) `PowerService` (`power.ts:14`) tries:
  1. `forecastNowKw = ForecastProcessor.calcNowKw(forecast, now)` (`processor.ts:42`) → `estW = max(0, forecastNowKw*1000 - HOUSE_BASE_W)`
  2. if no forecast → `sun elev >15° → 400 W` else `undefined` (no heat unless legionella forces it).
- `T` – boiler `parseFloat(req.query.temp)` (`index.ts:42`) – `NaN` → `enable=false`.
- `heaterOn` – `relay==1`.
- `forecast` – 48 h `Forecast` from `SqliteForecastStore` (`forecast/cache.ts`) – hourly `pv_estimate kW` per array summed. `null` on first boot.
- `legionellaForced` – `await legionella.needsForcedHeat()` (`legionella.ts:12`) = `now - last_hot > 7d` where `last_hot` is last `T≥60 °C` stored in same `heat.db` table `legionella` (`cache.ts:28`). Updated on every `recordIfHot( T≥60 )`.

### 2. Stabilization `control.ts:189-191`

Globals `currentState:106` / `retainstateUntil:107` 15 s `hrtime.bigint()`. If `now < retainUntil` → return `State2Bool(currentState)` without re-evaluating (prevents relay chatter). `TurningOn/TurningOff` lock 15 s, `On/Off` → `now`.

### 3. Required power `control.ts:194`

`required = calculateRequiredPower(T, DefaultSettings:45)` – piecewise linear:

```
-5 → -2000 (always on), 48 → 0, 50 → 200, 53 → 1000, 55 → 2400, 57 → 3550
```

Interpolated (`calculateRequiredPower:142`) binary-search + linear; flat above `57` (`dy=1e6`). ~37.7 W/°C below `48`. At `T=40` `required ≈ -400`, at `50` `200`.

Base enable:

```
enable = power > required - (heaterOn ? 2496 : 0)   // hysteresis
avail  = power + (heaterOn ? 2496 : 0)              // for sun gate
```

### 4. Gates

**a) Legionella `control.ts:200-208`** – if `forced` → skip all sun/forecast gates, keep only hysteresis (so it will heat on grid at 02:00 if needed). Logged `LEGIONELLA forced`.

**b) Daily 40 °C `control.ts:210-215`** – `needs40 = T<40 && 6≤localHour≤10`. Then:

```
enable && (elev≥10 || avail>800 || |mid|<90)
```

Relaxed (`800` vs `2000`) so cold morning still heats with modest sun/power, but not at `elev 5°` night.

**c) Morning defer + normal `control.ts:216-225`** – otherwise:

- `shouldDeferMorning(forecast, at, T)` (`control.ts:261` mirrors `policy.ts:18`): `5≤UTChour≤9 && T<50 && remainingKWh > need+1` where `need=(50-T)*0.5 kWh` (≈150 L × 1 °C →0.5 kWh) and `remaining = Σ pv_estimate*hours` from `forecast` until `23:59 UTC` (`processor.ts:15`). If true → require `power > required + 400` (400 W margin – defers heating to midday peak when forecast says enough later).
- Then sun gate:

```
enable && (elev≥12 || avail>2000 || |mid|<120)
  elev = getSunElevationUTC(57,25)  sun.ts:2   // decl+EoT
  mid  = |minutesFromSolarMiddayUTC(25)| sun.ts:51 // solar noon ≈10:20 UTC at lon 25
```

`12°` keeps August 05Z `16°` open but earlier 04Z `8°` blocked; `120 min` allows winter noon even if low elev; `avail>2000` lets any time if >2 kW export (e.g., `heaterOn` adds `2496`).

**d) State machine `control.ts:239-257`** – `Undefined→Turning* → On/Off` etc., returns `State2Bool`.

### 5. HOUSE_BASE_W `power.ts:6` + `.env.sample:21`

```
estAvailable = forecastNowKw * 1000 - HOUSE_BASE_W
```

When Inﬂux is down we have only **PV generation forecast**, not surplus. House always draws base load (lights, fridge, router, pumps). Subtracting it estimates what would be `active_grid_B_power_W` if we measured.

- **Default `300` W** – average night-time `active_grid_B_power_W` without heater (negative = import). Look at Inﬂux `Boiler` `W_avail` at `elev<0` over a week, average ~250-400 W import.
- **Tuning:** set `HOUSE_BASE_W` to your measured base. Too high → under-estimates surplus → conservative (heats later). Too low → over-estimates → may try to heat on grid when WiFi down. Check logs `source=forecast:open-meteo` vs `influx` during outages.
- **Why not 0?** Using raw `pv_estimate` would assume all PV is surplus, heating even when house needs it (night baseline). Subtracting prevents false `avail` at dawn.
- **Fallback after that:** if `elev>15°` → `400 W` heuristic (`power.ts:45`), else `undefined` → no heat (except legionella).

### 6. Forecast `src/forecast/*`

- **Pluggable `ForecastProvider` (`types.ts:14`)** – `fetchForecast():Promise<Forecast>`. `openMeteoProvider.ts` default (free, no key) fetches per array `https://api.open-meteo.com/v1/forecast?latitude=57&longitude=25&hourly=global_tilted_irradiance&tilt&azimuth&forecast_days=3&timezone=UTC` and `pv_estimate = irradiance* kWp * PV_EFFICIENCY /1000` summed. `solcastProvider.ts` stub `GET /rooftop_sites/{id}/forecasts?format=json&api_key=` – same `Forecast` shape (`period_start/end`, `pv_estimate`).
- **Cache `cache.ts:15`** `SqliteForecastStore` `./data/heat.db` (auto `mkdir -p data`) tables `forecast(json,provider)` + `legionella(last_hot)`, `MemoryForecastStore` fallback. `load()` returns most recent; tests must `await close()`.
- **Scheduler `scheduler.ts:12`** polls `PROVIDER` every `FORECAST_INTERVAL_MS` (default 1 h, set `21600000` =6 h for Solcast 10/day). `GET /allow` never blocks on fetch – reads cache. `GET /forecast` debug.
- **Daily loop:** `index.ts:32-58` picks provider (`FORECAST_PROVIDER` or `solcast` if `SOLCAST_API_KEY` set else `open-meteo`), starts scheduler, on `/allow` does `powerService.getAvailablePower()` + `forecastStore.load()` + `legionella.needsForcedHeat()` → `GetStateWithForecast`.

---

## Configuration

`.env` (see `.env.sample:1`) – all on `smart`:

```
PORT,INFLUX_URL,INFLUX_TOKEN,ORG          # required – Inﬂux 3-min surplus
FORECAST_PROVIDER=open-meteo|solcast
PV_ARRAYS=[{"kWp":3,"tilt":35,"azimuth":-90},{"kWp":10,"tilt":45,"azimuth":0}]
PV_EFFICIENCY=0.85 LAT=57 LON=25
FORECAST_SQLITE=./data/heat.db
SOLCAST_API_KEY= SOLCAST_SITE_ID=         # if solcast
HOUSE_BASE_W=300
LEGIONELLA_TEMP=60 LEGIONELLA_INTERVAL_MS=604800000
FORECAST_INTERVAL_MS=3600000  # 6h for solcast
```

Panels optional – defaults to E+S above via `parsePvArrays()` (`types.ts:12`).

## Running

```sh
npm ci            # pulls sqlite3 native
npm test          # 10 suites 45 tests
npm run build && node dist/index.js   # or npm start / npm run dev
# Docker: docker build . -t valtss/heat-control; docker run --env-file ./.env -p 8005:8005 -v $PWD/data:/usr/src/app/data valtss/heat-control
```

`data/` is gitignored – mount as volume in prod. `GET /power`, `GET /allow?temp=&relay=`, `GET /forecast` for ops.

## Tuning August morning

Before: `elev 16°` at 05Z + `required 0` at `48C` → heated on `500W`. Now `shouldDeferMorning` raises to `required+400` when `remaining > need+1`, and daily `40C` gate is separate – keeps cold mornings hot but defers lukewarm to midday peak.
