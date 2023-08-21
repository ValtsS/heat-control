export type Forecast = {
  time: Date;
  obj: object;
};

export interface DB {
  Save(forecast: Forecast): boolean;
  Load(): Promise<Forecast | null>;
}

export class MemoryDB implements DB {
  saved?: Date;
  data?: string;

  Save(forecast: Forecast): boolean {
    if (!this.saved || this.saved.getTime() < forecast.time.getTime()) {
      this.saved = forecast.time;
      this.data = JSON.stringify(forecast.obj);
    }

    return false;
  }
  Load(): Promise<Forecast | null> {
    if (!this.saved) return Promise.resolve(null);

    const f: Forecast = {
      obj: JSON.parse(this.data ?? ''),
      time: this.saved,
    };
    return Promise.resolve(f);
  }
}
