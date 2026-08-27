import { planSchedule, PlannerConfig } from './planner';
import { Forecast } from '../forecast/types';

function makeForecast(dayKwh: number[], fetchedAt?: Date): Forecast {
  const base = new Date('2026-08-15T05:00:00Z');
  const entries = [];
  for (let d = 0; d < dayKwh.length; d++) {
    for (let h = 0; h < 24; h++) {
      const start = new Date(base.getTime() + d * 24 * 3600e3 + h * 3600e3);
      entries.push({
        period_start: start,
        period_end: new Date(start.getTime() + 3600e3),
        pv_estimate: dayKwh[d] / 24,
      });
    }
  }
  return { forecasts: entries, fetchedAt: fetchedAt ?? new Date(), provider: 'test' };
}

const CFG: PlannerConfig = {
  model: {
    litres: 150,
    heaterKw: 2.4,
    tankLossKwhPerDay: 2.85,
    usageKwhPerDay: 6.1,
    minTemp: 40,
    maxTemp: 63,
    targetTemp: 55,
  },
  heaterKw: 2.4,
  boilerPhaseShare: 0.33,
  horizonHours: 48,
  morning: { startHour: 6, endHour: 10, temp: 40 },
  forecastMaxAgeMs: 6 * 3600 * 1000,
};

describe('planSchedule – heat now or defer?', () => {
  it('legionella forced → always heat', () => {
    const p = planSchedule(
      new Date('2026-08-15T12:00:00Z'),
      52,
      0,
      makeForecast([12, 12]),
      true,
      CFG
    );
    expect(p.heat).toBe(true);
    expect(p.reason).toBe('legionella');
  });

  it('morning + cold → hard floor heat', () => {
    const at = new Date('2026-08-15T07:00:00Z');
    const p = planSchedule(at, 35, 0, makeForecast([12, 12]), false, CFG);
    expect(p.heat).toBe(true);
    expect(p.reason).toBe('morning-floor');
  });

  it('no forecast → no-forecast fallback', () => {
    const p = planSchedule(new Date('2026-08-15T12:00:00Z'), 50, undefined, null, false, CFG);
    expect(p.reason).toBe('no-forecast');
    expect(p.heat).toBe(false);
  });

  it('live surplus spike → free-surplus heat now (fast-path soak)', () => {
    // big live surplus on the phase (>= heater) → soak it, even into a warm tank
    const cfg: PlannerConfig = { ...CFG, horizonHours: 6 };
    const at = new Date('2026-08-15T12:00:00Z');
    const p = planSchedule(at, 45, 3.0, makeForecast([12, 2]), false, cfg, (d) => d.getUTCHours());
    expect(p.heat).toBe(true);
    expect(p.reason).toBe('free-surplus');
  });

  it('heater ON + low live reading but big real surplus → keeps heating (no oscillation)', () => {
    // regression: live reading is the surplus AFTER the heater draw. With heater ON
    // it reads ~1.4 kW but real surplus is ~3.8 kW → must STAY on (no chatter).
    const cfg: PlannerConfig = { ...CFG, horizonHours: 6 };
    const at = new Date('2026-08-15T12:00:00Z');
    // heaterOn=true, live 1.4 kW → base surplus 1.4 + 2.4 = 3.8 kW ≥ 2.4 → keep heating
    const p = planSchedule(
      at,
      45,
      1.4,
      makeForecast([12, 2]),
      false,
      cfg,
      (d) => d.getUTCHours(),
      true
    );
    expect(p.heat).toBe(true);
    expect(p.reason).toBe('free-surplus');
  });

  it('heater OFF + live below threshold → no free-surplus (correct)', () => {
    const cfg: PlannerConfig = { ...CFG, horizonHours: 6 };
    const at = new Date('2026-08-15T12:00:00Z');
    // heater off, live 1.4 kW (< 2.4) → base surplus 1.4 kW → NOT free → defer/solver
    const p = planSchedule(
      at,
      45,
      1.4,
      makeForecast([12, 2]),
      false,
      cfg,
      (d) => d.getUTCHours(),
      false
    );
    expect(p.reason).toBe('defer');
  });

  it('warm tank + no solar → defer', () => {
    const at = new Date('2026-08-15T02:00:00Z'); // night
    const p = planSchedule(at, 60, 0, makeForecast([0, 1]), false, CFG, (d) => d.getUTCHours());
    expect(p.heat).toBe(false);
    expect(p.reason).toBe('defer');
  });
});
