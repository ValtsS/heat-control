// human-readable config helpers
// durations: "6h", "1.5h", "7d", "20m", "90s" → ms
export function parseDuration(value: string | undefined, def: number): number {
  if (!value) return def;
  const s = value.trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(h|d|m|s|ms)?$/);
  if (!m) {
    throw new Error(`Invalid duration "${value}" – use e.g. "6h", "7d", "20m", "90s"`);
  }
  const n = parseFloat(m[1]);
  switch (m[2] ?? 'ms') {
    case 'h':
      return Math.round(n * 3600 * 1000);
    case 'd':
      return Math.round(n * 24 * 3600 * 1000);
    case 'm':
      return Math.round(n * 60 * 1000);
    case 's':
      return Math.round(n * 1000);
    default:
      return Math.round(n);
  }
}

// numeric with default
export function parseNum(value: string | undefined, def: number): number {
  if (value === undefined || value === '') return def;
  const n = parseFloat(value);
  return Number.isNaN(n) ? def : n;
}

export function parseIntVal(value: string | undefined, def: number): number {
  if (value === undefined || value === '') return def;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? def : n;
}
