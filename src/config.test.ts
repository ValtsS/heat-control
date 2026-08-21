import { parseDuration, parseNum, parseIntVal } from './config';

describe('config – human-readable parsing', () => {
  it('parseDuration supports h/d/m/s/ms and defaults', () => {
    expect(parseDuration('1h', 0)).toBe(3600 * 1000);
    expect(parseDuration('6h', 0)).toBe(6 * 3600 * 1000);
    expect(parseDuration('1.5h', 0)).toBe(1.5 * 3600 * 1000);
    expect(parseDuration('7d', 0)).toBe(7 * 24 * 3600 * 1000);
    expect(parseDuration('20m', 0)).toBe(20 * 60 * 1000);
    expect(parseDuration('90s', 0)).toBe(90 * 1000);
    expect(parseDuration('500', 0)).toBe(500);
    expect(parseDuration(undefined, 123)).toBe(123);
    expect(parseDuration('', 123)).toBe(123);
  });

  it('parseDuration throws on garbage', () => {
    expect(() => parseDuration('banana', 0)).toThrow();
    expect(() => parseDuration('5x', 0)).toThrow();
  });

  it('parseNum / parseIntVal default and parse', () => {
    expect(parseNum(undefined, 10)).toBe(10);
    expect(parseNum('2.5', 10)).toBe(2.5);
    expect(parseNum('abc', 10)).toBe(10);
    expect(parseIntVal('7', 10)).toBe(7);
    expect(parseIntVal('abc', 10)).toBe(10);
    expect(parseIntVal(undefined, 10)).toBe(10);
  });
});
