import { LegionellaService, LEGIONELLA_INTERVAL_MS } from './legionella';
import { MemoryForecastStore } from './forecast/cache';

describe('LegionellaService – 60C/7d', () => {
  it('needs heat if never reached 60C', async () => {
    const store = new MemoryForecastStore();
    const svc = new LegionellaService(store);
    expect(await svc.needsForcedHeat(new Date('2025-08-15T10:00:00Z'))).toBe(true);
  });

  it('needs heat after 7 days without 60C', async () => {
    const store = new MemoryForecastStore();
    const svc = new LegionellaService(store);
    const last = new Date('2025-08-08T10:00:00Z');
    await store.saveHot(last);
    const nowOk = new Date('2025-08-14T10:00:00Z'); // 6d
    expect(await svc.needsForcedHeat(nowOk)).toBe(false);
    const nowForced = new Date('2025-08-15T10:00:01Z'); // 7d+1s
    expect(await svc.needsForcedHeat(nowForced)).toBe(true);
  });

  it('recordIfHot only when >=60', async () => {
    const store = new MemoryForecastStore();
    const svc = new LegionellaService(store);
    await svc.recordIfHot(59);
    expect(await store.lastHot()).toBeNull();
    const at = new Date('2025-08-15T12:00:00Z');
    await svc.recordIfHot(61, at);
    expect(await store.lastHot()).toEqual(at);
  });

  it('daily 40C helper', () => {
    // 09:00 local with 35C needs heat
    expect(LegionellaService.needsDaily40C(35, new Date('2025-08-15T07:00:00'))).toBe(true);
    // 42C no need
    expect(LegionellaService.needsDaily40C(42, new Date('2025-08-15T07:00:00'))).toBe(false);
    // afternoon not morning window
    expect(LegionellaService.needsDaily40C(35, new Date('2025-08-15T15:00:00'))).toBe(false);
  });

  it('configurable temperature via env', async () => {
    const store = new MemoryForecastStore();
    const svc = new LegionellaService(store);
    // default 60 – 59 does not record
    await svc.recordIfHot(59);
    expect(await store.lastHot()).toBeNull();
    // 60 records
    await svc.recordIfHot(60, new Date('2025-08-15T10:00:00Z'));
    expect(await store.lastHot()).not.toBeNull();
  });
});
