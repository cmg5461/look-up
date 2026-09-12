import { destination } from '../src/geo.js';

/**
 * Every test observes the sky from Central Park.
 *
 * Deliberately a well-known public space: obviously not anyone's home, so a
 * reader can tell at a glance that it is a fixture. Never put a real location
 * in a test - the repo is public, and a coordinate committed once is committed
 * forever.
 *
 * It is also a *representative* place, which matters more than it sounds. The
 * first choice here was the Washington Monument, which sits inside P-56, the
 * prohibited airspace over central DC: almost nothing legally flies over it.
 * A fixture for an overhead-aircraft app should sit under ordinary traffic.
 */
export const OBSERVER = { lat: 40.7829, lon: -73.9654 };

// Pin every setting the tests depend on BEFORE config.js is imported. It only
// falls back to .env for keys that are still undefined, so this both isolates
// the suite from whatever the developer has configured locally and keeps the
// real parsing and defaulting logic under test.
Object.assign(process.env, {
  LAT: String(OBSERVER.lat),
  LON: String(OBSERVER.lon),
  NTFY_TOPIC: 'test-topic-not-a-real-one',
  RADIUS_NM: '10',
  OVERHEAD: 'true',
  OVERHEAD_SCOPE: 'all',
  OVERHEAD_HORIZON_DEG: '10',
  OVERHEAD_MAX_GROUND_NM: '3',
  OVERHEAD_CYLINDER_NM: '1',
  OVERHEAD_MAX_SLANT_NM: '25',
  OVERHEAD_LOOKAHEAD_MIN: '8',
  OVERHEAD_ALERT_WITHIN_SEC: '180',
  OVERHEAD_STEP_SECONDS: '5',
  OVERHEAD_MIN_SPEED_KT: '40',
  OVERHEAD_SEARCH_NM: '80',
  OVERHEAD_REQUIRE_STRAIGHT: 'true',
  OVERHEAD_MIN_SAMPLES: '4',
  OVERHEAD_MIN_SPAN_SECONDS: '60',
  OVERHEAD_MAX_PATH_RESIDUAL: '0.015',
  TAILDB: 'false',
});

export const { config } = await import('../src/config.js');
export const { normalize } = await import('../src/rules.js');

/**
 * An aircraft placed relative to the observer, so tests read as geometry
 * rather than as coordinates.
 *
 * `offsetNm` shifts it sideways across its own track, which is how you set up
 * a near-miss: the aircraft still flies the same heading, just displaced
 * perpendicular to it.
 */
export function aircraftAt({
  bearing = 180,
  distanceNm = 3,
  altFt = 400,
  speedKt = 110,
  track = 0,
  verticalRateFpm = 0,
  offsetNm = 0,
  hex = 'abc123',
  ...rest
}) {
  let p = destination(OBSERVER.lat, OBSERVER.lon, bearing, distanceNm);
  if (offsetNm) p = destination(p.lat, p.lon, ((track ?? 0) + 90) % 360, offsetNm);
  return normalize(
    {
      hex,
      lat: p.lat,
      lon: p.lon,
      alt_baro: altFt,
      gs: speedKt,
      track,
      baro_rate: verticalRateFpm,
      mlat: [],
      tisb: [],
      ...rest,
    },
    config,
  );
}

/**
 * A path fit that exactly matches the aircraft's own reported velocity, for
 * tests about geometry rather than about the straightness gate. Returns null
 * when the aircraft cannot be projected at all, which is what TrackHistory
 * would also report.
 */
export const perfectFit = (a) =>
  a.track != null && a.groundSpeedKt
    ? { residual: 0, heading: a.track, speedKt: a.groundSpeedKt }
    : null;

/**
 * Feed a TrackHistory an integrated flight path: position advances along the
 * current heading each step, so a turn genuinely curves the ground track.
 *
 * Rotating only the reported `track` field while flying a straight line is a
 * tempting shortcut and a useless test - the fit reads positions, so it would
 * correctly see a straight path and the test would prove nothing.
 */
export function flyPath(history, { hex = 'sim', speedKt = 450, turnDegSec = 0, samples = 4, stepSec = 30, decelToKt = null, start = { lat: 40.6, lon: -74.2 }, heading = 45 } = {}) {
  const toRad = (d) => (d * Math.PI) / 180;
  let { lat, lon } = start;
  let hdg = heading;
  const t0 = Date.now();

  for (let i = 0; i < samples; i++) {
    history.record({ hex, lat, lon }, t0 + i * stepSec * 1000);
    const progress = decelToKt !== null ? i / Math.max(1, samples - 1) : 0;
    const kt = decelToKt !== null ? speedKt + (decelToKt - speedKt) * progress : speedKt;
    const nm = (kt / 3600) * stepSec;
    lat += (nm * Math.cos(toRad(hdg))) / 60;
    lon += (nm * Math.sin(toRad(hdg))) / (60 * Math.cos(toRad(lat)));
    hdg += turnDegSec * stepSec;
  }
  return hex;
}
