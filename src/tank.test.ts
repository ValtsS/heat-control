import { planTank, TankConfig, TankPlan } from './tank';
import { Forecast } from './forecast/types';

const CFG: TankConfig = {
  litres: 150,
  targetTemp: 55,
  tankLossKwhPerDay: 2.85, // 55.8→50 over 8.5h
  usageKwhPerDay: 6.1, // 8.98 kWh cycle − loss
  maxBankDeg: 7,
  forecastMaxAgeMs: 6 * 3600 * 1000,
  maxTemp: 63,
};

// hourly forecast from 05Z today, 3 days: first two arrays = today, third = tomorrow
function forecastFrom(dayKwh: number[], fetchedAt?: Date): Forecast {
  const base = new Date('2025-08-15T05:00:00Z');
  const fetched = fetchedAt ?? new Date(); // fresh unless overridden (stale test)
  const entries = [];
  for (let d = 0; d < dayKwh.length; d++) {
    const kWh = dayKwh[d];
    for (let h = 0; h < 24; h++) {
      const start = new Date(base.getTime() + d * 24 * 3600e3 + h * 3600e3);
      entries.push({
        period_start: start,
        period_end: new Date(start.getTime() + 3600e3),
        pv_estimate: kWh / 24, // flat across the day
      });
    }
  }
  return { forecasts: entries, fetchedAt: fetched, provider: 'test' };
}

function req(plan: TankPlan) {
  return plan.requiredNow;
}

describe('planTank – horizon planner', () => {
  it('good today + good tomorrow → morning requiredNow very low (defer)', () => {
    const at = new Date('2025-08-15T07:00:00Z');
    const fc = forecastFrom([11, 11]); // today 11, tomorrow 11
    const plan = planTank(at, 45, fc, CFG);
    expect(plan.solarToday).toBeGreaterThan(0);
    expect(plan.bankDelta).toBeLessThan(4); // tomorrow covers need
    // requiredNow well below current tank temp → no morning heating
    expect(req(plan)).toBeLessThan(40);
    expect(plan.stale).toBe(false);
  });

  it('late day with little remaining solar → requiredNow climbs (2nd-half hold)', () => {
    const at = new Date('2025-08-15T18:00:00Z');
    const fc = forecastFrom([11, 11]);
    const plan = planTank(at, 57, fc, CFG);
    // few kWh left today → requiredNow climbs toward target → evening hold keeps tank hot
    expect(plan.solarToday).toBeLessThan(4);
    expect(req(plan)).toBeGreaterThan(45);
  });

  it('bad tomorrow → bankDelta raises target (preheat today)', () => {
    const at = new Date('2025-08-15T07:00:00Z');
    const fc = forecastFrom([11, 2]); // tomorrow only 2 kWh
    const plan = planTank(at, 45, fc, CFG);
    expect(plan.solarTomorrow).toBeLessThan(5);
    expect(plan.bankDelta).toBeGreaterThan(0);
    expect(plan.targetEod).toBeGreaterThan(CFG.targetTemp);
  });

  it('stale forecast (older than max age) → treated as no-data, no bank, requiredNow high', () => {
    const at = new Date('2025-08-15T12:00:00Z');
    const fc = forecastFrom([11, 11], new Date('2025-08-15T01:00:00Z')); // 11h old > 6h
    const plan = planTank(at, 50, fc, CFG);
    expect(plan.stale).toBe(true);
    expect(plan.solarToday).toBe(0);
    expect(plan.solarTomorrow).toBe(0);
    expect(req(plan)).toBeGreaterThan(CFG.targetTemp);
  });

  it('thermostat cap – targetEod never exceeds maxTemp', () => {
    const at = new Date('2025-08-15T07:00:00Z');
    const fc = forecastFrom([11, 0]); // terrible tomorrow
    const plan = planTank(at, 40, fc, CFG);
    expect(plan.targetEod).toBeLessThanOrEqual(CFG.maxTemp);
    expect(plan.targetEod).toBeLessThanOrEqual(63);
  });

  it('no forecast → conservative requiredNow', () => {
    const at = new Date('2025-08-15T07:00:00Z');
    const plan = planTank(at, 45, null, CFG);
    expect(plan.stale).toBe(true);
    expect(plan.solarToday).toBe(0);
    expect(plan.requiredNow).toBeGreaterThan(CFG.targetTemp);
  });
});
