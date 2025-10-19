// returns sun elevation (degrees) at the current UTC moment for given lat/lon
export function getSunElevationUTC(lat: number, lon: number): number {
  // helpers
  const deg2rad = (d: number) => d * Math.PI / 180;
  const rad2deg = (r: number) => r * 180 / Math.PI;

  const now = new Date();

  // day of year N (fractional, includes time-of-day)
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 0);
  const msSinceYearStart = now.getTime() - yearStart;
  const dayFraction = msSinceYearStart / 86400000; // days, fractional
  const N = dayFraction; // day-of-year as fractional day

  // approximate solar declination (degrees)
  // common simple formula: decl = 23.44° * sin( 2π * (284 + N) / 365 )
  const declDeg = 23.44 * Math.sin(2 * Math.PI * (284 + N) / 365);
  const decl = deg2rad(declDeg);

  // Equation of Time (minutes) — simple approximation
  const B = 2 * Math.PI * (N - 81) / 364;
  const EoT_minutes = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  // current UTC hour fraction
  const utcHours =
    now.getUTCHours() +
    now.getUTCMinutes() / 60 +
    now.getUTCSeconds() / 3600 +
    now.getUTCMilliseconds() / 3600000;

  // approximate solar time (hours). lon/15 converts longitude to hours.
  // add EoT correction (minutes -> hours)
  const solarTime = utcHours + lon / 15 + EoT_minutes / 60;

  // hour angle H in radians: (solarTime - 12h) * 15°/h
  const H = deg2rad((solarTime - 12) * 15);

  const latRad = deg2rad(lat);

  // elevation formula: sin(el) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(H)
  const sinEl =
    Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(H);

  // numeric safety: clamp
  const sinElClamped = Math.max(-1, Math.min(1, sinEl));
  const elevationRad = Math.asin(sinElClamped);

  return rad2deg(elevationRad);
}

