import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import { FluxClient } from './fluxClient';

dotenv.config();

const app: Express = express();
const port = process.env.PORT;

if (!process.env.INFLUX_URL)
  throw new Error('Missing INFLUX_URL');

if (!process.env.INFLUX_TOKEN)
  throw new Error('Missing INFLUX_TOKEN');

if (!process.env.ORG)
  throw new Error('Missing ORG');

const flux = new FluxClient(process.env.INFLUX_URL, process.env.INFLUX_TOKEN, process.env.ORG);

app.get('/', async (req: Request, res: Response) => {
  res.send('/power to read available power');

});

app.get('/power', async (req: Request, res: Response) => {
  var power = await flux.getPower();
  res.send((power?? 0).toString());
});


app.listen(port, () => {
  console.log(`⚡️[server]: Heat control is running at http://localhost:${port}`);
});