import {
  GetState,
  resetControlStateForTest,
  getControlStateForTest,
  PowerState,
  calculateRequiredPower,
  DefaultSettings,
  HEATER_WATTS,
} from './control';
import * as sun from './sun';

describe('GetState – dumb branch (solar elevation + hysteresis + stabilization)', () => {
  let hrtimeSpy: jest.SpyInstance;
  let nowNs = BigInt(0);

  function setHrtime(ns: bigint) {
    nowNs = ns;
    hrtimeSpy.mockReturnValue(nowNs);
  }

  function mockSun(elevation: number, minutesToMidday: number) {
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(elevation);
    jest.spyOn(sun, 'minutesFromSolarMiddayUTC').mockReturnValue(minutesToMidday);
  }

  beforeEach(() => {
    resetControlStateForTest();
    nowNs = BigInt(1_000_000_000_000);
    hrtimeSpy = jest.spyOn(process.hrtime, 'bigint').mockReturnValue(nowNs);
    jest.spyOn(sun, 'getSunElevationUTC').mockReturnValue(20); // default sun up
    jest.spyOn(sun, 'minutesFromSolarMiddayUTC').mockReturnValue(0);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Undefined → TurningOn when power > required and sun high', () => {
    mockSun(20, 0); // elevation 20 ≥12
    expect(GetState(500, 48, false)).toBe(true); // 48 requires 0, 500>0
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
  });

  it('Undefined → TurningOff when insufficient power even with sun', () => {
    mockSun(20, 0);
    expect(GetState(100, 57, false)).toBe(false); // 57 requires 3550
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('hysteresis: heaterOn lowers threshold by 2496', () => {
    const base = BigInt(1_000_000_000_000);
    const req = calculateRequiredPower(53, DefaultSettings); // 1000
    expect(req).toBeCloseTo(1000);
    mockSun(20, 0);

    // power 500: without heater 500>1000 false; with heater 500>1000-2496 true
    expect(GetState(500, 53, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);

    // advance past TurningOff hold (15s) → Off
    setHrtime(base + BigInt(16_000_000_000));
    expect(GetState(500, 53, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.Off);

    // now with heaterOn should turn on via hysteresis (17s)
    setHrtime(base + BigInt(17_000_000_000));
    expect(GetState(500, 53, true)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);
    expect(HEATER_WATTS).toBeCloseTo(2496);
  });

  it('sun gate: blocks when elevation low, midday far, and power low', () => {
    // T=48 requires 0, power 500 would normally enable, but sun is down and not midday
    mockSun(5, 300); // elevation 5<12, 300min from midday
    expect(GetState(500, 48, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('sun gate: allows when elevation ≥12 even with low power', () => {
    mockSun(15, 300);
    expect(GetState(500, 48, false)).toBe(true);
  });

  it('sun gate: allows when near solar midday (<120) even with low elevation', () => {
    mockSun(5, 60); // low elevation but near midday
    expect(GetState(500, 48, false)).toBe(true);
  });

  it('sun gate: allows when avail power >2000 even with low sun', () => {
    mockSun(5, 300);
    // avail = power + (heaterOn?2496:0) ; need >2000
    // power 500 alone insufficient, but with heaterOn avail 2996 >2000
    expect(GetState(500, 48, false)).toBe(false); // 500 not >2000
    resetControlStateForTest();
    setHrtime(nowNs);
    mockSun(5, 300);
    expect(GetState(500, 48, true)).toBe(true); // 500+2496>2000 bypass
    // also direct high grid power
    resetControlStateForTest();
    setHrtime(nowNs);
    mockSun(5, 300);
    expect(GetState(2500, 48, false)).toBe(true); // 2500>2000 bypass
  });

  it('stabilization: retains state for 15s after TurningOn/TurningOff', () => {
    const base = BigInt(1_000_000_000_000);
    mockSun(20, 0);
    expect(GetState(5000, 48, false)).toBe(true); // Undefined→TurningOn at base
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);

    // within 5s, inputs would turn off, but must stay true
    setHrtime(base + BigInt(5_000_000_000));
    mockSun(5, 300); // sun now down
    expect(GetState(0, 57, false)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.TurningOn);

    // after 16s, progresses TurningOn→On
    setHrtime(base + BigInt(16_000_000_000));
    mockSun(20, 0);
    expect(GetState(0, 57, false)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.On);

    // On with insufficient power → TurningOff (at 17s)
    setHrtime(base + BigInt(17_000_000_000));
    mockSun(5, 300);
    expect(GetState(0, 57, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);

    // within hold (18s = 1s into TurningOff), stays false even if power returns
    setHrtime(base + BigInt(18_000_000_000));
    mockSun(20, 0);
    expect(GetState(5000, 48, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);

    // after hold, TurningOff→Off (33s = 16s after TurningOff)
    setHrtime(base + BigInt(33_000_000_000));
    mockSun(20, 0);
    expect(GetState(5000, 48, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.Off);
  });

  it('NaN temperature → heater off', () => {
    mockSun(20, 0);
    expect(GetState(5000, NaN, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
  });

  it('full cycle: Undefined→TurningOn→On→TurningOff→Off', () => {
    const base = BigInt(1_000_000_000_000);
    mockSun(20, 0);
    expect(GetState(5000, 48, false)).toBe(true);
    setHrtime(base + BigInt(16_000_000_000));
    expect(GetState(5000, 48, false)).toBe(true);
    expect(getControlStateForTest()).toBe(PowerState.On);
    setHrtime(base + BigInt(17_000_000_000));
    mockSun(5, 300);
    expect(GetState(0, 57, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.TurningOff);
    setHrtime(base + BigInt(33_000_000_000));
    mockSun(5, 300);
    expect(GetState(0, 57, false)).toBe(false);
    expect(getControlStateForTest()).toBe(PowerState.Off);
  });
});
