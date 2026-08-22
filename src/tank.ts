import { Forecast } from './forecast/types';
import { ForecastProcessor } from './forecast/processor';
import { parseDuration, parseNum } from './config';

export type TankConfig = {
  litres: number;
  targetTemp: number; // end-of-day target °C
  minTemp: number; // cold-water floor for energy math (default 40)
  tankLossKwhPerDay: number; // passive loss, from midnight→08:30 55.8→50 (≈2.85)
  usageKwhPerDay: number; // hot-water draws, from 8.98 kWh cycle − loss (≈6.1)
  maxBankDeg: number; // how far above target we preheat when tomorrow looks poor
  forecastMaxAgeMs: number; // stale forecast → treated as no-data
  maxTemp: number; // thermostat ceiling (≈63-65 °C), must stay ≤65
  boilerPhaseShare: number; // fraction of total-array forecast that lands on the boiler's phase
};

export type TankPlan = {
  targetEod: number; // where we want the tank at midnight (incl. bank)
  requiredNow: number; // temperature needed now to hit targetEod by midnight (incl. bank)
  requiredNoBank: number; // temperature needed now to hit targetTemp (no bank) by midnight
  solarToday: number; // kWh still coming today (from `at` to midnight) – total array
  solarTomorrow: number; // kWh forecast for the next 24h – total array
  bankDelta: number; // °C we're preheating for tomorrow (0 unless surplus can finance it)
  bankable: boolean; // today's boiler-phase surplus can cover the full bank
  poor: boolean; // tomorrow can't cover its own need (independent of today's surplus)
  stale: boolean; // forecast missing or older than forecastMaxAgeMs
};

export function defaultTankConfig(): TankConfig {
  return {
    litres: parseNum(process.env.TANK_LITRES, 150),
    targetTemp: parseNum(process.env.TARGET_TEMP, 55),
    minTemp: parseNum(process.env.TANK_MIN_TEMP, 40),
    tankLossKwhPerDay: parseNum(process.env.TANK_LOSS_KWH_PER_DAY, 2.85),
    usageKwhPerDay: parseNum(process.env.USAGE_KWH_PER_DAY, 6.1),
    maxBankDeg: parseNum(process.env.MAX_BANK_DEG, 7),
    forecastMaxAgeMs: parseDuration(process.env.FORECAST_MAX_AGE, 6 * 3600 * 1000), // "6h"
    maxTemp: parseNum(process.env.TANK_MAX_TEMP, 63),
    boilerPhaseShare: parseNum(process.env.BOILER_PHASE_SHARE, 0.33), // boiler is 1 of 3 phases
  };
}

/**
 * Horizon planner – pure. Decides how hot the tank should be right now to
 * (a) end today at targetEod, (b) bank extra when tomorrow's solar is poor.
 */
export function planTank(
  at: Date,
  tempNow: number,
  forecast: Forecast | null,
  cfg: TankConfig
): TankPlan {
  const EPD = cfg.litres * 0.001161; // kWh per °C
  const midnight = new Date(at);
  midnight.setUTCHours(24, 0, 0, 0);

  const stale = !forecast || at.getTime() - forecast.fetchedAt.getTime() > cfg.forecastMaxAgeMs;
  const fc = stale ? null : forecast;

  const hoursToMidnight = Math.max(0, (midnight.getTime() - at.getTime()) / 3600e3);
  const lossToEod = (cfg.tankLossKwhPerDay / 24) * hoursToMidnight;

  // Whole-array forecast kWh. Only the boiler's phase share ever reaches the heater:
  // the arrays are 3 kW E + 10 kW S = 13 kWp across 3 phases, so the boiler can only
  // bank/self-consume with its phase fraction, not the whole array. `boilerShare` is
  // the default phase factor used whenever BOILER_PHASE_SHARE is unset.
  const solarToday = fc ? ForecastProcessor.calcKWh(fc, at, midnight, 0) : 0;
  const solarTomorrow = fc
    ? ForecastProcessor.calcKWh(fc, midnight, new Date(midnight.getTime() + 24 * 3600e3), 0)
    : 0;
  const boilerSolarToday = solarToday * cfg.boilerPhaseShare;
  const boilerSolarTomorrow = solarTomorrow * cfg.boilerPhaseShare;

  const needTomorrow =
    (cfg.targetTemp - cfg.minTemp) * EPD + cfg.tankLossKwhPerDay + cfg.usageKwhPerDay;

  const shortfall = fc ? Math.max(0, needTomorrow - boilerSolarTomorrow) : 0;

  // Bank only when (a) tomorrow genuinely can't cover its own need (poor), AND (b)
  // today's *remaining boiler-phase solar* can actually fund the whole bank. If today
  // can't pay for the full preheat, banking is just grid import at night / low sun, so
  // we don't bank at all. `energyToTarget` (positive when the tank is below target) is
  // what today must still spend just to finish at target; anything beyond that is the
  // surplus that exists to bank with.
  let bankDelta = 0;
  let bankable = false;
  const poor = !!fc && shortfall > 0;
  const energyToTarget = Math.max(0, (cfg.targetTemp - tempNow) * EPD + lossToEod);
  if (poor) {
    const bankTarget = Math.min(shortfall / EPD, cfg.maxBankDeg);
    const surplusToday = boilerSolarToday - energyToTarget;
    if (surplusToday >= bankTarget * EPD) {
      bankable = true;
      bankDelta = bankTarget;
    }
  }
  // thermostat caps the tank (never assume above maxTemp) – still ≥ legionella 60 °C
  const ceiling = Math.min(cfg.maxTemp, 65);
  const targetEod = Math.min(Math.max(cfg.targetTemp + bankDelta, cfg.minTemp), ceiling);

  // temp needed now to land at targetEod by midnight given remaining boiler-phase
  // solar & loss
  const requiredNow = targetEod - (boilerSolarToday - lossToEod) / EPD;
  // temp needed now to land at plain targetTemp (no bank) by midnight
  const requiredNoBank = Math.min(
    Math.max(cfg.targetTemp - (boilerSolarToday - lossToEod) / EPD, cfg.minTemp),
    ceiling
  );

  return {
    targetEod,
    requiredNow,
    requiredNoBank,
    solarToday: boilerSolarToday, // boiler-phase kWh, not whole-array
    solarTomorrow: boilerSolarTomorrow, // boiler-phase kWh, not whole-array
    bankDelta,
    bankable,
    poor,
    stale,
  };
}
