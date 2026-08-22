import { epd, stepTemp, TankModelConfig } from './model';

const CFG: TankModelConfig = {
  litres: 150,
  heaterKw: 2.4,
  tankLossKwhPerDay: 2.85,
  usageKwhPerDay: 6.1,
  minTemp: 40,
  maxTemp: 63,
  targetTemp: 55,
};

describe('thermal model', () => {
  it('EPD for 150L is ~0.174 kWh/°C', () => {
    expect(epd(150)).toBeCloseTo(0.17415, 4);
  });

  it('no heat → tank cools by loss+usage', () => {
    const t1 = stepTemp(55, 0, CFG, 1);
    // loss+usage per hour = (2.85+6.1)/24 = 0.3729 kWh → 2.14°C drop
    expect(55 - t1).toBeCloseTo((2.85 + 6.1) / 24 / 0.17415, 1);
  });

  it('full heater hour heats the tank ~13.8°C minus baseline loss+usage', () => {
    const t1 = stepTemp(40, 2.4, CFG, 1);
    const net = 2.4 / 0.17415 - (2.85 + 6.1) / 24 / 0.17415;
    expect(t1 - 40).toBeCloseTo(net, 1);
  });

  it('heater vs loss+usage – net gain', () => {
    const t1 = stepTemp(40, 2.4, CFG, 1);
    const t0 = stepTemp(40, 0, CFG, 1);
    expect(t1).toBeGreaterThan(t0);
  });
});
