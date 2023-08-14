import { InfluxDB, QueryApi } from '@influxdata/influxdb-client';

const fluxQuery = `from(bucket: "solar")
|> range(start: -3m)
 |> filter(fn: (r) => r["_measurement"] == "inverter-stats")
 |> filter(fn: (r) => r["_field"] == "active_grid_B_power_W")
 |> yield(name: "last")`;

type PowerResult = {
  _time: string;
  _value: number;
};

export class FluxClient {
  queryClient: QueryApi;

  constructor(url: string, token: string, org: string) {
    const client = new InfluxDB({ url, token });
    this.queryClient = client.getQueryApi(org);
  }

  async getPower(): Promise<number | undefined> {
    const data = (await this.queryClient.collectRows(fluxQuery)) as PowerResult[];

    if (data && data.length > 0) {
      return data[data.length - 1]._value;
    }

    return;
  }
}
