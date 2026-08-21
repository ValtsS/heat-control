import {
  GetState,
  resetControlStateForTest,
  getControlStateForTest,
  PowerState,
  HEATER_WATTS,
} from './control';
import * as sun from './sun';

describe('GetState – offline (no forecast, sun-elevation gate)', () => {
  let hrtimeSpy: jest.SpyInstance;
  let nowNs = BigInt(0);

  function setHrtime(ns: bigint) {
    nowNs = ns;
    hrtimeSpy.mockReturnValue(nowNs);
  }

  function mockSun(elevation: number) {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(elevation);
  }

  beforeEach(() => {
    resetControlStateForTest();
    nowNs = BigInt(1_000_000_000_000);
    hrtimeSpy = jest.spyOn(process.hrtime, 'bigint').mockReturnValue(nowNs);
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(20); // default sun up
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('cold tank + sun up + surplus → TurningOn', () => {
    mockSun(20);
    expect(GetState(500, 40, false)).toBe(true); // T well below requiredNow
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('tank at/above required temp → TurningOff even with sun', () => {
    mockSun(20);
    // requiredNow ≈ target+loss/EPD (~63 at noon); 70 °C is above → no heat
    expect(GetState(500, 70, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('sun down (no forecast) → no heat even if cold', () => {
    mockSun(5); // below MinElevDeg 12
    expect(GetState(500, 40, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('offline (no power data) + sun up → heat (sun elevation is the fallback)', () => {
    mockSun(20);
    expect(GetState(0, 40, false)).toBe(true); // p=0 but sun up → heat
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
    resetControlStateForTest();
    mockSun(5); // sun down → no heat
    expect(GetState(0, 40, false)).toBe(false);
  });

  it('HEATER_WATTS constant', () => {
    expect(HEATER_WATTS).toBeCloseTo(2496);
  });

  it('stabilization: retains state for 15s after TurningOn/TurningOff', () => {
    const base = BigInt(1_000_000_000_000);
    mockSun(20);
    expect(GetState(5000, 40, false)).toBe(true); // Undefined→TurningOn at base
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);

    // within 5s, inputs would turn off (sun down), but must stay true
    setHrtime(base + BigInt(5_000_000_000));
    mockSun(5);
    expect(GetState(0, 70, false)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);

    // after 16s, progresses TurningOn→On
    setHrtime(base + BigInt(16_000_000_000));
    mockSun(20);
    expect(GetState(0, 70, false)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.On);

    // On with conditions now off → TurningOff (at 17s)
    setHrtime(base + BigInt(17_000_000_000));
    mockSun(5);
    expect(GetState(0, 70, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);

    // within hold (18s), stays false even if sun returns
    setHrtime(base + BigInt(18_000_000_000));
    mockSun(20);
    expect(GetState(5000, 40, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);

    // after hold, TurningOff→Off (33s)
    setHrtime(base + BigInt(33_000_000_000));
    mockSun(20);
    expect(GetState(5000, 40, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.Off);
  });

  it('NaN temperature → heater off', () => {
    mockSun(20);
    expect(GetState(5000, NaN, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('full cycle: Undefined→TurningOn→On→TurningOff→Off', () => {
    const base = BigInt(1_000_000_000_000);
    mockSun(20);
    expect(GetState(5000, 40, false)).toBe(true);
    setHrtime(base + BigInt(16_000_000_000));
    expect(GetState(5000, 40, false)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.On);
    setHrtime(base + BigInt(17_000_000_000));
    mockSun(5);
    expect(GetState(0, 70, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
    setHrtime(base + BigInt(33_000_000_000));
    mockSun(5);
    expect(GetState(0, 70, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.Off);
  });
});
