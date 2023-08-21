import { Database } from 'sqlite3';
import { DB, Forecast } from './db';

type ReturnedData = {
  time: number;
  json: string;
};

export class LiteDB implements DB {
  db: Database;

  constructor(filename: string) {
    this.db = new Database(filename);

    this.db.serialize(() => {
      this.db.run(`CREATE TABLE IF NOT EXISTS forecast (time integer, json text );`);
    });
  }

  Save(forecast: Forecast): boolean {
    try {
      const stmt = this.db.prepare('INSERT INTO forecast (time, json) VALUES (?,?)');
      stmt.run([forecast.time.getTime(), JSON.stringify(forecast.obj)]);
      stmt.finalize();
      return true;
    } catch (ex) {
      console.error(ex);
      return false;
    }
  }

  async Load(): Promise<Forecast | null> {
    return new Promise((resolve, reject) => {
      this.db.each('SELECT time, json FROM forecast order by time desc LIMIT 1', (err, row) => {
        if (err) reject(err);
        else {
          const data = row as ReturnedData;

          const f: Forecast = {
            time: new Date(data.time),
            obj: JSON.parse(data.json),
          };

          resolve(f);
        }
      });
    });
  }
}
