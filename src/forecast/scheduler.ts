import { ForecastProvider } from './types';
import { ForecastStore } from './cache';

export class ForecastScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private provider: ForecastProvider,
    private store: ForecastStore,
    private intervalMs: number = parseInt(process.env.FORECAST_INTERVAL_MS ?? '3600000', 10) // 1h default, Solcast 10/day → 6h = 21600000
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
    this.timer = setInterval(
      () => this.tick().catch((e) => console.error('forecast tick', e)),
      this.intervalMs
    );
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async tick(): Promise<void> {
    if (!this.provider.isConfigured()) {
      console.log(`Forecast provider ${this.provider.name} not configured – skipping fetch`);
      return;
    }
    try {
      const f = await this.provider.fetchForecast();
      await this.store.save(f);
      console.log(
        `Forecast ${this.provider.name} fetched ${
          f.forecasts.length
        } entries at ${f.fetchedAt.toISOString()}`
      );
    } catch (e) {
      console.error(`Forecast fetch failed ${this.provider.name}`, e);
      // keep stale cache – caller will handle
    }
  }

  // for tests / on-demand refresh
  async refreshNow(): Promise<void> {
    await this.tick();
  }
}
