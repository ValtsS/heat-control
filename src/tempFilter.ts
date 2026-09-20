// DS1820 temperature filter: the surface probe on top of the tank reads cleanly most
// of the time but occasionally spikes several °C in a single 5s poll (relay/heater
// electrical noise on the 1-wire bus, or a marginal read). A 150 L tank physically
// cannot change 2 °C in 5 s, so we:
//   1. reject single readings that jump more than `maxJumpDeg` from the filtered value,
//   2. smooth the remainder with an EWMA so residual jitter doesn't flip the relay.
// The filtered value is what the controller decides on; the raw value is kept for /debug
// and logging so the spike rejection is observable.
import { parseNum } from './config';

export class TempFilter {
  private filtered: number | null = null;
  private lastRaw: number | null = null;

  constructor(
    private maxJumpDeg: number = parseNum(process.env.TEMP_FILTER_MAX_JUMP, 2),
    private blend: number = parseNum(process.env.TEMP_FILTER_BLEND, 0.3)
  ) {}

  /** Feed a raw reading; returns the filtered temperature to use for control. */
  update(raw: number): number {
    this.lastRaw = raw;
    if (this.filtered === null) {
      this.filtered = raw;
      return raw;
    }
    // spike rejection: if the raw jumped more than maxJumpDeg from the filtered value,
    // treat it as noise and keep the previous filtered temperature.
    if (Math.abs(raw - this.filtered) > this.maxJumpDeg) {
      return this.filtered;
    }
    // EWMA: blend the raw toward the previous filtered value.
    this.filtered = this.blend * raw + (1 - this.blend) * this.filtered;
    return this.filtered;
  }

  /** Current filtered temperature (for control). */
  get value(): number | null {
    return this.filtered;
  }

  /** Most recent raw reading received (for diagnostics). */
  get raw(): number | null {
    return this.lastRaw;
  }

  reset(): void {
    this.filtered = null;
    this.lastRaw = null;
  }
}
