import { TestForecast, TestForecastTiny } from '../../specs/test-forecast';
import { ForecastProcessor } from './forecast';

describe('Forecast', () => {
  it('Should parse the json', async () => {
    const raw = ForecastProcessor.ParseJson(TestForecastTiny);

    expect(raw.forecasts[0].pv_estimate).toBeCloseTo(0.6275);
    expect(raw.forecasts[1].pv_estimate).toBeCloseTo(1.33);

    expect(raw.forecasts[0].period_start_date.getUTCHours()).toBe(10);
    expect(raw.forecasts[0].period_start_date.getUTCMinutes()).toBe(30);

    expect(raw.forecasts[1].period_start_date.getUTCHours()).toBe(11);
    expect(raw.forecasts[1].period_start_date.getUTCMinutes()).toBe(0);
  });

  it('Should calc avail kWh', async () => {
    const raw = ForecastProcessor.ParseJson(TestForecast);
    let result = ForecastProcessor.CalckWh(
      raw,
      raw.forecasts[0].period_start_date,
      raw.forecasts[raw.forecasts.length - 1].period_end_date,
      0
    );
    expect(result).toBeCloseTo(52.58);
  });

  it('Estimate kW', async () => {
    const raw = ForecastProcessor.ParseJson(TestForecast);
    const kW = ForecastProcessor.EstimatePwr(
      raw,
      raw.forecasts[0].period_start_date,
      raw.forecasts[raw.forecasts.length - 1].period_end_date,
      10
    );
    expect(kW).toBeCloseTo(5.36);
  });
});
