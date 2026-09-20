import { TempFilter } from './tempFilter';

describe('TempFilter – DS1820 spike rejection + smoothing', () => {
  it('passes through the first reading', () => {
    const f = new TempFilter();
    expect(f.update(56.0)).toBe(56.0);
    expect(f.raw).toBe(56.0);
  });

  it('rejects a single >2C spike and keeps the previous filtered value', () => {
    const f = new TempFilter();
    f.update(56.0);
    // 0.3*56.2 + 0.7*56.0 = 56.06
    f.update(56.2);
    expect(f.value).toBeCloseTo(56.06, 2);
    // +6C spike in one poll – physically impossible for the tank, must be ignored
    expect(f.update(62.6)).toBeCloseTo(56.06, 2);
    expect(f.raw).toBe(62.6); // raw preserved for diagnostics
  });

  it('accepts genuine slow movement (<=2C) and smooths it with the EWMA', () => {
    const f = new TempFilter();
    f.update(56.0);
    f.update(56.5); // +0.5C – real drift, blend 0.3
    // filtered = 0.3*56.5 + 0.7*56.0 = 56.15
    expect(f.value).toBeCloseTo(56.15, 2);
  });

  it('recovers and follows real temperature after a spike is rejected', () => {
    const f = new TempFilter();
    f.update(56.0);
    f.update(56.3); // 0.3*56.3+0.7*56.0 = 56.09
    f.update(62.8); // spike – rejected, stays at 56.09
    expect(f.value).toBeCloseTo(56.09, 1);
    // now the real temp genuinely rises over several polls
    f.update(56.5);
    f.update(57.0);
    f.update(57.5);
    // filtered should have moved toward 57.5 (no longer stuck) – exact EWMA: 56.764
    expect(f.value).toBeCloseTo(56.764, 2);
    expect(f.value).toBeLessThan(57.6);
  });

  it('reset clears state', () => {
    const f = new TempFilter();
    f.update(60.0);
    f.reset();
    expect(f.value).toBeNull();
    expect(f.raw).toBeNull();
    expect(f.update(45.0)).toBe(45.0);
  });
});
