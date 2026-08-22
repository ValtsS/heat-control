// Thermal model for the tank – pure math, no I/O.
// The heater is binary (2.4 kW on/off). Solar surplus offsets grid import;
// heat delivered to the tank is heaterKw regardless of where the energy comes from.

export type TankModelConfig = {
  litres: number;
  heaterKw: number;
  tankLossKwhPerDay: number;
  usageKwhPerDay: number;
  minTemp: number; // operating floor (°C)
  maxTemp: number; // thermostat cap (°C)
  targetTemp: number; // preferred end-of-horizon temp (°C) – the solver's terminal value
};

/** kWh per °C for a given tank volume */
export function epd(litres: number): number {
  return litres * 0.001161;
}

/** tank temp after `hours` with `heatKw` of heat into the tank (0..heaterKw) */
export function stepTemp(
  temp: number,
  heatKw: number,
  cfg: TankModelConfig,
  hours: number
): number {
  const lossKwH = (cfg.tankLossKwhPerDay / 24) * hours;
  const usageKwH = (cfg.usageKwhPerDay / 24) * hours;
  const heatKwH = heatKw * hours;
  return temp + (heatKwH - lossKwH - usageKwH) / epd(cfg.litres);
}
