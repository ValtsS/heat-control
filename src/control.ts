//
import { getSunElevationUTC, minutesFromSolarMiddayUTC } from './sun';

const HEATER_Watts = 2400 * 1.04; // intentionally lower to have hysteresis
// If available power is this = always on

const LON = 25;
const LAT = 57;
const MinElevDeg = 12;
const MinutesToMidday = 120;

// generic forecast types – avoid circular import, use minimal shape
type ForecastForControl = {
  forecasts: { period_start: Date; period_end: Date; pv_estimate: number }[];
  provider: string;
} | null;

export type ControlData = {
  temperature: number;
  requiredpower: number;
};

/*
export const DefaultSettings: ControlData[] = [
  {
    temperature: -5.0,
    requiredpower: -2000,
  },
  {
    temperature: 39.0,
    requiredpower: 0,
  },
  {
    temperature: 45.0,
    requiredpower: 2400,
  },
  {
    temperature: 55.0,
    requiredpower: 2500,
  },
];

*/

export const DefaultSettings: ControlData[] = [
  {
    temperature: -5.0,
    requiredpower: -2000,
  },
  {
    temperature: 48.0,
    requiredpower: 0,
  },
  {
    temperature: 50.0,
    requiredpower: 200,
  },
  {
    temperature: 53.0,
    requiredpower: 1000,
  },
  {
    temperature: 55.0,
    requiredpower: 2400,
  },
  {
    temperature: 57.0,
    requiredpower: 3550,
  },
];

/*

export const DefaultSettings: ControlData[] = [
  {
    temperature: -5.0,
    requiredpower: -2000,
  },
  {
    temperature: 39.0,
    requiredpower: 0,
  },
  {
    temperature: 42.0,
    requiredpower: 1250,
  },
  {
    temperature: 45.0,
    requiredpower: 2000,
  },
  {
    temperature: 50.0,
    requiredpower: 2400,
  },
  {
    temperature: 55.0,
    requiredpower: 3550,
  },
];


*/

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
export const SUN_CONFIG = { LAT, LON, MinElevDeg, MinutesToMidday };

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

export function calculateRequiredPower(temperature: number, settings: ControlData[]): number {
  let l = 0;
  let r = settings.length;

  while (l < r) {
    let m = Math.trunc(l + (r - l) / 2);

    if (settings[m].temperature >= temperature) r = m;
    else l = m + 1;
  }

  if (l > 0) l--;

  const minpwr = settings[l].requiredpower;
  const minT = settings[l].temperature;

  const dx = settings[l + 1 == settings.length ? l : l + 1].requiredpower - minpwr;
  const dy = (l + 1 == settings.length ? 1e6 : settings[l + 1].temperature) - minT;

  const dT = (temperature - minT) / dy;
  return settings[l].requiredpower + dT * dx;
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
  const requiredpower = calculateRequiredPower(temperature, DefaultSettings);
  let enableHeater = p > requiredpower - (heaterOn ? HEATER_Watts : 0);

  const elevation = getSunElevationUTC(LAT, LON);
  const minutesToMidDay = Math.abs(minutesFromSolarMiddayUTC(LON));
  const avail = p + (heaterOn ? HEATER_Watts : 0);

  // 60C legionella override – ignore sun/forecast, but still need power check
  if (legionellaForced) {
    // force heating if we need 60C, even at night, but keep hysteresis
    console.log(
      `LEGIONELLA forced avail=${avail} actual=${p} required=${Math.round(
        requiredpower
      )} elev=${elevation.toFixed(1)} mid=${minutesToMidDay.toFixed(0)}`
    );
    // no sun gate when forced
  } else {
    // daily 40C guarantee: if cold morning, relax avail threshold
    const hourLocal = at.getHours();
    const needs40 = temperature < 40 && hourLocal >= 6 && hourLocal <= 10;
    if (needs40) {
      // allow earlier heating with lower avail, but still need sun or some power
      enableHeater = enableHeater && (elevation >= 10 || avail > 800 || minutesToMidDay < 90);
    } else {
      // morning defer: if forecast says enough later, require higher power now
      const shouldDefer = shouldDeferMorning(forecast, at, temperature);
      if (shouldDefer) {
        // require extra 400W margin
        enableHeater = p > requiredpower + 400 - (heaterOn ? HEATER_Watts : 0);
      }
      enableHeater =
        enableHeater &&
        (elevation >= MinElevDeg || avail > 2000 || minutesToMidDay < MinutesToMidday);
    }
  }

  console.log(
    `Avail power  = ${avail}  actual = ${p} requiredpower = ${Math.round(
      requiredpower
    )} currentTState=${currentState} enableHeater = ${enableHeater} Elevation = ${elevation.toFixed(
      1
    )} MinElev = ${MinElevDeg} MinutesToMidday = ${minutesToMidDay.toFixed(
      0
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

// extracted for testability – mirrors policy.ts but without circular import
function shouldDeferMorning(forecast: ForecastForControl, at: Date, tempNow: number): boolean {
  if (!forecast) return false;
  const hour = at.getUTCHours();
  if (hour < 5 || hour > 9) return false;
  if (tempNow >= 50) return false;
  // need ~0.5kWh per degree to reach 50C
  const needKWh = tempNow < 50 ? (50 - tempNow) * 0.5 : 0;
  const untilEnd = new Date(at);
  untilEnd.setUTCHours(23, 59, 59, 999);
  let remaining = 0;
  for (const f of forecast.forecasts) {
    const overlap = Math.max(
      0,
      Math.min(f.period_end.getTime(), untilEnd.getTime()) -
        Math.max(f.period_start.getTime(), at.getTime())
    );
    const hours = overlap / (1000 * 3600);
    remaining += Math.max(0, f.pv_estimate) * hours;
  }
  return remaining > needKWh + 1;
}
