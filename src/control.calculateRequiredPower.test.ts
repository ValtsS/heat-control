import { calculateRequiredPower, DefaultSettings } from './control';

describe('calculateRequiredPower – dumb DefaultSettings', () => {
  it('returns exact points of dumb curve', () => {
    expect(calculateRequiredPower(-5, DefaultSettings)).toBeCloseTo(-2000);
    expect(calculateRequiredPower(48, DefaultSettings)).toBeCloseTo(0);
    expect(calculateRequiredPower(50, DefaultSettings)).toBeCloseTo(200);
    expect(calculateRequiredPower(53, DefaultSettings)).toBeCloseTo(1000);
    expect(calculateRequiredPower(55, DefaultSettings)).toBeCloseTo(2400);
    expect(calculateRequiredPower(57, DefaultSettings)).toBeCloseTo(3550);
  });

  it('interpolates linearly inside segments', () => {
    // 48→50 : 0→200, midpoint 49 = 100
    expect(calculateRequiredPower(49, DefaultSettings)).toBeCloseTo(100);
    // 50→53 : 200→1000, midpoint 51.5 = 600
    expect(calculateRequiredPower(51.5, DefaultSettings)).toBeCloseTo(600);
    // 55→57 : 2400→3550, midpoint 56 = 2975
    expect(calculateRequiredPower(56, DefaultSettings)).toBeCloseTo(2975);
  });

  it('extrapolates flat above last point (57 → 3550)', () => {
    expect(calculateRequiredPower(57, DefaultSettings)).toBeCloseTo(3550);
    expect(calculateRequiredPower(75, DefaultSettings)).toBeCloseTo(3550);
    expect(calculateRequiredPower(100, DefaultSettings)).toBeCloseTo(3550);
  });

  it('extrapolates linearly below -5 using first segment slope', () => {
    // slope = 2000/53 ≈ 37.735 per °C (−5→48)
    expect(calculateRequiredPower(-5, DefaultSettings)).toBeCloseTo(-2000);
    expect(calculateRequiredPower(-58, DefaultSettings)).toBeCloseTo(-4000, 0);
  });

  it('NaN → NaN (documents bug)', () => {
    expect(Number.isNaN(calculateRequiredPower(NaN, DefaultSettings))).toBe(true);
  });
});
