// Builds the hourly inputs the MPC solver consumes from the forecast.
import { Forecast } from '../forecast/types';
import { ForecastProcessor } from '../forecast/processor';
import { TankModelConfig, stepTemp } from './model';

/** Hourly boiler-phase solar surplus (kW) over `hours` starting at `at`.
 *  Hour 0 is overridden with `liveKw` (actual phase reading) when available. */
export function solarProfile(
  forecast: Forecast,
  at: Date,
  hours: number,
  boilerPhaseShare: number,
  liveKw: number | undefined
): number[] {
  const out: number[] = [];
  for (let h = 0; h < hours; h++) {
    const from = new Date(at.getTime() + h * 3600e3);
    const to = new Date(from.getTime() + 3600e3);
    // calcKWh returns kWh over [from,to) above 0 threshold; 1h → ≈avg kW × share
    const kwh = ForecastProcessor.calcKWh(forecast, from, to, 0) * boilerPhaseShare;
    out.push(h === 0 && liveKw !== undefined ? Math.max(0, liveKw) : kwh);
  }
  return out;
}

/** Hourly usage + loss draw on the tank (kWh), flat per hour. */
export function baselineDraw(cfg: TankModelConfig): number {
  return (cfg.tankLossKwhPerDay + cfg.usageKwhPerDay) / 24;
}

export { stepTemp };
