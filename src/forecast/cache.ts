import { Forecast } from './types';
import { Database } from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export type Sample = {
  at: Date;
  temp: number;
  power: number;
  heatOn: boolean;
};

export type DecisionLog = {
  at: Date;
  temp: number;
  livePower: number; // W on boiler phase (actual)
  heatCmd: boolean; // commanded heater
  heatOn: boolean; // relay: actual power reaching the element
  reason: string;
  importKwh: number;
  nextFreeHours: number; // hours until the schedule first heats (0 = heating now)
  solarToday: number;
  solarTomorrow: number;
};

export interface ForecastStore {
  save(forecast: Forecast): Promise<void>;
  load(): Promise<Forecast | null>;
  lastHot(): Promise<Date | null>;
  saveHot(at: Date): Promise<void>;
  saveSample(s: Sample): Promise<void>;
  lastSample(): Promise<Sample | null>;
  appendDecision(d: DecisionLog): Promise<void>;
  recentDecisions(limit: number, from?: Date, to?: Date): Promise<DecisionLog[]>;
}

type Row = { time: number; json: string };

export class SqliteForecastStore implements ForecastStore {
  private db: Database;
  private ready: Promise<void>;

  constructor(private filename: string) {
    // ensure dir exists
    const dir = path.dirname(filename);
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(filename);
    this.ready = new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(
          `CREATE TABLE IF NOT EXISTS forecast (time INTEGER PRIMARY KEY, json TEXT, provider TEXT)`,
          (e) => {
            if (e) return reject(e);
            this.db.run(
              `CREATE TABLE IF NOT EXISTS legionella (id INTEGER PRIMARY KEY CHECK (id=1), last_hot INTEGER)`,
              (e2) => {
                if (e2) return reject(e2);
                this.db.run(
                  `CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY CHECK (id=1), at INTEGER, temp REAL, power REAL, heat_on INTEGER)`,
                  (e3) => {
                    if (e3) return reject(e3);
                    this.db.run(
                      `CREATE TABLE IF NOT EXISTS decisions (
                        at INTEGER, temp REAL, live_power REAL, heat_cmd INTEGER,
                        heat_on INTEGER, reason TEXT, import_kwh REAL,
                        next_free_hours INTEGER, solar_today REAL, solar_tomorrow REAL
                      )`,
                      (e4) => (e4 ? reject(e4) : resolve())
                    );
                  }
                );
              }
            );
          }
        );
      });
    });
  }

  async save(forecast: Forecast): Promise<void> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const json = JSON.stringify(forecast);
      const time = forecast.fetchedAt.getTime();
      this.db.run(
        `INSERT OR REPLACE INTO forecast (time, json, provider) VALUES (?,?,?)`,
        [time, json, forecast.provider],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async load(): Promise<Forecast | null> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT time, json FROM forecast ORDER BY time DESC LIMIT 1`,
        (err, row: Row | undefined) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          try {
            const parsed = JSON.parse(row.json) as Forecast;
            // revive dates
            parsed.fetchedAt = new Date(parsed.fetchedAt);
            parsed.forecasts = parsed.forecasts.map((f) => ({
              ...f,
              period_start: new Date(f.period_start),
              period_end: new Date(f.period_end),
            }));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }

  async lastHot(): Promise<Date | null> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT last_hot as last_hot FROM legionella WHERE id=1`, (err, row) => {
        if (err) return reject(err);
        if (!row || (row as { last_hot: number | null }).last_hot == null) return resolve(null);
        resolve(new Date((row as { last_hot: number }).last_hot));
      });
    });
  }

  async saveHot(at: Date): Promise<void> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO legionella (id, last_hot) VALUES (1, ?)`,
        [at.getTime()],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async saveSample(s: Sample): Promise<void> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO stats (id, at, temp, power, heat_on) VALUES (1, ?, ?, ?, ?)`,
        [s.at.getTime(), s.temp, s.power, s.heatOn ? 1 : 0],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async lastSample(): Promise<Sample | null> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT at, temp, power, heat_on FROM stats WHERE id=1`, (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        const r = row as { at: number; temp: number; power: number; heat_on: number };
        resolve({
          at: new Date(r.at),
          temp: r.temp,
          power: r.power,
          heatOn: r.heat_on === 1,
        });
      });
    });
  }

  async appendDecision(d: DecisionLog): Promise<void> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO decisions (at, temp, live_power, heat_cmd, heat_on, reason, import_kwh, next_free_hours, solar_today, solar_tomorrow) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          d.at.getTime(),
          d.temp,
          d.livePower,
          d.heatCmd ? 1 : 0,
          d.heatOn ? 1 : 0,
          d.reason,
          d.importKwh,
          d.nextFreeHours,
          d.solarToday,
          d.solarTomorrow,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async recentDecisions(limit: number, from?: Date, to?: Date): Promise<DecisionLog[]> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const conds: string[] = [];
      const params: number[] = [];
      if (from) {
        conds.push('at >= ?');
        params.push(from.getTime());
      }
      if (to) {
        conds.push('at <= ?');
        params.push(to.getTime());
      }
      const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
      params.push(limit);
      this.db.all(
        `SELECT at, temp, live_power, heat_cmd, heat_on, reason, import_kwh, next_free_hours, solar_today, solar_tomorrow FROM decisions${where} ORDER BY at DESC LIMIT ?`,
        params,
        (err, rows) => {
          if (err) return reject(err);
          const r = rows as {
            at: number;
            temp: number;
            live_power: number;
            heat_cmd: number;
            heat_on: number;
            reason: string;
            import_kwh: number;
            next_free_hours: number;
            solar_today: number;
            solar_tomorrow: number;
          }[];
          resolve(
            r.map((x) => ({
              at: new Date(x.at),
              temp: x.temp,
              livePower: x.live_power,
              heatCmd: x.heat_cmd === 1,
              heatOn: x.heat_on === 1,
              reason: x.reason,
              importKwh: x.import_kwh,
              nextFreeHours: x.next_free_hours,
              solarToday: x.solar_today,
              solarTomorrow: x.solar_tomorrow,
            }))
          );
        }
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.db.close((e) => (e ? reject(e) : resolve())));
  }
}

export class MemoryForecastStore implements ForecastStore {
  private forecast: Forecast | null = null;
  private hot: Date | null = null;
  private sample: Sample | null = null;
  private decisions: DecisionLog[] = [];
  async save(f: Forecast): Promise<void> {
    this.forecast = f;
  }
  async load(): Promise<Forecast | null> {
    return this.forecast;
  }
  async lastHot(): Promise<Date | null> {
    return this.hot;
  }
  async saveHot(at: Date): Promise<void> {
    this.hot = at;
  }
  async saveSample(s: Sample): Promise<void> {
    this.sample = s;
  }
  async lastSample(): Promise<Sample | null> {
    return this.sample;
  }
  async appendDecision(d: DecisionLog): Promise<void> {
    this.decisions.push(d);
    if (this.decisions.length > 5000) this.decisions.splice(0, this.decisions.length - 5000);
  }
  async recentDecisions(limit: number, from?: Date, to?: Date): Promise<DecisionLog[]> {
    const fromMs = from ? from.getTime() : -Infinity;
    const toMs = to ? to.getTime() : Infinity;
    return this.decisions
      .filter((d) => d.at.getTime() >= fromMs && d.at.getTime() <= toMs)
      .slice(-limit)
      .reverse();
  }
}
