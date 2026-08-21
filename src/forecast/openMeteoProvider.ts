import { Forecast, ForecastEntry, ForecastProvider, PvArrayConfig, parsePvArrays } from './types';

type OpenMeteoHourly = {
  time: string[];
  global_tilted_irradiance?: number[];
  shortwave_radiation?: number[];
};

type OpenMeteoResponse = {
  hourly: OpenMeteoHourly;
};

export class OpenMeteoProvider implements ForecastProvider {
  name = 'open-meteo';
  private lat: number;
  private lon: number;
  private arrays: PvArrayConfig[];
  private efficiency: number;
  private forecastDays: number;

  constructor(opts?: {
    lat?: number;
    lon?: number;
    arrays?: PvArrayConfig[];
    efficiency?: number;
    forecastDays?: number;
  }) {
    this.lat = opts?.lat ?? parseFloat(process.env.LAT ?? '57');
    this.lon = opts?.lon ?? parseFloat(process.env.LON ?? '25');
    this.arrays = opts?.arrays ?? parsePvArrays(process.env.PV_ARRAYS);
    this.efficiency = opts?.efficiency ?? parseFloat(process.env.PV_EFFICIENCY ?? '0.85');
    this.forecastDays = opts?.forecastDays ?? parseInt(process.env.FORECAST_DAYS ?? '3', 10);
  }

  isConfigured(): boolean {
    return this.arrays.length > 0 && !isNaN(this.lat) && !isNaN(this.lon);
  }

  async fetchForecast(): Promise<Forecast> {
    if (!this.isConfigured()) throw new Error('OpenMeteo not configured');
    // fetch per array and sum
    const perArray = await Promise.all(this.arrays.map((a) => this.fetchArray(a)));
    // perArray[0][i].pv_estimate is kW for that array; sum
    const merged: ForecastEntry[] = [];
    const len = perArray[0].length;
    for (let i = 0; i < len; i++) {
      const base = perArray[0][i];
      let sum = 0;
      for (const arr of perArray) sum += arr[i].pv_estimate;
      merged.push({
        period_start: base.period_start,
        period_end: base.period_end,
        pv_estimate: sum,
        source: this.name,
      });
    }
    return { forecasts: merged, fetchedAt: new Date(), provider: this.name };
  }

  private async fetchArray(arr: PvArrayConfig): Promise<ForecastEntry[]> {
    const params = new URLSearchParams({
      latitude: this.lat.toString(),
      longitude: this.lon.toString(),
      hourly: 'global_tilted_irradiance',
      tilt: arr.tilt.toString(),
      azimuth: arr.azimuth.toString(),
      forecast_days: this.forecastDays.toString(),
      timezone: 'UTC',
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenMeteo ${res.status} ${await res.text()}`);
    const data = (await res.json()) as OpenMeteoResponse;
    const times = data.hourly.time;
    const irrs = data.hourly.global_tilted_irradiance ?? data.hourly.shortwave_radiation ?? [];
    const entries: ForecastEntry[] = [];
    for (let i = 0; i < times.length; i++) {
      const start = new Date(times[i]);
      // period is 1 hour; use next time as end if available else +1h
      const end =
        i + 1 < times.length ? new Date(times[i + 1]) : new Date(start.getTime() + 3600_000);
      const irr = irrs[i] ?? 0; // W/m2
      const kw = (irr * arr.kWp * this.efficiency) / 1000;
      entries.push({ period_start: start, period_end: end, pv_estimate: kw, source: this.name });
    }
    return entries;
  }
}
