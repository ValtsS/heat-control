// Receding-horizon solver: given current tank temp + hourly boiler-phase solar,
// picks the hour-by-hour heater schedule (binary 2.4 kW) that minimizes total grid
// import kWh over the horizon, honoring hard constraints (thermostat cap, morning
// floor). Re-solved on every /allow call (live surplus changes minute to minute).
import { TankModelConfig, epd } from './model';

export type SolveStep = {
  hour: number;
  localHour: number;
  temp: number;
  heat: boolean;
  solarKw: number;
  importKw: number;
};

export type SolveResult = {
  steps: SolveStep[];
  totalImportKwh: number;
  feasible: boolean;
};

export type MorningFloor = {
  startHour: number; // local hour (inclusive)
  endHour: number; // local hour (inclusive)
  temp: number;
};

export type LocalHourFn = (d: Date) => number;

// Discount on the future value of stored heat (0..1). 1.0 makes the solver
// indifferent between importing now and importing later (it will top up a warm tank
// all night). 0.5+ makes "import to hold target" a net loss (won't do it) while free
// surplus is still worth soaking (0 import cost, real future value). Env-tunable.
export function terminalFactor(): number {
  const v = process.env.TERMINAL_FACTOR;
  if (v === undefined) return 0.5;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0.5 : Math.max(0, Math.min(1, n));
}

const TEMP_STEP_C = 0.25;
const TEMP_LO = 20;
const TEMP_HI = 70;

