//
import { getSunElevationUTC } from './sun';
import { planTank, defaultTankConfig } from './tank';
import { planSchedule, defaultPlannerConfig, SchedulePlan } from './energy/planner';
import { parseNum } from './config';

const HEATER_WATTS_VAL = parseNum(process.env.HEATER_WATTS, 2496); // heater draw (env)
const LAT = parseNum(process.env.LAT, 57);
const LON = parseNum(process.env.LON, 25);
const MinElevDeg = parseNum(process.env.MIN_ELEV_DEG, 12); // offline sun gate (no forecast)
const HYSTERESIS_DEG = parseNum(process.env.HYSTERESIS_DEG, 1);

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

let lastPlan: SchedulePlan | null = null;

export function resetControlStateForTest(): void {
  currentState = PowerState.Undefined;
  retainstateUntil = BigInt(0);
  lastPlan = null;
}

export function getControlStateForTest(): PowerState {
  return currentState;
}

export function getLastPlanForTest(): SchedulePlan | null {
  return lastPlan;
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
  at: Date = new Date(),
  getLocalHour: (d: Date) => number = (d) => d.getHours()
): boolean {
  if (process.hrtime.bigint() < retainstateUntil) return State2Bool(currentState);

  const p = power ?? 0;
  const elevation = getSunElevationUTC(LAT, LON);
  let enableHeater: boolean;

  // 60C legionella override – force regardless of power/forecast/sun (draws grid)
  if (legionellaForced) {
    console.log(`LEGIONELLA forced actual=${p} elev=${elevation.toFixed(1)}`);
    enableHeater = true;
    lastPlan = null;
  } else {
    const plan = planSchedule(
      at,
      temperature,
      p / 1000,
      forecast,
      false,
      defaultPlannerConfig(),
      getLocalHour
    );
    lastPlan = plan;

    if (plan.reason === 'no-forecast') {
      // offline / no forecast → tank horizon planner + sun-elevation gate
      const tp = planTank(at, temperature, forecast, defaultTankConfig());
      enableHeater = elevation >= MinElevDeg && temperature < tp.requiredNow - HYSTERESIS_DEG;
    } else {
      enableHeater = plan.heat;
    }
  }

  console.log(
    `actual=${p} currentTState=${currentState} enableHeater = ${enableHeater} reason=${
      lastPlan?.reason ?? (legionellaForced ? 'legionella' : 'none')
    } elev=${elevation.toFixed(1)} forecast=${forecast?.provider ?? 'none'}`
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
