import { getSunElevationUTC } from './sun';

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

  it('elevation respects Date mock, not system clock', () => {
    setDateUTC('2025-06-21T12:00:00.000Z');
    const elNoon = getSunElevationUTC(57, 25);
    setDateUTC('2025-06-21T00:00:00.000Z');
    const elMidnight = getSunElevationUTC(57, 25);
    expect(elNoon).toBeGreaterThan(elMidnight);
  });
});
