import { solveHorizon, MorningFloor } from './solver';
import { TankModelConfig } from './model';

const CFG: TankModelConfig = {
  litres: 150,
  heaterKw: 2.4,
  tankLossKwhPerDay: 2.85,
  usageKwhPerDay: 6.1,
  minTemp: 40,
  maxTemp: 63,
  targetTemp: 55,
};

const HEATER_KW = 2.4;
const MORNING: MorningFloor = { startHour: 6, endHour: 10, temp: 40 };

// use UTC as "local" so tests don't depend on the machine's timezone
const UTC: (d: Date) => number = (d) => d.getUTCHours();

function at(hourUtc: number): Date {
  return new Date(`2026-08-15T${String(hourUtc).padStart(2, '0')}:00:00Z`);
}

describe('solveHorizon – MPC receding-horizon scheduler', () => {
  it('warm tank + no solar + no floor → zero import (coast)', () => {
    const solar = Array(24).fill(0);
    const res = solveHorizon(60, solar, CFG, HEATER_KW, at(8), 24, null, undefined, undefined, UTC);
    expect(res.feasible).toBe(true);
    expect(res.steps.every((s) => !s.heat)).toBe(true);
    expect(res.totalImportKwh).toBe(0);
  });

  it('free surplus at hour 0 → heats now at zero import', () => {
    const solar = new Array(24).fill(0);
    solar[0] = 3.0;
    const res = solveHorizon(45, solar, CFG, HEATER_KW, at(8), 12, null, undefined, undefined, UTC);
    expect(res.steps[0].heat).toBe(true);
    expect(res.steps[0].importKw).toBe(0);
  });

  it('no surplus now, free surplus later → defers, then heats free', () => {
    const solar = new Array(24).fill(0);
    solar[3] = 3.0;
    const res = solveHorizon(45, solar, CFG, HEATER_KW, at(8), 12, null, undefined, undefined, UTC);
    expect(res.steps.slice(0, 3).every((s) => !s.heat)).toBe(true);
    expect(res.steps[3].heat).toBe(true);
    expect(res.steps[3].importKw).toBe(0);
  });

  it('cold tank + no solar + morning floor → imports to reach floor', () => {
    const solar = Array(24).fill(0);
    // tank 35°C at 05:00 UTC; window starts 06:00 → must be ≥40 by then
    const res = solveHorizon(
      35,
      solar,
      CFG,
      HEATER_KW,
      at(5),
      12,
      MORNING,
      undefined,
      undefined,
      UTC
    );
    expect(res.feasible).toBe(true);
    const at6 = res.steps.find((s) => s.localHour === 6);
    expect(at6?.temp).toBeGreaterThanOrEqual(40);
    expect(res.steps.some((s) => s.heat && s.importKw > 0)).toBe(true);
  });

  it('tank at thermostat cap, no solar → no heating (nothing to gain)', () => {
    const solar = Array(12).fill(0);
    const res = solveHorizon(63, solar, CFG, HEATER_KW, at(8), 12, null, undefined, undefined, UTC);
    expect(res.steps.every((s) => !s.heat)).toBe(true);
    expect(res.totalImportKwh).toBe(0);
  });

  it('warm tank + no solar + floor far away → does not waste import early', () => {
    const solar = Array(24).fill(0);
    // 60°C at 12:00, floor next morning ~18h away → tank stays warm; solver should
    // only import what's needed to hold the morning floor, not heat all day
    const res = solveHorizon(
      60,
      solar,
      CFG,
      HEATER_KW,
      at(12),
      24,
      MORNING,
      undefined,
      undefined,
      UTC
    );
    expect(res.steps[0].heat).toBe(false);
    expect(res.steps[0].importKw).toBe(0);
    expect(res.totalImportKwh).toBeLessThan(5);
  });
});
