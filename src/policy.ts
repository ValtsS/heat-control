import { Forecast } from './forecast/types';
import { ForecastProcessor } from './forecast/processor';

export function estimatePowerFromForecast(forecast: Forecast | null, at: Date): number | null {
  if (!forecast) return null;
  return ForecastProcessor.calcNowKw(forecast, at);
}

/** estimate available power purely from sun elevation (no forecast, no grid) – peak sun = high power */
export function estimatePowerFromSunElevation(elevation: number): number | undefined {
  if (elevation <= 8) return undefined; // too dark – no basis to assume surplus
  // map elevation to watts so peak solar → ~max heater power; export-limited so we dump it
  return Math.min(2400, Math.max(300, elevation * 40));
}
