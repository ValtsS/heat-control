import { FluxClient } from './fluxClient';
import { Forecast } from './forecast/types';
import { estimatePowerFromForecast } from './policy';
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
    try {
      const p = await this.flux.getPower();
      if (typeof p === 'number' && !isNaN(p))
        return { power: p, estimated: false, source: 'influx' };
    } catch (e) {
      console.error('flux getPower failed', e);
    }
    // fallback to forecast estimate
    try {
      const f = await this.getForecast();
      const estKw = estimatePowerFromForecast(f, new Date());
      if (estKw != null) {
        // active_grid_B_power_W is already net (positive = export, negative = import),
        // so forecast PV is used directly as estimate – no HOUSE_BASE_W subtraction
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
    // last resort sun elevation heuristic – if sun up, assume 500W midday else 0
    const elev = getSunElevationUTC(57, 25);
    if (elev > 15) return { power: 400, estimated: true, source: 'sun-fallback' };
    return { power: undefined, estimated: true, source: 'none' };
  }
}
