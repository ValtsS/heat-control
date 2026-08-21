import { InfluxDB, Point, QueryApi, WriteApi } from '@influxdata/influxdb-client';
import { parseDuration } from './config';

// configurable Influx source (defaults to the actual on-grid reading used)
const INFLUX_BUCKET = process.env.INFLUX_BUCKET ?? 'solar';
const INFLUX_MEASUREMENT = process.env.INFLUX_MEASUREMENT ?? 'inverter-stats';
// net surplus on the boiler's phase (W) – positive=export, negative=import
const INFLUX_FIELD = process.env.INFLUX_FIELD ?? 'active_grid_B_power_W';
const INFLUX_RANGE = parseDuration(process.env.INFLUX_RANGE, 3 * 60 * 1000); // "3m"

const fluxQuery = `from(bucket: "${INFLUX_BUCKET}")
|> range(start: -${INFLUX_RANGE}ms)
 |> filter(fn: (r) => r["_measurement"] == "${INFLUX_MEASUREMENT}")
 |> filter(fn: (r) => r["_field"] == "${INFLUX_FIELD}")
 |> yield(name: "last")`;

const BOILER_BUCKET = 'Boiler';

type PowerResult = {
  _time: string;
  _value: number;
};

export class FluxClient {
  queryClient: QueryApi;
  writeClient: WriteApi;

  constructor(url: string, token: string, org: string) {
    const client = new InfluxDB({ url, token });
    this.queryClient = client.getQueryApi(org);
    this.writeClient = client.getWriteApi(org, BOILER_BUCKET, 'ns');
  }

  async getPower(): Promise<number | undefined> {
    const data = (await this.queryClient.collectRows(fluxQuery)) as PowerResult[];

    if (data && data.length > 0) {
      return data[data.length - 1]._value;
    }
  }

  recordStats(temperature: number, availpower: number, heatIsOn: boolean) {
    const point = new Point('Heater')
      .floatField('Temperature', temperature)
      .floatField('W_avail', availpower)
      .booleanField('HeatOn', heatIsOn);

    this.writeClient.writePoint(point);
  }
}
