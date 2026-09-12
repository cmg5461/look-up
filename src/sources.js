import { config } from './config.js';

/**
 * Free, unauthenticated, community-fed ADS-B aggregators. Both serve the
 * readsb JSON shape, so the records are interchangeable. adsb.fi is tried
 * first because it enriches each record with `desc` (aircraft type name),
 * `ownOp` (registered owner/operator) and `year`, which make for a far more
 * useful alert. adsb.lol is the fallback.
 */
export const SOURCES = [
  {
    name: 'adsb.fi',
    url: (lat, lon, nm) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    extract: (j) => j.aircraft ?? [],
  },
  {
    name: 'adsb.lol',
    url: (lat, lon, nm) =>
      `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
    extract: (j) => j.ac ?? [],
  },
];

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    this.status = status;
  }
}

async function fetchFrom(source, lat, lon, nm, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(source.url(lat, lon, nm), {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': config.userAgent },
    });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    return source.extract(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch aircraft near a point, falling back through SOURCES on failure.
 * Returns { aircraft, source }. Throws only if every source fails.
 */
export async function fetchNearby({
  lat = config.lat,
  lon = config.lon,
  radiusNm = config.radiusNm,
  timeoutMs = 15000,
} = {}) {
  // Round the query point so we are not broadcasting a precise home address
  // to a third party on every poll; ~0.01deg is a little over half a mile,
  // negligible against a 25nm radius. Distances are recomputed locally from
  // the real coordinate anyway.
  const qLat = lat.toFixed(2);
  const qLon = lon.toFixed(2);
  const nm = Math.ceil(radiusNm + 2); // pad so rounding cannot clip the edge

  const errors = [];
  for (const source of SOURCES) {
    try {
      const aircraft = await fetchFrom(source, qLat, qLon, nm, timeoutMs);
      return { aircraft, source: source.name };
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }
  throw new Error(`all ADS-B sources failed (${errors.join('; ')})`);
}
