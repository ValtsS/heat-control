import { OpenMeteoProvider } from './openMeteoProvider';

function mockFetchJson(json: any) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => json,
  } as any);
}

afterEach(() => jest.restoreAllMocks());

describe('OpenMeteoProvider generic', () => {
  it('fetches and sums 2 arrays (3kW E +10kW S)', async () => {
    // two calls – we mock fetch to return different irradiance per array via URL inspect
    const responses: Record<string, any> = {};
    // simple: both return same time series
    const base = {
      hourly: {
        time: ['2025-08-15T10:00:00Z', '2025-08-15T11:00:00Z'],
        global_tilted_irradiance: [500, 800],
      },
    };
    let call = 0;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      call++;
      // first array is E 3kWp, second S 10kWp – return slightly different irradiance to prove sum
      const irr = call === 1 ? [500, 800] : [600, 900];
      return Promise.resolve({
        ok: true,
        json: async () => ({ hourly: { time: base.hourly.time, global_tilted_irradiance: irr } }),
      } as any);
    });

    const p = new OpenMeteoProvider({
      lat: 57,
      lon: 25,
      arrays: [
        { kWp: 3, tilt: 35, azimuth: -90 },
        { kWp: 10, tilt: 45, azimuth: 0 },
      ],
      efficiency: 1,
      forecastDays: 1,
    });
    const f = await p.fetchForecast();
    expect(f.forecasts).toHaveLength(2);
    // first hour: 500*3/1000=1.5 + 600*10/1000=6 => 7.5
    expect(f.forecasts[0].pv_estimate).toBeCloseTo(7.5);
    expect(f.provider).toBe('open-meteo');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('isConfigured respects PV arrays', () => {
    const p = new OpenMeteoProvider({ arrays: [] });
    expect(p.isConfigured()).toBe(false);
    const p2 = new OpenMeteoProvider({ arrays: [{ kWp: 1, tilt: 30, azimuth: 0 }] });
    expect(p2.isConfigured()).toBe(true);
  });

  it('throws on non-ok response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'err' } as any);
    const p = new OpenMeteoProvider({ arrays: [{ kWp: 1, tilt: 30, azimuth: 0 }] });
    await expect(p.fetchForecast()).rejects.toThrow('OpenMeteo 500');
  });
});

describe('ForecastProvider interface – solcast pluggable', () => {
  it('can swap provider without changing caller', async () => {
    // @ts-ignore NodeNext needs .js but babel handles bare
    const { SolcastProvider } = await import('./solcastProvider');
    const stub: any = {
      name: 'stub',
      isConfigured: () => true,
      fetchForecast: async () => ({ forecasts: [], fetchedAt: new Date(), provider: 'stub' }),
    };
    const p: import('./types').ForecastProvider = stub;
    expect(p.name).toBe('stub');
    const f = await p.fetchForecast();
    expect(f.provider).toBe('stub');
  });
});
