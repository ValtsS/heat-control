import { PowerService } from './power';
import { MemoryForecastStore } from './forecast/cache';

function makeFlux(power: number | undefined, shouldThrow = false) {
  return {
    getPower: jest.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('wifi down');
      return power;
    }),
  } as any;
}

describe('PowerService – wifi down fallback', () => {
  it('returns influx power when available', async () => {
    const store = new MemoryForecastStore();
    const flux = makeFlux(1200);
    const svc = new PowerService(flux, () => store.load());
    const r = await svc.getAvailablePower();
    expect(r.power).toBe(1200);
    expect(r.estimated).toBe(false);
    expect(r.source).toBe('influx');
  });

  it('falls back to forecast when influx undefined', async () => {
    const store = new MemoryForecastStore();
    await store.save({
      forecasts: [
        {
          period_start: new Date('2025-08-15T10:00:00Z'),
          period_end: new Date('2025-08-15T11:00:00Z'),
          pv_estimate: 5,
        },
      ],
      fetchedAt: new Date(),
      provider: 'test',
    });
    const flux = makeFlux(undefined);
    const svc = new PowerService(flux, () => store.load());
    // set system time inside forecast period
    jest.useFakeTimers().setSystemTime(new Date('2025-08-15T10:30:00Z'));
    const r = await svc.getAvailablePower();
    // 5kW forecast directly as available (active_grid_B_power_W is already net)
    expect(r.estimated).toBe(true);
    expect(r.power).toBe(5000);
    jest.useRealTimers();
  });

  it('falls back to sun elevation when both missing (peak sun → high power)', async () => {
    const store = new MemoryForecastStore();
    const flux = makeFlux(undefined);
    const svc = new PowerService(flux, () => store.load());
    // mock sun high
    jest.useFakeTimers().setSystemTime(new Date('2025-06-21T12:00:00Z'));
    const r = await svc.getAvailablePower();
    expect(r.estimated).toBe(true);
    expect(r.source).toBe('sun-fallback');
    // June noon elev ~56° → elev*40=2240 → clamp 2400
    expect(r.power).toBeGreaterThan(1500);
    jest.useRealTimers();
  });

  it('returns undefined when dark and no data (legionella handles)', async () => {
    const store = new MemoryForecastStore();
    const flux = makeFlux(undefined);
    const svc = new PowerService(flux, () => store.load());
    // winter midnight – elevation negative → undefined
    jest.useFakeTimers().setSystemTime(new Date('2025-12-21T00:00:00Z'));
    const r = await svc.getAvailablePower();
    expect(r.power).toBeUndefined();
    expect(r.source).toBe('none');
    jest.useRealTimers();
  });
});
