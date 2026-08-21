import { ForecastStore } from './forecast/cache';

export const LEGIONELLA_TEMP = parseInt(process.env.LEGIONELLA_TEMP ?? '60', 10);
export const LEGIONELLA_INTERVAL_MS = parseInt(
  process.env.LEGIONELLA_INTERVAL_MS ?? `${7 * 24 * 3600 * 1000}`,
  10
);
export const LEGIONELLA_MIN_DURATION_MS = 20 * 60 * 1000; // 20 min above temp counts as hot

export class LegionellaService {
  constructor(private store: ForecastStore) {}

  async needsForcedHeat(now: Date = new Date()): Promise<boolean> {
    const last = await this.store.lastHot();
    if (!last) return true; // never reached temp – force
    return now.getTime() - last.getTime() > LEGIONELLA_INTERVAL_MS;
  }

  // call when we observe T > LEGIONELLA_TEMP while heating, with duration check handled by caller
  async recordIfHot(temperature: number, at: Date = new Date()): Promise<void> {
    if (temperature >= LEGIONELLA_TEMP) {
      await this.store.saveHot(at);
    }
  }

  // daily 40C guarantee – separate from legionella, but tracked similarly as "daily hot"
  // We keep it simple: if T <40 in morning window, allow forced heat even if forecast says defer
  static needsDaily40C(temperature: number, at: Date = new Date()): boolean {
    const hour = at.getHours(); // local time – for fallback we use UTC hour; caller should pass correct
    // morning 06-10 local, need at least 40C
    if (temperature < 40 && hour >= 6 && hour <= 10) return true;
    return false;
  }
}
