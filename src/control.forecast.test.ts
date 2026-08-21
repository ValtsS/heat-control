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

describe('GetStateWithForecast – tank horizon planner', () => {
  let hrtimeSpy: jest.SpyInstance;
  beforeEach(() => {
    resetControlStateForTest();
    hrtimeSpy = jest.spyOn(process.hrtime, 'bigint').mockReturnValue(BigInt(1_000_000_000_000));
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('morning, good day → defer (requiredNow low, tank warm enough)', () => {
    const fc = makeForecast([11, 11]); // good today + tomorrow
    const at = new Date('2025-08-15T07:00:00Z');
    // T=48, requiredNow well below 40 → no morning heat
    expect(GetStateWithForecast(500, 48, false, fc, false, at)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('morning, good day but tank cold (T<40) → 40C guarantee heats', () => {
    const fc = makeForecast([11, 11]);
    const at = new Date('2025-08-15T07:00:00Z');
    at.setHours(7); // local morning
    expect(GetStateWithForecast(900, 35, false, fc, false, at)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('late day, poor tomorrow → bank: heat at higher tank temp than good tomorrow', () => {
    const at = new Date('2025-08-15T18:00:00Z');
    const fcPoor = makeForecast([11, 2]); // tomorrow poor → bank to ~62
    resetControlStateForTest();
    // T=48 with poor tomorrow → requiredNow ~50 → heat
    expect(GetStateWithForecast(1000, 48, false, fcPoor, false, at)).toBe(true);
    const fcGood = makeForecast([11, 11]); // tomorrow good → target ~58
    resetControlStateForTest();
    // same T=48 with good tomorrow → requiredNow ~46 → no heat yet
    expect(GetStateWithForecast(1000, 48, false, fcGood, false, at)).toBe(false);
  });

  it('late day, little solar left → keep tank hot (requiredNow high)', () => {
    const fc = makeForecast([11, 11]);
    const at = new Date('2025-08-15T18:00:00Z');
    // requiredNow ~46; T=45 is below it → heat to hold through evening
    expect(GetStateWithForecast(1000, 45, false, fc, false, at)).toBe(true);
  });

  it('stale forecast → treated as no-data: sun-gate only, conservative', () => {
    const fc = makeForecast([11, 11], '2025-08-15T01:00:00Z'); // 11h stale
    const at = new Date('2025-08-15T12:00:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5); // sun low
    expect(GetStateWithForecast(1000, 40, false, fc, false, at)).toBe(false);
    resetControlStateForTest();
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(20);
    expect(GetStateWithForecast(1000, 40, false, fc, false, at)).toBe(true);
  });

  it('legionellaForced heats even at night with no power (grid import)', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(-10);
    const forecast = null;
    // 02Z night, grid importing (negative power), T cold → forced must override
    expect(
      GetStateWithForecast(-500, 52, false, forecast, true, new Date('2025-08-15T02:00:00Z'))
    ).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('undefined power (wifi down): sun up → heat, sun down → off, forced → on', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30); // sun up
    expect(
      GetStateWithForecast(undefined, 40, false, null, false, new Date('2025-08-15T12:00:00Z'))
    ).toBe(true);
    resetControlStateForTest();
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5); // sun down
    expect(
      GetStateWithForecast(undefined, 40, false, null, false, new Date('2025-08-15T02:00:00Z'))
    ).toBe(false);
    resetControlStateForTest();
    // forced overrides even in dark
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
    expect(GetStateWithForecast(1000, 40, false, solcastLike, false, at)).toBe(true);
  });
});
