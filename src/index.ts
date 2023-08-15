import dotenv from 'dotenv';
import express, { Express, Request, Response } from 'express';
import { GetState } from './control';
import { FluxClient } from './fluxClient';

type AllowParams = {
  lastState: string;
  temp: string;
  relay: string;
};

dotenv.config();

const app: Express = express();
const port = process.env.PORT;

if (!process.env.INFLUX_URL) throw new Error('Missing INFLUX_URL');

if (!process.env.INFLUX_TOKEN) throw new Error('Missing INFLUX_TOKEN');

if (!process.env.ORG) throw new Error('Missing ORG');

const flux = new FluxClient(process.env.INFLUX_URL, process.env.INFLUX_TOKEN, process.env.ORG);

app.get('/', (req: Request, res: Response) => {
  res.send(`/power to read available power<br/>
  /allow?temp=12.2 get permission to heat\n`);
});

app.get('/power', async (req: Request, res: Response) => {
  const power = await flux.getPower();
  res.status(200).send((power ?? 0).toString());
});

app.get('/allow', async (req: Request, res: Response) => {
  console.log(req.query);
  const params = req.query as AllowParams;

  const power = await flux.getPower();

  const heatIsOn = params.relay == '1';
  const T = parseFloat(params.temp);

  if (GetState(power ?? 0, T, heatIsOn)) res.send('HEATON\n').end();
  else res.send('HEAToff\n').end();

  flux.recordStats(T, power ?? 0, heatIsOn);
});

app.listen(port, () => {
  console.log(`⚡️[server]: Heat control is running at http://localhost:${port}`);
});
