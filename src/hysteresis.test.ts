import { applyHysteresis } from './control';

describe('applyHysteresis – MPC temperature deadband', () => {
  it('first call adopts the desired decision', () => {
    const r = applyHysteresis(true, 45, 1, null, NaN);
    expect(r.enable).toBe(true);
    expect(r.lastDecision).toBe(true);
    expect(r.lastFlipTemp).toBe(45);
  });

  it('keeps the current decision while desired is unchanged', () => {
    const r = applyHysteresis(true, 45.4, 1, true, 45);
    expect(r.enable).toBe(true);
    expect(r.lastFlipTemp).toBe(45); // flip point unchanged
  });

  it('does NOT flip off on a small temp wobble (< hysteresis)', () => {
    // was ON, solver now wants OFF, but temp only +0.4C from the flip point (< 1C)
    const r = applyHysteresis(false, 45.4, 1, true, 45);
    expect(r.enable).toBe(true); // stays ON
    expect(r.lastDecision).toBe(true);
  });

  it('flips off once temp moves past flip + hysteresis', () => {
    // was ON, solver wants OFF, temp moved +1.5C from flip point (>= 1C)
    const r = applyHysteresis(false, 46.5, 1, true, 45);
    expect(r.enable).toBe(false);
    expect(r.lastDecision).toBe(false);
    expect(r.lastFlipTemp).toBe(46.5); // new flip point
  });

  it('does NOT flip on on a small downward wobble', () => {
    // was OFF, solver wants ON, temp only -0.3C from flip point (< 1C)
    const r = applyHysteresis(true, 44.7, 1, false, 45);
    expect(r.enable).toBe(false); // stays OFF
  });

  it('flips on once temp drops past flip - hysteresis', () => {
    const r = applyHysteresis(true, 43.5, 1, false, 45);
    expect(r.enable).toBe(true);
    expect(r.lastFlipTemp).toBe(43.5);
  });

  it('custom hysteresis width is honored', () => {
    // width 2C: +1.5C is NOT enough to flip off
    const r1 = applyHysteresis(false, 46.5, 2, true, 45);
    expect(r1.enable).toBe(true);
    // +2.5C IS enough
    const r2 = applyHysteresis(false, 47.5, 2, true, 45);
    expect(r2.enable).toBe(false);
  });
});
