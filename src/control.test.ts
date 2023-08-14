import { ControlData, calculateRequiredPower } from './control';

const Settings: ControlData[] = [
  {
    temperature: -5.0,
    requiredpower: -2000,
  },
  {
    temperature: 42.0,
    requiredpower: 0,
  },
  {
    temperature: 45.0,
    requiredpower: 1000,
  },
  {
    temperature: 50.0,
    requiredpower: 2400,
  },
  {
    temperature: 55.0,
    requiredpower: 3550,
  },
];

describe('Control', () => {
  it('Calculation, heater off', async () => {
    for (let t = -55; t < 75; t++) {
      var x = calculateRequiredPower( t, false, Settings);

        if (t>=55)
            expect(x).toBeGreaterThanOrEqual(3550);
        else if (t>=50)
        {
            expect(x).toBeGreaterThanOrEqual(2400);
            expect(x).toBeLessThan(3550);
        }
        else if (t>=45)
        {
            expect(x).toBeGreaterThanOrEqual(1000);
            expect(x).toBeLessThan(2400);
        }
        else if (t>=42)
        {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThan(1000);
        }
        else if (t>=-5)
        {
            expect(x).toBeGreaterThanOrEqual(-2000);
            expect(x).toBeLessThan(0);
        }

    }
  });
  it('Calculation, heater on', async () => {
    for (let t = -55; t < 75; t++) {
      var x = calculateRequiredPower( t, true, Settings);

        if (t>=55)
            expect(x).toBeGreaterThanOrEqual(3550);
        else if (t>=50)
        {
            expect(x).toBeGreaterThanOrEqual(2400);
            expect(x).toBeLessThan(3550);
        }
        else if (t>=45)
        {
            expect(x).toBeGreaterThanOrEqual(1000);
            expect(x).toBeLessThan(2400);
        }
        else if (t>=42)
        {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThan(1000);
        }
        else if (t>=-5)
        {
            expect(x).toBeGreaterThanOrEqual(-2000);
            expect(x).toBeLessThan(0);
        }

    }
  });

});
