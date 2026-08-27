// MPC planner: the single decision point for "heat now or defer?".
// Re-solved on every /allow call. Hard constraints (legionella, morning floor)
// short-circuit the optimizer; otherwise the solver picks the cheapest schedule.
import { Forecast } from '../forecast/types';
import { TankModelConfig } from './model';
import { solarProfile } from './profile';
import { solveHorizon, SolveResult, MorningFloor } from './solver';
import { parseDuration, parseNum } from '../config';

export type SchedulePlan = {
  heat: boolean;
  reason:
    | 'legionella'
    | 'morning-floor'
    | 'free-surplus'
    | 'import'
    | 'defer'
    | 'off'
    | 'no-forecast';
  schedule: SolveResult;
  solarToday: number; // boiler-phase kWh remaining today
  solarTomorrow: number; // boiler-phase kWh next 24h
};

export type PlannerConfig = {
  model: TankModelConfig;
  heaterKw: number;
  boilerPhaseShare: number;
  horizonHours: number;
  morning: MorningFloor | null;
  forecastMaxAgeMs: number;
};

export function defaultPlannerConfig(): PlannerConfig {
  const litres = parseNum(process.env.TANK_LITRES, 150);
  return {
    model: {
      litres,
      heaterKw: parseNum(process.env.HEATER_WATTS, 2496) / 1000,
      tankLossKwhPerDay: parseNum(process.env.TANK_LOSS_KWH_PER_DAY, 2.85),
      usageKwhPerDay: parseNum(process.env.USAGE_KWH_PER_DAY, 6.1),
      minTemp: parseNum(process.env.TANK_MIN_TEMP, 40),
      maxTemp: Math.min(parseNum(process.env.TANK_MAX_TEMP, 63), 65),
      targetTemp: parseNum(process.env.TARGET_TEMP, 55),
    },
    heaterKw: parseNum(process.env.HEATER_WATTS, 2496) / 1000,
    boilerPhaseShare: parseNum(process.env.BOILER_PHASE_SHARE, 0.33),
    horizonHours: parseNum(process.env.MPC_HORIZON_HOURS, 24),
    morning: {
      startHour: parseIntValSafe(process.env.MORNING_START_HOUR, 6),
      endHour: parseIntValSafe(process.env.MORNING_END_HOUR, 10),
      temp: parseNum(process.env.MORNING_TEMP, 40),
    },
    forecastMaxAgeMs: parseDuration(process.env.FORECAST_MAX_AGE, 6 * 3600 * 1000),
  };
}

export function planSchedule(
  at: Date,
  tempNow: number,
  livePowerKw: number | undefined,
  forecast: Forecast | null,
  legionellaForced: boolean,
  cfg: PlannerConfig,
  getLocalHour: (d: Date) => number = (d) => d.getHours(),
  heaterOn: boolean = false
): SchedulePlan {
  const stale = !forecast || at.getTime() - forecast.fetchedAt.getTime() > cfg.forecastMaxAgeMs;
  const fc = stale ? null : forecast;
  const morning = cfg.morning;

  // Hard constraint 1: legionella – must heat, draw grid if needed
  if (legionellaForced) {
    return {
      heat: true,
      reason: 'legionella',
      schedule: emptySolve(),
      solarToday: 0,
      solarTomorrow: 0,
    };
  }

  // Hard constraint 2: morning guarantee – if it's the morning window and tank is
  // below the floor, heat now (may import). Same rule as before, kept as a floor.
  const hourLocal = getLocalHour(at);
  const inMorning = morning && hourLocal >= morning.startHour && hourLocal <= morning.endHour;
  if (inMorning && tempNow < morning!.temp) {
    return {
      heat: true,
      reason: 'morning-floor',
      schedule: emptySolve(),
      solarToday: 0,
      solarTomorrow: 0,
    };
  }

  if (!fc) {
    // No/stale forecast → caller falls back to sun-gate / planTank
    return {
      heat: false,
      reason: 'no-forecast',
      schedule: emptySolve(),
      solarToday: 0,
      solarTomorrow: 0,
    };
  }

  // Free surplus fast-path: if the boiler's phase is exporting at least a full heater
  // load right now, soak it into the tank (up to the thermostat cap). This captures
  // energy that would otherwise be lost to export, regardless of what the horizon
  // optimizer says.
  //
  // The live reading `active_grid_B_power_W` is the surplus AFTER the heater's own
  // draw. When the heater is ON it pulls ~heaterKw, so the reading reads low even
  // though the true surplus is large. We therefore reconstruct the heater-OFF surplus
  // by adding the heater's draw back when the relay (`heatOn`) says the element is
  // actually drawing. Without this the gate flips on/off every poll: ON pulls the
  // reading under threshold → OFF → surplus returns → ON (15s chatter).
  const baseSurplusKw =
    livePowerKw !== undefined ? livePowerKw + (heaterOn ? cfg.heaterKw : 0) : undefined;
  if (baseSurplusKw !== undefined && baseSurplusKw >= cfg.heaterKw - 1e-9) {
    const canAbsorb = tempNow < cfg.model.maxTemp - 1e-9;
    if (canAbsorb) {
      return {
        heat: true,
        reason: 'free-surplus',
        schedule: emptySolve(),
        solarToday: 0,
        solarTomorrow: 0,
      };
    }
  }

  const solar = solarProfile(fc, at, cfg.horizonHours, cfg.boilerPhaseShare, baseSurplusKw);
  const res = solveHorizon(
    tempNow,
    solar,
    cfg.model,
    cfg.heaterKw,
    at,
    cfg.horizonHours,
    morning,
    undefined,
    undefined,
    getLocalHour
  );

  if (!res.feasible) {
    return {
      heat: false,
      reason: 'off',
      schedule: emptySolve(),
      solarToday: 0,
      solarTomorrow: 0,
    };
  }

  const first = res.steps[0];
  const heat = first.heat;
  const reason: SchedulePlan['reason'] = !heat
    ? 'defer'
    : first.solarKw >= cfg.heaterKw - 1e-9
    ? 'free-surplus'
    : 'import';

  const midnight = new Date(at);
  midnight.setUTCHours(24, 0, 0, 0);
  const solarToday = solar
    .filter((_, i) => {
      const hStart = new Date(at.getTime() + i * 3600e3);
      return hStart < midnight;
    })
    .reduce((a, b) => a + b, 0);
  const solarTomorrow = solar
    .filter((_, i) => {
      const hStart = new Date(at.getTime() + i * 3600e3);
      return hStart >= midnight && hStart < new Date(midnight.getTime() + 24 * 3600e3);
    })
    .reduce((a, b) => a + b, 0);

  return { heat, reason, schedule: res, solarToday, solarTomorrow };
}

function emptySolve(): SolveResult {
  return { steps: [], totalImportKwh: 0, feasible: false };
}

function parseIntValSafe(v: string | undefined, d: number): number {
  const n = parseInt(v ?? '', 10);
  return isNaN(n) ? d : n;
}
