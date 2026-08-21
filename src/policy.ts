import { Forecast, ForecastEntry } from './forecast/types';
import { ForecastProcessor } from './forecast/processor';
import { calculateRequiredPower, DefaultSettings } from './control';

/**
 * Decision helpers that are pure and testable – used by control.ts GetStateWithForecast
 */
export function kWhRequiredToReach(
  tempNow: number,
  target: number,
  settings = DefaultSettings
): number {
  // approximate energy: heating from tempNow to target requires integral of requiredpower curve
  // For simplicity: use kWh ~ (requiredPower_at_target - requiredPower_at_now) * factor
  // Instead we reuse forecast's EstimatePwr logic: we want power threshold that would reach target today.
  // Simplified: if tempNow < target, need roughly 2-3 kWh for 40->55; we model as required power diff.
  // Use linear: 1°C ≈ 0.5 kWh (boiler ~150L). So kWh = (target - tempNow) * 0.5
  if (tempNow >= target) return 0;
  return (target - tempNow) * 0.5;
}

export function shouldDeferMorning(
  forecast: Forecast | null,
  at: Date,
  tempNow: number,
  targetTemp: number = 50
): boolean {
  if (!forecast) return false; // no data, don't defer
  // morning 05-09 UTC, if forecast says enough later, defer low-temp heating
  const hour = at.getUTCHours();
  if (hour < 5 || hour > 9) return false;
  if (tempNow >= 50) return false; // if already near target, no defer
  const needKWh = kWhRequiredToReach(tempNow, targetTemp);
  const untilEndOfDay = new Date(at);
  untilEndOfDay.setUTCHours(23, 59, 59, 999);
  const remaining = ForecastProcessor.calcKWh(forecast, at, untilEndOfDay, 0);
  // if remaining > need + 1kWh margin, we can wait for midday peak
  return remaining > needKWh + 1;
}

export function estimatePowerFromForecast(forecast: Forecast | null, at: Date): number | null {
  if (!forecast) return null;
  return ForecastProcessor.calcNowKw(forecast, at);
}
