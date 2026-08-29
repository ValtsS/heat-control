import dotenv from 'dotenv';
import express, { Express, Request, Response } from 'express';
import { GetStateWithForecast, getControlStateForTest, getLastPlanForTest } from './control';
import { planTank, defaultTankConfig } from './tank';
import { defaultPlannerConfig, planSchedule } from './energy/planner';
import { FluxClient } from './fluxClient';
import { OpenMeteoProvider } from './forecast/openMeteoProvider';
import { SolcastProvider } from './forecast/solcastProvider';
import { SqliteForecastStore, MemoryForecastStore, ForecastStore } from './forecast/cache';
import { ForecastScheduler } from './forecast/scheduler';
import { LegionellaService } from './legionella';
import { PowerService } from './power';
import { ForecastProcessor } from './forecast/processor';

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

// forecast setup – generic pluggable provider
const FORECAST_PROVIDER = (process.env.FORECAST_PROVIDER ?? '').toLowerCase();
let provider: import('./forecast/types').ForecastProvider;
if (FORECAST_PROVIDER === 'solcast') provider = new SolcastProvider();
else if (FORECAST_PROVIDER === 'open-meteo' || FORECAST_PROVIDER === 'openmeteo')
  provider = new OpenMeteoProvider();
else {
  // auto: solcast if configured, else open-meteo (free, no key)
  const sol = new SolcastProvider();
  provider = sol.isConfigured() ? sol : new OpenMeteoProvider();
}

let forecastStore: ForecastStore;
const sqlitePath = process.env.FORECAST_SQLITE ?? process.env.SQLITE_PATH ?? './data/heat.db';
try {
  // try sqlite – if fails (e.g. no native build) fallback to memory
  forecastStore = new SqliteForecastStore(sqlitePath);
} catch (e) {
  console.error('Failed to init sqlite store, falling back to memory', e);
  forecastStore = new MemoryForecastStore();
}

const scheduler = new ForecastScheduler(provider, forecastStore);
scheduler.start().catch((e) => console.error('scheduler start failed', e));

const legionella = new LegionellaService(forecastStore);
const powerService = new PowerService(flux, () => forecastStore.load());

app.get('/', (req: Request, res: Response) => {
  res.send(`/power to read available power<br/>
  /allow?temp=12.2 get permission to heat<br/>
  /forecast to see cached forecast<br/>
  /debug to see the full decision snapshot<br/>`);
});

app.get('/power', async (req: Request, res: Response) => {
  const { power } = await powerService.getAvailablePower();
  res.status(200).send((power ?? 0).toString());
});

app.get('/forecast', async (_req: Request, res: Response) => {
  const f = await forecastStore.load();
  if (!f) return res.status(404).send('no forecast yet');
  res.json({ provider: f.provider, fetchedAt: f.fetchedAt, forecasts: f.forecasts.slice(0, 48) });
});

app.get('/logs', async (req: Request, res: Response) => {
  const limitRaw = parseInt(req.query.limit as string, 10);
  // cap high enough for a full day of 5s polls (~17k rows); 0/absent → 200
  const limit = isNaN(limitRaw) ? 200 : Math.max(1, Math.min(limitRaw, 20000));
  const from = req.query.from ? new Date(req.query.from as string) : undefined;
  const to = req.query.to ? new Date(req.query.to as string) : undefined;
  const logs = await forecastStore.recentDecisions(
    limit,
    isNaN(from ? from.getTime() : NaN) ? undefined : from,
    isNaN(to ? to.getTime() : NaN) ? undefined : to
  );
  res.json({ count: logs.length, logs });
});

