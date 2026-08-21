//
import { getSunElevationUTC } from './sun';
import { planTank, defaultTankConfig } from './tank';

const HEATER_Watts = 2400 * 1.04; // intentionally lower to have hysteresis
const LAT = 57;
const LON = 25;
const MinElevDeg = 12; // offline solar gate (no forecast available)
const HYSTERESIS_DEG = parseFloat(process.env.HYSTERESIS_DEG ?? '1');

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

export const HEATER_WATTS = HEATER_Watts;

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

  // handle undefined power (wifi down) – use estimated 0 here; caller should pass estimated value via power
  const p = power ?? 0;
  const avail = p + (heaterOn ? HEATER_Watts : 0);
  const elevation = getSunElevationUTC(LAT, LON);
  let enableHeater: boolean;

  // 60C legionella override – force regardless of power/forecast/sun (draws grid)
  if (legionellaForced) {
    console.log(`LEGIONELLA forced avail=${avail} actual=${p} elev=${elevation.toFixed(1)}`);
    enableHeater = true;
  } else {
    // tank horizon planner – how hot we need to be now to hit end-of-day target
    // (banks extra when tomorrow's solar is poor). Stale forecast → treated as no-data.
    const plan = planTank(at, temperature, forecast as any, defaultTankConfig());

    // solar gate: fresh forecast → heat only if energy still coming today (handles clouds);
    // stale/missing forecast → fall back to raw sun elevation
    const solarOk = plan.stale ? elevation >= MinElevDeg : plan.solarToday > 0;

    // daily 40C guarantee: cold morning must heat (hot water every day) – hard override
    const hourLocal = at.getHours();
    const needs40 = temperature < 40 && hourLocal >= 6 && hourLocal <= 10;

    if (needs40) {
      enableHeater = solarOk || avail > 800;
    } else {
      enableHeater = temperature < plan.requiredNow - HYSTERESIS_DEG && solarOk;
    }
  }

  console.log(
    `Avail power  = ${avail}  actual = ${p} currentTState=${currentState} enableHeater = ${enableHeater} Elevation = ${elevation.toFixed(
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
