import { getSunElevationUTC, minutesFromSolarMiddayUTC } from './sun';

describe('sun – dumb branch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function setDateUTC(iso: string) {
    jest.setSystemTime(new Date(iso));
    return new Date(iso);
  }

  it('elevation is non-negative near noon in summer at LAT 57 LON 25', () => {
    // 2025-06-21 ~ summer solstice, noon UTC = ~13:40 solar due to LON 25 (+1:40) => elevation high
    setDateUTC('2025-06-21T12:00:00.000Z');
    const el = getSunElevationUTC(57, 25);
    // at 57N solstice max ~56°, at noon even with EoT should be >50
    expect(el).toBeGreaterThan(45);
    expect(el).toBeLessThan(70);
  });

  it('elevation is negative at midnight in winter', () => {
    setDateUTC('2025-12-21T00:00:00.000Z');
    const el = getSunElevationUTC(57, 25);
    expect(el).toBeLessThan(0);
  });

  it('minutesFromSolarMidday ~0 near solar noon', () => {
    // solar noon at lon 25 is around 10:20 UTC (12 - lon/15 = 10:20) minus EoT (~16 min on Nov 5)
    setDateUTC('2025-11-05T10:20:00.000Z');
    const m = minutesFromSolarMiddayUTC(25);
    expect(Math.abs(m)).toBeLessThan(25);
  });

  it('midnight is far from midday (~±720 min)', () => {
    setDateUTC('2025-06-21T00:00:00.000Z');
    const m = Math.abs(minutesFromSolarMiddayUTC(25));
    expect(m).toBeGreaterThan(500);
  });

  it('elevation respects Date mock, not system clock', () => {
    setDateUTC('2025-06-21T12:00:00.000Z');
    const elNoon = getSunElevationUTC(57, 25);
    setDateUTC('2025-06-21T00:00:00.000Z');
    const elMidnight = getSunElevationUTC(57, 25);
    expect(elNoon).toBeGreaterThan(elMidnight);
  });
});
