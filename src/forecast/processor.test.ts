import { Forecast } from './types';
import { ForecastProcessor } from './processor';

function makeForecast(entries: { start: string; end: string; pv: number }[]): Forecast {
  return {
    forecasts: entries.map((e) => ({
      period_start: new Date(e.start),
      period_end: new Date(e.end),
      pv_estimate: e.pv,
    })),
    fetchedAt: new Date('2025-08-15T00:00:00Z'),
    provider: 'test',
  };
}

describe('ForecastProcessor', () => {
  it('calcKWh sums above threshold', () => {
    const f = makeForecast([
      { start: '2025-08-15T10:00:00Z', end: '2025-08-15T11:00:00Z', pv: 5 },
      { start: '2025-08-15T11:00:00Z', end: '2025-08-15T12:00:00Z', pv: 3 },
    ]);
    // threshold 2kW: (5-2)*1h + (3-2)*1h = 4kWh
    expect(
      ForecastProcessor.calcKWh(
        f,
        new Date('2025-08-15T10:00:00Z'),
        new Date('2025-08-15T12:00:00Z'),
        2
      )
    ).toBeCloseTo(4);
  });

  it('calcKWh partial overlap', () => {
    const f = makeForecast([{ start: '2025-08-15T10:00:00Z', end: '2025-08-15T11:00:00Z', pv: 4 }]);
    // 10:30-11:00 overlap 0.5h * (4-1)=1.5
    expect(
      ForecastProcessor.calcKWh(
        f,
        new Date('2025-08-15T10:30:00Z'),
        new Date('2025-08-15T11:00:00Z'),
        1
      )
    ).toBeCloseTo(1.5);
  });

  it('estimatePower finds threshold for required kWh', () => {
    const f = makeForecast([{ start: '2025-08-15T10:00:00Z', end: '2025-08-15T14:00:00Z', pv: 5 }]);
    // 4h * (5 - thr) = 10 => thr=2.5
    const thr = ForecastProcessor.estimatePower(
      f,
      new Date('2025-08-15T10:00:00Z'),
      new Date('2025-08-15T14:00:00Z'),
      10
    );
    expect(thr).toBeCloseTo(2.5, 1);
  });

  it('calcNowKw picks current period', () => {
    const f = makeForecast([
      { start: '2025-08-15T10:00:00Z', end: '2025-08-15T11:00:00Z', pv: 7 },
      { start: '2025-08-15T11:00:00Z', end: '2025-08-15T12:00:00Z', pv: 3 },
    ]);
    expect(ForecastProcessor.calcNowKw(f, new Date('2025-08-15T10:30:00Z'))).toBe(7);
    expect(ForecastProcessor.calcNowKw(f, new Date('2025-08-15T11:30:00Z'))).toBe(3);
    expect(ForecastProcessor.calcNowKw(f, new Date('2025-08-15T12:30:00Z'))).toBe(0);
  });
});
