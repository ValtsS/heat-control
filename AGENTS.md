# AGENTS.md – `dumb` branch

## Stack & Layout (dumb vs master)

- `dumb` branch is active (`git checkout dumb`). Diff vs `master`: **no** `src/solcast/` logic, **no** `src/db/` – instead `src/sun.ts:1` real solar math + `src/control.ts` solar gate. `src/solcast/solcast.ts` is empty stub.
- Entrypoint `src/index.ts:44` `GET /allow?temp=&relay=` → `GetState(power??0, T, heatIsOn)`. `src/fluxClient.ts:3` bucket `solar` (`active_grid_B_power_W`) + `Boiler` writes.
- `src/control.ts:40-67` `DefaultSettings` dumb curve: `-5→-2000, 48→0, 50→200, 53→1000, 55→2400, 57→3550` (less aggressive than master `50→0,52→1250,53→2000…`). `src/sun.ts:1-81` computes `getSunElevationUTC`/`minutesFromSolarMiddayUTC` via declination+EoT approximations.

## Setup

- `npm ci` required (`node_modules/` not in repo). Node `19` in `Dockerfile`, local `v24` ok but use `./node_modules/.bin/*`.
- Env `.env` (gitignored, see `.env.sample`): `PORT`, `INFLUX_URL`, `INFLUX_TOKEN`, `ORG` all required `src/index.ts:17-21`.

## Commands (use local bins)

- `npm run build` → `dist/` (`tsconfig: module NodeNext, target es2016, strict`).
- `npm start` → `node dist/index.js` (build first).
- `npm run dev` → `concurrently "npx tsc --watch" "nodemon -q dist/index.js"`.
- `npm test` → `cross-env BABEL_ENV=test NODE_ENV=test jest` (via `babel-jest`). Single: `npm test -- src/control.getState.test.ts`.
- Lint/format: `npm run lint` (`eslint@8.47.0` legacy `.eslintrc.json`) / `npm run format` (`prettier` `singleQuote, printWidth 100`).
- Docker: `sh builddocker.sh` / `sh startdocker.sh` (`-p 8005:8005 --env-file ./.env`).

## Control Gotchas (`src/control.ts:110-201`)

- Stateful globals `currentState:110`, `retainstateUntil:111`, `StabilizationTime:113` `15s` via `process.hrtime.bigint()`. `GetState:164` short-circuits while `< retainstateUntil` (no re-eval, no log). `TurningOn/TurningOff` lock 15s, `On/Off` set to `now` (immediate). Transition `TurningOn→On` and `TurningOff→Off` is **unconditional** next non-gated call.
- `HEATER_Watts:4` `2496` hysteresis: `power > required - (heaterOn?2496:0)` (`control.ts:167`). Test hook `HEATER_WATTS` exported.
- Solar gate `control.ts:173`: `enable && (elevation>=12 || avail>2000 || |minutesToMidday|<120)` where `avail=power+(heaterOn?2496:0)`, `elevation=getSunElevationUTC(LAT 57, LON 25)`, `minutesToMidday=|minutesFromSolarMiddayUTC(25)|`. Low sun blocked unless near noon or high power. `DefaultSettings` interpolation `calculateRequiredPower:128` binary-search + linear, flat above `57` (`dy=1e6, dx=0`), slope below `-5` `≈37.7/°C`.
- Test hooks `resetControlStateForTest:115`, `getControlStateForTest:118`, `SUN_CONFIG` exported – use `jest.spyOn(process.hrtime,'bigint')` + `jest.spyOn(sun,'getSunElevationUTC')` (not `Date` hours as in master).
- `T=parseFloat(req.query.temp)` can be `NaN` → `required=NaN` → `enable=false`.

## Sun Math (`src/sun.ts`)

- Both functions read `new Date()` each call, compute `N` fractional day-of-year, `decl=23.44*sin(2π(284+N)/365)`, `EoT=9.87 sin2B -7.53 cosB -1.5 sinB` where `B=2π(N-81)/364`, then `solarTime=utcHours+lon/15+EoT/60`. Elevation uses `sinEl=sin(lat)sin(dec)+cos(lat)cos(dec)cos(H)`. No `suncalc` lib used despite `package.json: suncalc`.
- Mocking: must replace `global.Date` or spy `sun.getSunElevationUTC` – `getUTCHours` spy alone insufficient (unlike master `isSunUp`).

## Testing

- `src/control.test.ts:26` only covers `calculateRequiredPower` generic settings. New suite `control.calculateRequiredPower.test.ts:1` exact dumb points + `control.getState.test.ts:12` 10 cases (hysteresis, 3 solar bypasses, stabilization) + `sun.test.ts:1` 5 cases – all pass with `jest.spyOn` mocks; run `npm test` (21 tests).
- Stabilization tests must use absolute `base + ms` offsets, not `nowNs+ms` accumulation (caused 3s drift that flipped `TurningOff`→`Off`).
