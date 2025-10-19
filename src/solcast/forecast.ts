export type ForecastEntry = {
  pv_estimate: number;
  period: string;
  period_end: string;
  period_start_date: Date;
  period_end_date: Date;
};

export type Forecast = {
  forecasts: ForecastEntry[];
};

export class ForecastProcessor {
  private static Sort(forecast: Forecast) {
    forecast.forecasts.sort((a, b) => {
      const aTime = a.period_end_date.getTime();
      const bTime = b.period_end_date.getTime();
      if (aTime < bTime) {
        return -1;
      }
      if (aTime > bTime) {
        return 1;
      }
      return 0;
    });
  }
  private static overlapMinutes(a0: Date, a1: Date, b0: Date, b1: Date): number {
    if (Math.max(a0.getTime(), a1.getTime()) <= Math.min(b0.getTime(), b1.getTime())) return 0;

    if (Math.min(a0.getTime(), a1.getTime()) >= Math.max(b0.getTime(), b1.getTime())) return 0;

    let intersect = [a0.getTime(), a1.getTime(), b0.getTime(), b1.getTime()];
    intersect.sort((a, b) => a - b);

    const delta = (intersect[2] - intersect[1]) / (1000.0 * 60);
    return delta;
  }

  public static CalckWh(forecast: Forecast, from: Date, to: Date, thresholdKw: number): number {
    let result = 0.0;
    forecast.forecasts.forEach((f) => {
      let hours = this.overlapMinutes(from, to, f.period_start_date, f.period_end_date) / 60.0;
      let remaining = Math.max(0, f.pv_estimate - thresholdKw);
      result += hours * remaining;
    });
    return result;
  }

  public static EstimatePwr(forecast: Forecast, from: Date, to: Date, RequiredkWh: number): number {
    let l = 0.0;
    let r = 1000.0;

    while (l < r) {
      let m = l + (r - l) / 2.0;

      if (this.CalckWh(forecast, from, to, m) <= RequiredkWh) r = m;
      else l = m + 0.01;
    }

    return l;
  }

  public static ParseJson(json: string): Forecast {
    const data = JSON.parse(json) as Forecast;
    this.Initialize(data);
    return data;
  }

  private static Initialize(data: Forecast) {
    data.forecasts.forEach((f) => {
      if (!f.period_end_date) f.period_end_date = new Date(f.period_end);
      if (!f.period_start_date) {
        if (f.period !== 'PT30M') throw new Error(`${f.period} is an unknown period`);

        f.period_start_date = new Date(f.period_end_date);
        f.period_start_date.setMinutes(f.period_end_date.getMinutes() - 30);
      }

      const checkDelta =
        (f.period_end_date.getTime() - f.period_start_date.getTime()) / (1000.0 * 60);
      if (checkDelta > 30 || checkDelta < 0)
        throw new Error(`Logic error calculate delta is {checkDelta}`);
    });
    this.Sort(data);
  }
}
