//
import { getSunElevationUTC } from './sun';
import { planTank, defaultTankConfig } from './tank';
import { parseNum, parseIntVal } from './config';

const HEATER_WATTS_VAL = parseNum(process.env.HEATER_WATTS, 2496); // heater draw (env)
const LAT = parseNum(process.env.LAT, 57);
const LON = parseNum(process.env.LON, 25);
const MinElevDeg = parseNum(process.env.MIN_ELEV_DEG, 12); // offline sun gate (no forecast)
const HYSTERESIS_DEG = parseNum(process.env.HYSTERESIS_DEG, 1);
// daily hot-water guarantee (morning) – configurable
const MORNING_TEMP = parseNum(process.env.MORNING_TEMP, 40);
const MORNING_POOR_TEMP = parseNum(process.env.MORNING_POOR_TEMP, 45);
const MORNING_START_HOUR = parseIntVal(process.env.MORNING_START_HOUR, 6);
const MORNING_END_HOUR = parseIntVal(process.env.MORNING_END_HOUR, 10);
// below this much remaining solar today (total-array kWh) we don't chase the target –
// crap days heat to bare minimum only (morning floor + legionella), not all day
const MIN_SOLAR_TODAY_KWH = parseNum(process.env.MIN_SOLAR_TODAY_KWH, 5);

// generic forecast types – avoid circular import, use minimal shape
type ForecastForControl = {
  forecasts: { period_start: Date; period_end: Date; pv_estimate: number }[];
  provider: string;
  fetchedAt: Date;
} | null;

export enum PowerState {
  Undefined = '?',
  Off = '[-]',
  TurningOn = ' + ',
  On = '[+]',
  TurningOff = ' - ',
}

let currentState: PowerState = PowerState.Undefined;
let retainstateUntil: bigint = BigInt(0);
// 15 secods
const StabilizationTime = BigInt(1000000000 * 15);

export const HEATER_WATTS = HEATER_WATTS_VAL;

export function resetControlStateForTest(): void {
  currentState = PowerState.Undefined;
  retainstateUntil = BigInt(0);
}

export function getControlStateForTest(): PowerState {
  return currentState;
}

function State2Bool(state: PowerState): boolean {
  switch (state) {
    case PowerState.Off:
    case PowerState.TurningOff:
      return false;
    case PowerState.TurningOn:
    case PowerState.On:
      return true;
  }

  return false;
}

function setNewState(newState: PowerState) {
  currentState = newState;
  switch (newState) {
    case PowerState.TurningOff:
    case PowerState.TurningOn:
      retainstateUntil = process.hrtime.bigint() + StabilizationTime;
      break;
    default:
      retainstateUntil = process.hrtime.bigint();
  }
}

export function GetState(power: number, temperature: number, heaterOn: boolean): boolean {
  return GetStateWithForecast(power, temperature, heaterOn, null, false);
}

export function GetStateWithForecast(
  power: number | undefined,
  temperature: number,
  heaterOn: boolean,
  forecast: ForecastForControl,
  legionellaForced: boolean,
  at: Date = new Date()
): boolean {
  if (process.hrtime.bigint() < retainstateUntil) return State2Bool(currentState);

  const p = power ?? 0;
  const elevation = getSunElevationUTC(LAT, LON);
  let enableHeater: boolean;

  // 60C legionella override – force regardless of power/forecast/sun (draws grid)
  if (legionellaForced) {
    console.log(`LEGIONELLA forced actual=${p} elev=${elevation.toFixed(1)}`);
    enableHeater = true;
  } else {
    // tank horizon planner – prognosis of how hot we must be (banks for poor tomorrow)
    const plan = planTank(at, temperature, forecast as any, defaultTankConfig());

    const hourLocal = at.getHours();
    const morning = hourLocal >= MORNING_START_HOUR && hourLocal <= MORNING_END_HOUR;
    const poor = plan.bankDelta > 0; // tomorrow can't meet its own need (worse than today)
    const needsMorningFloor = temperature < MORNING_TEMP;
    const needsMorningPoor = temperature < MORNING_POOR_TEMP;

    if (morning && needsMorningFloor) {
      // hard daily floor: hot water every morning – may import
      enableHeater = true;
    } else if (morning && poor && needsMorningPoor) {
      // poor tomorrow → import in the morning (near use, minimal overnight loss) to bare minimum
      enableHeater = true;
    } else if (plan.stale) {
      // offline / no forecast → sun-elevation gate toward requiredNow
      enableHeater = elevation >= MinElevDeg && temperature < plan.requiredNow - HYSTERESIS_DEG;
    } else if (poor && plan.bankable) {
      // tomorrow worse AND today has surplus solar to bank with → heat toward requiredNow
      enableHeater = temperature < plan.requiredNow - HYSTERESIS_DEG;
    } else if (plan.solarToday >= MIN_SOLAR_TODAY_KWH) {
      // decent day: use the solar we generate rather than export – heat toward no-bank target
      enableHeater = temperature < plan.requiredNoBank - HYSTERESIS_DEG;
    } else {
      // crap day / no meaningful solar: don't chase target all day – bare minimum only
      enableHeater = false;
    }
  }

  console.log(
    `actual=${p} currentTState=${currentState} enableHeater = ${enableHeater} Elevation = ${elevation.toFixed(
      1
    )} legionella=${legionellaForced} forecast=${forecast?.provider ?? 'none'}`
  );

  switch (currentState) {
    case PowerState.Undefined:
      setNewState(enableHeater ? PowerState.TurningOn : PowerState.TurningOff);
      break;
    case PowerState.Off:
      if (enableHeater) setNewState(PowerState.TurningOn);
      break;
    case PowerState.On:
      if (!enableHeater) setNewState(PowerState.TurningOff);
      break;
    case PowerState.TurningOn:
      setNewState(PowerState.On);
      break;
    case PowerState.TurningOff:
      setNewState(PowerState.Off);
      break;
  }

  return State2Bool(currentState);
}
