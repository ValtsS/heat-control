//
import { getSunElevationUTC } from './sun';

const HEATER_Watts = 2400 * 1.04; // intentionally lower to have hysteresis
// If available power is this = always on

const LON = 25;
const LAT = 57;
const MinElevDeg = 12;

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
    temperature: 50.0,
    requiredpower: 0,
  },
  {
    temperature: 52.0,
    requiredpower: 1250,
  },
  {
    temperature: 53.0,
    requiredpower: 2000,
  },
  {
    temperature: 54.0,
    requiredpower: 2400,
  },
  {
    temperature: 55.0,
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
  if (process.hrtime.bigint() < retainstateUntil) return State2Bool(currentState);

  const requiredpower = calculateRequiredPower(temperature, DefaultSettings);
  let enableHeater = power > requiredpower - (heaterOn ? HEATER_Watts : 0);

  const elevation = getSunElevationUTC(LAT,LON);

  enableHeater = enableHeater && ((elevation >= MinElevDeg) || (power + (heaterOn ? HEATER_Watts : 0)) > 2000 );

  console.log(
    `Avail power  = ${
      power + (heaterOn ? HEATER_Watts : 0)
    }  actual = ${power} requiredpower = ${Math.round(
      requiredpower
    )} currentTState=${currentState} enableHeater = ${enableHeater} Elevation = ${elevation} MinElev = ${MinElevDeg}`
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
