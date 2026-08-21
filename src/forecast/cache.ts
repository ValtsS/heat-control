import { Forecast } from './types';
import { Database } from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface ForecastStore {
  save(forecast: Forecast): Promise<void>;
  load(): Promise<Forecast | null>;
  lastHot(): Promise<Date | null>;
  saveHot(at: Date): Promise<void>;
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
            if (e) reject(e);
            else
              this.db.run(
                `CREATE TABLE IF NOT EXISTS legionella (id INTEGER PRIMARY KEY CHECK (id=1), last_hot INTEGER)`,
                (e2) => {
                  if (e2) reject(e2);
                  else resolve();
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
      this.db.get(`SELECT last_hot as last_hot FROM legionella WHERE id=1`, (err, row: any) => {
        if (err) return reject(err);
        if (!row || row.last_hot == null) return resolve(null);
        resolve(new Date(row.last_hot));
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

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.db.close((e) => (e ? reject(e) : resolve())));
  }
}

export class MemoryForecastStore implements ForecastStore {
  private forecast: Forecast | null = null;
  private hot: Date | null = null;
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
}
