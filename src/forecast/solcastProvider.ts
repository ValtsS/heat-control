import { Forecast, ForecastProvider } from './types';
import { ForecastProcessor } from './processor';

// Generic stub – plug real Solcast later without touching callers.
// Master had src/solcast/forecast.ts with period/PT30M json – we reuse that parsing.
// Env: SOLCAST_API_KEY, SOLCAST_SITE_ID (resource id)
type SolcastRaw = {
  forecasts: {
    pv_estimate: number;
    period: string;
    period_end: string;
    period_start?: string;
  }[];
};

export class SolcastProvider implements ForecastProvider {
  name = 'solcast';
  private apiKey?: string;
  private siteId?: string;

  constructor(opts?: { apiKey?: string; siteId?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.SOLCAST_API_KEY;
    this.siteId = opts?.siteId ?? process.env.SOLCAST_SITE_ID;
  }

  isConfigured(): boolean {
    return !!this.apiKey && !!this.siteId;
  }

  async fetchForecast(): Promise<Forecast> {
    if (!this.isConfigured())
      throw new Error('Solcast not configured: set SOLCAST_API_KEY and SOLCAST_SITE_ID');
    const url = `https://api.solcast.com.au/rooftop_sites/${this.siteId}/forecasts?format=json&api_key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Solcast ${res.status} ${await res.text()}`);
    const raw = (await res.json()) as SolcastRaw;
    const fetchedAt = new Date();
    const forecasts = raw.forecasts.map((f) => {
      const end = new Date(f.period_end);
      const start = f.period_start
        ? new Date(f.period_start)
        : new Date(end.getTime() - 30 * 60 * 1000); // PT30M
      return {
        period_start: start,
        period_end: end,
        pv_estimate: f.pv_estimate,
        source: this.name,
      };
    });
    // ensure sorted
    forecasts.sort((a, b) => a.period_start.getTime() - b.period_start.getTime());
    return { forecasts, fetchedAt, provider: this.name };
  }

  // helper for testing – parse saved Solcast JSON without network, reuses master logic
  static parseJson(json: string): Forecast {
    const raw = JSON.parse(json) as SolcastRaw;
    const fetchedAt = new Date();
    const forecasts = raw.forecasts.map((f) => {
      const end = new Date(f.period_end);
      const start = new Date(end.getTime() - 30 * 60 * 1000);
      return {
        period_start: start,
        period_end: end,
        pv_estimate: f.pv_estimate,
        source: 'solcast',
      };
    });
    forecasts.sort((a, b) => a.period_start.getTime() - b.period_start.getTime());
    return { forecasts, fetchedAt, provider: 'solcast' };
  }
}
