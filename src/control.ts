//

const HEATER_Watts = 2400;
// If available power is this = always on

export type ControlData = {
  temperature: number;
  requiredpower: number;
};

export const DefaultSettings: ControlData[] = [
  {
    temperature: -5.0,
    requiredpower: -2000,
  },
  {
    temperature: 42.0,
    requiredpower: 0,
  },
  {
    temperature: 45.0,
    requiredpower: 1000,
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

export enum PowerState {
  Undefined,
  Off,
  TurningOn,
  On,
  TurningOff,
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
  var l = 0;
  var r = settings.length;

  while (l < r) {
    var m = Math.trunc(l + (r - l) / 2);

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
  const newTarget = power > requiredpower - (heaterOn ? HEATER_Watts : 0);

  console.log(
    `Avail power  = ${
      power + (heaterOn ? HEATER_Watts : 0)
    }  actual = ${power} requiredpower = ${requiredpower} currentTState=${currentState} target=${newTarget} required`
  );

  switch (currentState) {
    case PowerState.Undefined:
      setNewState(newTarget ? PowerState.TurningOn : PowerState.TurningOff);
      break;
    case PowerState.Off:
      if (newTarget) setNewState(PowerState.TurningOn);
      break;
    case PowerState.On:
      if (!newTarget) setNewState(PowerState.TurningOff);
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
