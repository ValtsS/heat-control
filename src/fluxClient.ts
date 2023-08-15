import { InfluxDB, Point, QueryApi, WriteApi } from '@influxdata/influxdb-client';

const fluxQuery = `from(bucket: "solar")
|> range(start: -3m)
 |> filter(fn: (r) => r["_measurement"] == "inverter-stats")
 |> filter(fn: (r) => r["_field"] == "active_grid_B_power_W")
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
