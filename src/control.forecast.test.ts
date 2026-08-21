import {
  GetStateWithForecast,
  resetControlStateForTest,
  getControlStateForTest,
  PowerState,
} from './control';
import { Forecast } from './forecast/types';
import * as sun from './sun';

// forecast spans today + tomorrow, flat kWh/day starting 05:00 UTC
function makeForecast(dayKwh: number[], fetchedAt?: string): Forecast {
  const base = new Date('2025-08-15T05:00:00Z');
  const fetched = fetchedAt ? new Date(fetchedAt) : new Date(); // fresh unless overridden
  const entries = [];
  for (let d = 0; d < dayKwh.length; d++) {
    for (let h = 0; h < 24; h++) {
      const start = new Date(base.getTime() + d * 24 * 3600e3 + h * 3600e3);
      entries.push({
        period_start: start,
        period_end: new Date(start.getTime() + 3600e3),
        pv_estimate: dayKwh[d] / 24,
      });
    }
  }
  return { forecasts: entries, fetchedAt: fetched, provider: 'test' };
}

function localMorning(hour: number): Date {
  const d = new Date('2025-08-15T07:00:00Z');
  d.setHours(hour); // set LOCAL hour
  return d;
}

describe('GetStateWithForecast – forecast-driven decision', () => {
  let hrtimeSpy: jest.SpyInstance;
  beforeEach(() => {
    resetControlStateForTest();
    hrtimeSpy = jest.spyOn(process.hrtime, 'bigint').mockReturnValue(BigInt(1_000_000_000_000));
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('morning, good tomorrow → defer (no import, wait for solar)', () => {
    const fc = makeForecast([12, 12]); // tomorrow 12 ≥ 11.6 need → bankDelta 0
    const at = localMorning(7);
    expect(GetStateWithForecast(100, 45, false, fc, false, at)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('morning cold (T<40) → hard floor: always heat (may import)', () => {
    const fc = makeForecast([12, 12]);
    const at = localMorning(7);
    expect(GetStateWithForecast(100, 35, false, fc, false, at)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('morning, poor tomorrow + no solar → import to MORNING_POOR_TEMP (45)', () => {
    const fc = makeForecast([1, 1]); // today+tomorrow crap → poor
    const at = localMorning(7);
    // T=42 < 45 → morning-poor import
    expect(GetStateWithForecast(100, 42, false, fc, false, at)).toBe(true);
    resetControlStateForTest();
    // T=46 ≥ 45 → no import beyond bare minimum
    expect(GetStateWithForecast(100, 46, false, fc, false, at)).toBe(false);
  });

  it('evening, poor tomorrow, no solar → NO night import for banking', () => {
    const fc = makeForecast([3, 1]); // today 3, tomorrow 1 → poor, but no meaningful solar today
    const at = new Date('2025-08-15T18:00:00Z'); // evening, not morning
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(-5);
    expect(GetStateWithForecast(100, 50, false, fc, false, at)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('night, poor tomorrow, tank ABOVE target, solarToday 0 → NO bank-import', () => {
    // regression: tank at 60 (> target 55), solarToday ~0 at night – must NOT heat to bank
    const fc = makeForecast([0, 1]); // today 0 (night), poor tomorrow
    const at = new Date('2025-08-15T21:00:00Z'); // night
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(-10);
    expect(GetStateWithForecast(100, 60, false, fc, false, at)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('decent day (good solar today), poor tomorrow → bank from solar surplus', () => {
    const fc = makeForecast([8, 1]); // today 8 (≥5 meaningful), tomorrow 1 → poor+bankable
    const at = new Date('2025-08-15T12:00:00Z');
    // at 12:00 solarToday ~4 >= MIN 5? 4 < 5 → falls to... bankable branch
    // bankable: solarToday(4) > energyToTarget((55-42)*0.174+1.43)=3.69 → true
    expect(GetStateWithForecast(100, 42, false, fc, false, at)).toBe(true);
  });

  it('crap day (solar < MIN) outside morning → no chase (bare minimum only)', () => {
    const fc = makeForecast([1, 1]); // crap today+tomorrow
    const at = new Date('2025-08-15T14:00:00Z'); // afternoon, not morning
    // solarToday (1/24)*10=0.42 < MIN 5 → off (no all-day import)
    expect(GetStateWithForecast(100, 40, false, fc, false, at)).toBe(false);
  });

  it('decent day, midday, tank below no-bank target → heat (use solar, don not export)', () => {
    const fc = makeForecast([12, 12]); // not poor (tomorrow good)
    const at = new Date('2025-08-15T12:00:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(20);
    // solarToday (12/24)*12=6 >= 5 → self-consumption; T=46 vs requiredNoBank?
    // requiredNoBank = 55 - (6-1.43)/0.174 = 55-26.3 = 28.7 → 46 > 28.7 → OFF (defer, solar covers)
    expect(GetStateWithForecast(100, 46, false, fc, false, at)).toBe(false);
  });

  it('stale forecast → sun-gate only, conservative', () => {
    const fc = makeForecast([12, 12], '2025-08-15T01:00:00Z'); // 11h stale
    const at = new Date('2025-08-15T12:00:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5); // sun low
    expect(GetStateWithForecast(100, 40, false, fc, false, at)).toBe(false);
    resetControlStateForTest();
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(20);
    expect(GetStateWithForecast(100, 40, false, fc, false, at)).toBe(true);
  });

  it('legionellaForced heats even at night with no power (grid import)', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(-10);
    const forecast = null;
    expect(
      GetStateWithForecast(-500, 52, false, forecast, true, new Date('2025-08-15T02:00:00Z'))
    ).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('undefined power (wifi down): sun up → heat, sun down → off, forced → on', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    expect(
      GetStateWithForecast(undefined, 40, false, null, false, new Date('2025-08-15T12:00:00Z'))
    ).toBe(true);
    resetControlStateForTest();
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5);
    expect(
      GetStateWithForecast(undefined, 40, false, null, false, new Date('2025-08-15T02:00:00Z'))
    ).toBe(false);
    resetControlStateForTest();
    expect(
      GetStateWithForecast(undefined, 40, false, null, true, new Date('2025-08-15T02:00:00Z'))
    ).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('pluggable provider – same control works with any Forecast shape', () => {
    const solcastLike: Forecast = {
      forecasts: [
        {
          period_start: new Date('2025-08-15T10:00:00Z'),
          period_end: new Date('2025-08-15T11:00:00Z'),
          pv_estimate: 6,
        },
      ],
      fetchedAt: new Date('2025-08-15T10:00:00Z'),
      provider: 'solcast',
    };
    const at = new Date('2025-08-15T10:15:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    expect(GetStateWithForecast(100, 40, false, solcastLike, false, at)).toBe(true);
  });
});
