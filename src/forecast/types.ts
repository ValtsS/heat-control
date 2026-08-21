export type ForecastEntry = {
  period_start: Date;
  period_end: Date;
  pv_estimate: number; // kW average over period
  // optional per-provider raw values
  source?: string;
};

export type Forecast = {
  forecasts: ForecastEntry[];
  fetchedAt: Date;
  provider: string;
};

export interface ForecastProvider {
  name: string;
  fetchForecast(): Promise<Forecast>;
  isConfigured(): boolean;
}

export type PvArrayConfig = {
  kWp: number;
  tilt: number;
  azimuth: number; // 0=S, -90=E, 90=W
};

export function parsePvArrays(envVal: string | undefined): PvArrayConfig[] {
  if (!envVal) {
    // default: 3kWp E 35°, 10kWp S 45° per user request #5
    return [
      { kWp: 3, tilt: 35, azimuth: -90 },
      { kWp: 10, tilt: 45, azimuth: 0 },
    ];
  }
  try {
    const parsed = JSON.parse(envVal);
    if (Array.isArray(parsed)) return parsed as PvArrayConfig[];
  } catch {
    // fallthrough
  }
  throw new Error(`Invalid PV_ARRAYS json: ${envVal}`);
}
