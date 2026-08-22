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

// treat UTC as "local" for deterministic morning-window tests
const UTC: (d: Date) => number = (d) => d.getUTCHours();

describe('GetStateWithForecast – MPC decision', () => {
  beforeEach(() => {
    resetControlStateForTest();
    jest.spyOn(process.hrtime, 'bigint').mockReturnValue(BigInt(1_000_000_000_000));
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('legionella forced → heat regardless of power/sun (grid import)', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(-10);
    expect(
      GetStateWithForecast(-500, 52, false, null, true, new Date('2025-08-15T02:00:00Z'), UTC)
    ).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('morning cold (T<floor) → hard floor: always heat (may import)', () => {
    const fc = makeForecast([12, 12]);
    const at = new Date('2025-08-15T07:00:00Z'); // local 07 within 6-10 window
    expect(GetStateWithForecast(100, 35, false, fc, false, at, UTC)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('warm tank, no solar, no floor pressure → defer (no import)', () => {
    // tank 60 at local 15:00 (not morning; floor is ~15h away and tank is far above it)
    const fc = makeForecast([0, 1]);
    const at = new Date('2025-08-15T15:00:00Z'); // local 15, outside morning window
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(-10);
    expect(GetStateWithForecast(100, 60, false, fc, false, at, UTC)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('free live surplus + tank below target → soak it (0 import)', () => {
    const fc = makeForecast([12, 2]);
    const at = new Date('2025-08-15T12:00:00Z');
    // big surplus on the phase right now (>= heater) → heat for free
    expect(GetStateWithForecast(3000, 45, false, fc, false, at, UTC)).toBe(true);
  });

  it('crap day, warm-enough tank, afternoon → off (no all-day import)', () => {
    const fc = makeForecast([1, 1]); // ~0.3 boiler-phase kWh today
    const at = new Date('2025-08-15T14:00:00Z'); // local 14, not morning
    // tank at 50 > target-relative floor; no meaningful surplus → no import
    expect(GetStateWithForecast(100, 50, false, fc, false, at, UTC)).toBe(false);
  });

  it('stale forecast → sun-gate only, conservative', () => {
    const fc = makeForecast([12, 12], '2025-08-15T01:00:00Z'); // 11h stale
    const at = new Date('2025-08-15T12:00:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5); // sun low
    expect(GetStateWithForecast(100, 40, false, fc, false, at, UTC)).toBe(false);
    resetControlStateForTest();
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(20);
    expect(GetStateWithForecast(100, 40, false, fc, false, at, UTC)).toBe(true);
  });

  it('undefined power (wifi down): sun up → heat, sun down → off, forced → on', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    expect(
      GetStateWithForecast(undefined, 40, false, null, false, new Date('2025-08-15T12:00:00Z'), UTC)
    ).toBe(true);
    resetControlStateForTest();
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5);
    expect(
      GetStateWithForecast(undefined, 40, false, null, false, new Date('2025-08-15T02:00:00Z'), UTC)
    ).toBe(false);
    resetControlStateForTest();
    expect(
      GetStateWithForecast(undefined, 40, false, null, true, new Date('2025-08-15T02:00:00Z'), UTC)
    ).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('pluggable provider – same control works with any Forecast shape', () => {
    // solcast-shaped: a full sunny day today (high total-array), poor tomorrow
    const sunnyToday = 30;
    const poorTomorrow = 2;
    const base = new Date('2025-08-15T05:00:00Z');
    const entries = [];
    for (let d = 0; d < 2; d++) {
      const kWh = d === 0 ? sunnyToday : poorTomorrow;
      for (let h = 0; h < 24; h++) {
        const start = new Date(base.getTime() + d * 24 * 3600e3 + h * 3600e3);
        entries.push({
          period_start: start,
          period_end: new Date(start.getTime() + 3600e3),
          pv_estimate: kWh / 24,
        });
      }
    }
    const solcastLike: Forecast = {
      forecasts: entries,
      fetchedAt: new Date('2025-08-15T10:00:00Z'),
      provider: 'solcast',
    };
    const at = new Date('2025-08-15T10:15:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    // cold tank + sunny boiler-phase day → heat toward target
    expect(GetStateWithForecast(100, 25, false, solcastLike, false, at, UTC)).toBe(true);
  });
});
