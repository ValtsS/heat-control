import { MemoryForecastStore, SqliteForecastStore } from './cache';
import { Forecast } from './types';
import * as fs from 'fs';

function makeForecast(pv: number): Forecast {
  return {
    forecasts: [
      {
        period_start: new Date('2025-08-15T10:00:00Z'),
        period_end: new Date('2025-08-15T11:00:00Z'),
        pv_estimate: pv,
      },
    ],
    fetchedAt: new Date('2025-08-15T08:00:00Z'),
    provider: 'test',
  };
}

describe('MemoryForecastStore', () => {
  it('save/load and legionella', async () => {
    const s = new MemoryForecastStore();
    expect(await s.load()).toBeNull();
    expect(await s.lastHot()).toBeNull();
    const f = makeForecast(5);
    await s.save(f);
    expect((await s.load())?.forecasts[0].pv_estimate).toBe(5);
    const hot = new Date('2025-08-10T10:00:00Z');
    await s.saveHot(hot);
    expect(await s.lastHot()).toEqual(hot);
  });
});

describe('SqliteForecastStore', () => {
  const p = './data/test-heat-cache.db';
  afterEach(async () => {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  });

  it('persists forecast and last_hot', async () => {
    const s = new SqliteForecastStore(p);
    const f = makeForecast(7);
    await s.save(f);
    const loaded = await s.load();
    expect(loaded?.provider).toBe('test');
    expect(loaded?.forecasts[0].pv_estimate).toBe(7);

    const hot = new Date('2025-08-12T12:00:00Z');
    await s.saveHot(hot);
    expect((await s.lastHot())?.toISOString()).toBe(hot.toISOString());

    await s.close();
    // reopen retains
    const s2 = new SqliteForecastStore(p);
    expect((await s2.load())?.provider).toBe('test');
    expect((await s2.lastHot())?.toISOString()).toBe(hot.toISOString());
    await s2.close();
  });

  it('loads null when empty', async () => {
    const s = new SqliteForecastStore(':memory:');
    expect(await s.load()).toBeNull();
    expect(await s.lastHot()).toBeNull();
    await s.close();
  });
});