export function solveHorizon(
  tempNow: number,
  solarKw: number[],
  cfg: TankModelConfig,
  heaterKw: number,
  at: Date,
  horizon: number,
  morning: MorningFloor | null,
  minAllowed = TEMP_LO,
  maxAllowed = TEMP_HI,
  getLocalHour: LocalHourFn = (d) => d.getHours()
): SolveResult {
  const H = Math.max(1, Math.min(horizon, solarKw.length));
  const lo = minAllowed;
  const hi = maxAllowed;
  const n = Math.round((hi - lo) / TEMP_STEP_C) + 1;
  const idxOf = (t: number) => Math.round((t - lo) / TEMP_STEP_C);
  const tempOf = (i: number) => lo + i * TEMP_STEP_C;
  const INF = Number.POSITIVE_INFINITY;

  const EPD = epd(cfg.litres);
  const maxTemp = Math.min(cfg.maxTemp, hi);
  const heaterDT = heaterKw / EPD; // °C per full heater-hour

  // Loss scales with tank temperature: calibration is ~2.85 kWh/day at 55 °C
  // with an ambient ~20 °C. Colder tank loses less, so the solver prefers to
  // coast rather than hold 63 °C (which a flat-loss model would do).
  const lossAt = (t: number) => Math.max(0, (cfg.tankLossKwhPerDay / 24) * ((t - 20) / (55 - 20)));

  // NOTE: usage is deliberately NOT a continuous drain. Hot water draws are discrete
  // and unpredictable (showers), so modeling USAGE_KWH_PER_DAY as an hourly leak
  // would make the tank bleed ~2°C/h constantly and force continuous reheat (the
  // 4:22-style bug). Real usage instead shows up as discrete temp drops handled by
  // the morning-floor / target margins and re-solved on the next poll.
  const usageH = 0;

  const isMorningHour = (localHour: number) =>
    morning !== null && localHour >= morning.startHour && localHour <= morning.endHour;

  // dp[i] = min import (kWh) to be at temp index i at the start of the current hour
  let dp = new Array<number>(n).fill(INF);
  dp[idxOf(Math.max(lo, Math.min(hi, tempNow)))] = 0;
  // reconstruction: per hour h, for each state j: the prev temp index, heater state,
  // and the actual heat drawn / import incurred in that transition.
  const prevIdx: number[][] = [];
  const prevU: boolean[][] = [];
  const prevHeatKw: number[][] = [];
  const prevImportKw: number[][] = [];

  for (let h = 0; h < H; h++) {
    const ndp = new Array<number>(n).fill(INF);
    prevIdx.push(new Array<number>(n).fill(-1));
    prevU.push(new Array<boolean>(n).fill(false));
    prevHeatKw.push(new Array<number>(n).fill(0));
    prevImportKw.push(new Array<number>(n).fill(0));
    const solar = Math.max(0, solarKw[h] ?? 0);
    const hourStart = new Date(at.getTime() + h * 3600e3);
    const nextLocal = getLocalHour(new Date(hourStart.getTime() + 3600e3));
    const mustHoldMorning = isMorningHour(nextLocal) && morning !== null;

    for (let i = 0; i < n; i++) {
      const d = dp[i];
      if (!isFinite(d)) continue;
      const t0 = tempOf(i);

      for (const u of [false, true]) {
        let t1: number;
        let heatKwH = 0;
        let importKw = 0;
        if (u) {
          if (t0 >= maxTemp - 1e-9) continue; // thermostat open – no capacity to add heat
          const tPeak = Math.min(maxTemp, t0 + heaterDT);
          const lossAvg = (lossAt(t0) + lossAt(tPeak)) / 2;
          t1 = Math.max(lo, tPeak - (lossAvg + usageH) / EPD);
          heatKwH = (tPeak - t0) * EPD; // heat drawn by the element (kWh)
          importKw = Math.max(0, heatKwH - solar);
        } else {
          t1 = Math.max(lo, t0 - (lossAt(t0) + usageH) / EPD);
        }
        if (mustHoldMorning && tempOf(idxOf(t1)) < morning!.temp - 1e-9) continue;
        const j = idxOf(Math.max(lo, Math.min(hi, t1)));
        const nc = d + importKw;
        if (nc < ndp[j]) {
          ndp[j] = nc;
          prevIdx[h][j] = i;
          prevU[h][j] = u;
          prevHeatKw[h][j] = heatKwH;
          prevImportKw[h][j] = importKw;
        }
      }
    }
    dp = ndp;
  }

  let best = INF;
  let bestI = -1;
  // Terminal value: the tank should end the horizon able to meet its hard floors
  // (morning guarantee; fall back to the operating minTemp). We deliberately do NOT
  // target targetTemp (55): importing just to hold a warm tank at 55 all day is the
  // "night banking" waste the user rejected. Free surplus raises the tank above the
  // floor for free, which the optimizer still captures via 0-cost heat.
  const floorTarget = morning ? morning.temp : cfg.minTemp;
  const terminalCost = (i: number) =>
    terminalFactor() * Math.max(0, (floorTarget - tempOf(i)) * epd(cfg.litres));
  for (let i = 0; i < n; i++) {
    if (!isFinite(dp[i])) continue;
    const total = dp[i] + terminalCost(i);
    if (total < best) {
      best = total;
      bestI = i;
    }
  }
  if (bestI < 0) return { steps: [], totalImportKwh: 0, feasible: false };

  // reconstruct backward through the parent pointers
  const temps: number[] = new Array(H + 1).fill(0);
  const heats: boolean[] = new Array(H).fill(false);
  const heatKw: number[] = new Array(H).fill(0);
  const imports: number[] = new Array(H).fill(0);
  temps[H] = tempOf(bestI);
  for (let h = H - 1; h >= 0; h--) {
    const j = idxOf(temps[h + 1]);
    const pi = prevIdx[h][j];
    if (pi < 0) break;
    heats[h] = prevU[h][j];
    heatKw[h] = prevHeatKw[h][j];
    imports[h] = prevImportKw[h][j];
    temps[h] = tempOf(pi);
  }

  const steps: SolveStep[] = [];
  let importSum = 0;
  for (let h = 0; h < H; h++) {
    const solar = Math.max(0, solarKw[h] ?? 0);
    importSum += imports[h];
    steps.push({
      hour: h,
      localHour: getLocalHour(new Date(at.getTime() + h * 3600e3)),
      temp: temps[h],
      heat: heats[h],
      solarKw: solar,
      importKw: imports[h],
    });
  }

  return { steps, totalImportKwh: importSum, feasible: true };
}
