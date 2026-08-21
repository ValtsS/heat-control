import { Forecast } from './types';

export class ForecastProcessor {
  private static overlapMinutes(a0: Date, a1: Date, b0: Date, b1: Date): number {
    if (Math.max(a0.getTime(), a1.getTime()) <= Math.min(b0.getTime(), b1.getTime())) return 0;
    if (Math.min(a0.getTime(), a1.getTime()) >= Math.max(b0.getTime(), b1.getTime())) return 0;
    const intersect = [a0.getTime(), a1.getTime(), b0.getTime(), b1.getTime()].sort(
      (a, b) => a - b
    );
    const delta = (intersect[2] - intersect[1]) / (1000 * 60);
    return delta;
  }

  /** kWh available in [from,to) above thresholdKw */
  public static calcKWh(forecast: Forecast, from: Date, to: Date, thresholdKw: number): number {
    let result = 0;
    for (const f of forecast.forecasts) {
      const hours = this.overlapMinutes(from, to, f.period_start, f.period_end) / 60;
      const remaining = Math.max(0, f.pv_estimate - thresholdKw);
      result += hours * remaining;
    }
    return result;
  }

  /** estimate max power threshold such that kWh > required is still met (binary search like master) */
  public static estimatePower(
    forecast: Forecast,
    from: Date,
    to: Date,
    requiredKWh: number
  ): number {
    let l = 0;
    let r = 1000;
    while (l < r) {
      const m = l + (r - l) / 2;
      if (this.calcKWh(forecast, from, to, m) <= requiredKWh) r = m;
      else l = m + 0.01;
    }
    return l;
  }

  public static calcNowKw(forecast: Forecast, at: Date = new Date()): number {
    const entry = forecast.forecasts.find((f) => f.period_start <= at && at < f.period_end);
    return entry ? entry.pv_estimate : 0;
  }
}
