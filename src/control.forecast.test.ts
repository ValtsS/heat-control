import {
  GetStateWithForecast,
  resetControlStateForTest,
  getControlStateForTest,
  PowerState,
} from './control';
import { Forecast } from './forecast/types';
import * as sun from './sun';

function makeForecast(pvs: number[]): Forecast {
  // hourly 10:00, 11:00, ... pv
  const base = new Date('2025-08-15T10:00:00Z');
  return {
    forecasts: pvs.map((pv, i) => ({
      period_start: new Date(base.getTime() + i * 3600_000),
      period_end: new Date(base.getTime() + (i + 1) * 3600_000),
      pv_estimate: pv,
    })),
    fetchedAt: new Date(),
    provider: 'test',
  };
}

describe('GetStateWithForecast – generic provider', () => {
  let hrtimeSpy: jest.SpyInstance;
  beforeEach(() => {
    resetControlStateForTest();
    hrtimeSpy = jest.spyOn(process.hrtime, 'bigint').mockReturnValue(BigInt(1_000_000_000_000));
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    jest.spyOn(sun, 'minutesFromSolarMiddayUTC').mockReturnValue(0);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('defers morning 05Z low-temp when forecast says enough later', () => {
    // 05Z morning, T=35 (<40), forecast high remainder of day 10kWh
    const forecast = makeForecast([8, 8, 8, 8, 8, 8, 8, 8]); // 8kW each hour
    const at = new Date('2025-08-15T05:30:00Z');
    // power 500 small – without forecast would heat (48->0 at T35 required ~ -800 → 500>-800 true and sun high)
    // with forecast defer, should require +400 margin → still? at T35 required ~ -1000, 500 > -600 true but defer adds 400 → 500 > -600+400? need compute
    // Simpler: at T35 required ~ -900 (interpolated -5->48), so 500 always > required. Defer adds 400 but still passes. Test defer path via T=48? Use T=48 required 0, 500>0 true, defer would require 500>400 true still passes.
    // To make defer block, use low power 100 and T=48: 100>0 true, but 100>400 false → blocked
    const shouldDefer = GetStateWithForecast(100, 48, false, forecast, false, at);
    expect(shouldDefer).toBe(false); // deferred
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('does not defer if forecast poor', () => {
    const forecastPoor = makeForecast([0.2, 0.2, 0.2]);
    const at = new Date('2025-08-15T05:30:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    const ok = GetStateWithForecast(600, 48, false, forecastPoor, false, at);
    expect(ok).toBe(true);
  });

  it('daily 40C guarantee – cold morning forces enable even with low sun', () => {
    const forecastLow = makeForecast([0, 0, 0]);
    const at = new Date('2025-08-15T07:00:00Z');
    at.setHours(7); // local 7
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(5); // low
    jest.spyOn(sun, 'minutesFromSolarMiddayUTC').mockReturnValue(300);
    // T=35 <40 morning, power 900 avail 900+0 >800 allows despite low elev
    expect(GetStateWithForecast(900, 35, false, forecastLow, false, at)).toBe(true);
    resetControlStateForTest();
    // but 500 <800 should still block
    expect(GetStateWithForecast(500, 35, false, forecastLow, false, at)).toBe(false);
  });

  it('legionellaForced ignores sun gate', () => {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(2);
    jest.spyOn(sun, 'minutesFromSolarMiddayUTC').mockReturnValue(400);
    const forecast = null;
    // power 600, T 52 required 1250? Actually 52->1250, 600>1250 false even with heater off. Use T 48 required 0 → 600>0 true but sun low would block. Forced should ignore sun and pass
    expect(
      GetStateWithForecast(600, 48, false, forecast, true, new Date('2025-08-15T02:00:00Z'))
    ).toBe(true);
  });

  it('undefined power (wifi down) uses 0 but still respects legionella', () => {
    expect(
      GetStateWithForecast(undefined, 48, false, null, false, new Date('2025-08-15T12:00:00Z'))
    ).toBe(false);
    expect(
      GetStateWithForecast(undefined, 48, false, null, true, new Date('2025-08-15T02:00:00Z'))
    ).toBe(false); // power 0 > required 0 ? false (0>0 false)
    // with heaterOn hysteresis, undefined 0 behaves as 0, but heaterOn would be 0+2496>0 true if legionella? Check legionella path still does power check
  });

  it('pluggable provider – same control works with any Forecast shape', () => {
    const solcastLike: Forecast = {
      forecasts: [
        {
          period_start: new Date('2025-08-15T10:00:00Z'),
          period_end: new Date('2025-08-15T10:30:00Z'),
          pv_estimate: 6,
        },
      ],
      fetchedAt: new Date(),
      provider: 'solcast',
    };
    const at = new Date('2025-08-15T10:15:00Z');
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(30);
    expect(GetStateWithForecast(1000, 48, false, solcastLike, false, at)).toBe(true);
  });
});