// debug/stats snapshot of the whole decision.
// temp comes from the last /allow sample in the DB (authoritative), not the caller.
app.get('/debug', async (_req: Request, res: Response) => {
  const at = new Date();
  const [power, forecast, legionellaForced, lastHot, lastSample] = await Promise.all([
    powerService.getAvailablePower(),
    forecastStore.load(),
    legionella.needsForcedHeat(),
    forecastStore.lastHot(),
    forecastStore.lastSample(),
  ]);
  const temp = lastSample?.temp ?? NaN;
  const plan = planTank(at, temp, forecast, defaultTankConfig());
  const mpc = defaultPlannerConfig();
  const schedulePlan = planSchedule(
    at,
    temp,
    (power.power ?? 0) / 1000,
    forecast,
    legionellaForced,
    mpc,
    (d) => d.getHours(),
    lastSample?.heatOn ?? false
  );
  res.json({
    at: at.toISOString(),
    lastSample: lastSample
      ? {
          at: lastSample.at.toISOString(),
          temp: lastSample.temp,
          power: lastSample.power,
          heatOn: lastSample.heatOn,
        }
      : null,
    power: { watts: power.power ?? null, estimated: power.estimated, source: power.source },
    controlState: getControlStateForTest(),
    legionella: { forced: legionellaForced, lastHot: lastHot?.toISOString() ?? null },
    forecast: forecast
      ? {
          provider: forecast.provider,
          fetchedAt: forecast.fetchedAt,
          ageMs: at.getTime() - forecast.fetchedAt.getTime(),
          stale: at.getTime() - forecast.fetchedAt.getTime() > defaultTankConfig().forecastMaxAgeMs,
          entries: forecast.forecasts.length,
        }
      : null,
    plan: plan,
    mpc: {
      reason: schedulePlan.reason,
      heat: schedulePlan.heat,
      importKwh: schedulePlan.schedule.totalImportKwh,
      // NOTE: solarToday/solarTomorrow below are computed from the solver's truncated
      // horizon array (MPC_HORIZON_HOURS from `now`), so they under-report the real
      // next-day total. For the true full-UTC-calendar-day totals see forecastDayTotals.
      solarToday: schedulePlan.solarToday,
      solarTomorrow: schedulePlan.solarTomorrow,
      // full-UTC-calendar-day boiler-phase kWh from the whole cached forecast (not truncated)
      forecastDayTotals: forecast
        ? (() => {
            const d0 = new Date(at);
            d0.setUTCHours(0, 0, 0, 0);
            const d1 = new Date(d0.getTime() + 24 * 3600e3);
            const d2 = new Date(d1.getTime() + 24 * 3600e3);
            const share = mpc.boilerPhaseShare;
            return {
              todayKwh: ForecastProcessor.calcKWh(forecast, d0, d1, 0) * share,
              tomorrowKwh: ForecastProcessor.calcKWh(forecast, d1, d2, 0) * share,
            };
          })()
        : null,
      nextHeatingHour:
        schedulePlan.schedule.steps.find((s: { heat: boolean }) => s.heat)?.hour ?? null,
      schedule: schedulePlan.schedule.steps.slice(0, 48),
    },
  });
});

app.get('/allow', async (req: Request, res: Response) => {
  console.log(req.query);
  const params = req.query as AllowParams;
  const heatIsOn = params.relay == '1';
  const T = parseFloat(params.temp);

  const { power } = await powerService.getAvailablePower();
  const forecast = await forecastStore.load();
  const legionellaForced = await legionella.needsForcedHeat();

  const heatCmd = GetStateWithForecast(power, T, heatIsOn, forecast, legionellaForced);
  if (heatCmd) res.send('HEATON\n').end();
  else res.send('HEAToff\n').end();

  // decision log – one compact row per poll for post-hoc debugging
  try {
    const plan = getLastPlanForTest();
    if (plan) {
      const firstHeat = plan.schedule.steps.find((s) => s.heat);
      await forecastStore.appendDecision({
        at: new Date(),
        temp: T,
        livePower: power ?? 0,
        heatCmd,
        heatOn: heatIsOn,
        reason: plan.reason,
        importKwh: plan.schedule.totalImportKwh,
        nextFreeHours: firstHeat ? firstHeat.hour : -1,
        solarToday: plan.solarToday,
        solarTomorrow: plan.solarTomorrow,
      });
    }
  } catch (e) {
    console.error('decision log', e);
  }

  // legionella tracking – record if we reached 60C
  legionella.recordIfHot(T).catch((e) => console.error('legionella record', e));
  // persist latest sample so /debug reflects the real background poll
  forecastStore
    .saveSample({ at: new Date(), temp: T, power: power ?? 0, heatOn: heatIsOn })
    .catch((e) => console.error('saveSample', e));
  flux.recordStats(T, power ?? 0, heatIsOn);
});

app.listen(port, () => {
  console.log(
    `⚡️[server]: Heat control is running at http://localhost:${port} provider=${provider.name} store=${sqlitePath}`
  );
});
