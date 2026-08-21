import { FluxClient } from './fluxClient';
import { Forecast } from './forecast/types';
import { estimatePowerFromForecast, estimatePowerFromSunElevation } from './policy';
import { getSunElevationUTC } from './sun';

export class PowerService {
  constructor(
    private flux: FluxClient,
    private getForecast: () => Promise<Forecast | null>
  ) {}

  async getAvailablePower(): Promise<{
    power: number | undefined;
    estimated: boolean;
    source: string;
  }> {
    // 1) grid data (net active_grid_B_power_W)
    try {
      const p = await this.flux.getPower();
      if (typeof p === 'number' && !isNaN(p))
        return { power: p, estimated: false, source: 'influx' };
    } catch (e) {
      console.error('flux getPower failed', e);
    }
    // 2) forecast available, no grid data
    try {
      const f = await this.getForecast();
      const estKw = estimatePowerFromForecast(f, new Date());
      if (estKw != null) {
        // gross PV forecast used directly – active_grid_B is net, but this is only an outage estimate
        const estW = Math.max(0, estKw * 1000);
        return {
          power: estW,
          estimated: true,
          source: f ? `forecast:${f.provider}` : 'forecast:null',
        };
      }
    } catch (e) {
      console.error('forecast estimate failed', e);
    }
    // 3) neither grid nor forecast – fall back to sun elevation (peak sun → heat)
    const elev = getSunElevationUTC(57, 25);
    const estW = estimatePowerFromSunElevation(elev);
    if (estW != null) return { power: estW, estimated: true, source: 'sun-fallback' };
    // 4) nothing (dark + no data) – daily heat handled by legionella forcing
    return { power: undefined, estimated: true, source: 'none' };
  }
}
