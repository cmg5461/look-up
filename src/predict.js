import {
  distanceNm,
  bearingDeg,
  compass,
  destination,
  FT_PER_NM,
} from './geo.js';

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * The volume of sky you could actually pick an aircraft out of is the
 * intersection of two constraints:
 *
 *   1. A cone.   elevation >= minElevationDeg. Below that an aircraft is low
 *                on the horizon, behind trees and houses, and not "overhead"
 *                in any useful sense.
 *   2. A sphere. slant range <= maxSlantNm. Past that it is a dot you will
 *                not resolve however high it sits.
 *
 * At a given altitude the cone contributes a ground radius of
 * `alt / tan(elevation)` and the sphere `sqrt(maxSlant^2 - alt^2)`; the
 * binding one is whichever is smaller. At 45 degrees the cone radius reduces
 * to exactly the altitude, which is a useful sanity anchor: a jet at 30,000ft
 * (4.9nm) is overhead within 4.9nm, a helicopter at 1,000ft within 0.16nm.
 *
 * Returns 0 when nothing at that altitude could be inside the bubble.
 */
export function bubbleRadiusNm(altFt, cfg) {
  if (altFt == null || altFt <= 0) return 0;
  const altNm = altFt / FT_PER_NM;
  const maxSlant = cfg.overhead.maxSlantNm;
  if (altNm >= maxSlant) return 0; // too high to see even straight up

  const cone = altNm / Math.tan(toRad(cfg.overhead.minElevationDeg));
  const sphere = Math.sqrt(maxSlant * maxSlant - altNm * altNm);
  return Math.min(cone, sphere);
}

/** Where the aircraft sits relative to the observer at one instant. */
function look(cfg, lat, lon, altFt) {
  const ground = distanceNm(cfg.lat, cfg.lon, lat, lon);
  const altNm = altFt / FT_PER_NM;
  return {
    ground,
    slant: Math.hypot(ground, altNm),
    elevation: toDeg(Math.atan2(altNm, ground)),
  };
}

/**
 * Dead-reckon an aircraft forward along its current ground track and report
 * whether it will pass through the visibility bubble.
 *
 * Stepping the path rather than solving it closed-form is deliberate: the
 * bubble's radius changes with altitude, so a climbing or descending aircraft
 * is chasing a moving target and there is no clean analytic answer. At a few
 * hundred steps per aircraft the cost is irrelevant.
 *
 * Returns null if it will not, or cannot be projected.
 */
export function predictOverhead(a, cfg) {
  const o = cfg.overhead;

  // Dead reckoning needs a heading and a speed. Anything parked, hovering,
  // or reporting no track cannot be projected, and guessing would be worse
  // than staying quiet.
  if (a.lat == null || a.lon == null || a.altFt == null || a.altFt <= 0) return null;
  if (a.track == null) return null;
  if (a.groundSpeedKt == null || a.groundSpeedKt < o.minSpeedKt) return null;

  const horizonSec = o.lookaheadMinutes * 60;
  const vsFtPerSec = (a.verticalRateFpm ?? 0) / 60;

  let entrySec = null;
  let exitSec = null;
  let entryBearing = null;
  let peakElevation = -Infinity;
  let peakSec = 0;
  let minSlant = Infinity;

  for (let t = 0; t <= horizonSec; t += o.stepSeconds) {
    const altFt = a.altFt + vsFtPerSec * t;
    if (altFt <= 0) break; // landed before reaching us

    const travelled = (a.groundSpeedKt * t) / 3600;
    const p = t === 0 ? { lat: a.lat, lon: a.lon } : destination(a.lat, a.lon, a.track, travelled);
    const { slant, elevation } = look(cfg, p.lat, p.lon, altFt);

    const inside = elevation >= o.minElevationDeg && slant <= o.maxSlantNm;
    if (inside) {
      if (entrySec === null) {
        entrySec = t;
        entryBearing = bearingDeg(cfg.lat, cfg.lon, p.lat, p.lon);
      }
      exitSec = t;
      if (elevation > peakElevation) {
        peakElevation = elevation;
        peakSec = t;
      }
      if (slant < minSlant) minSlant = slant;
    } else if (entrySec !== null) {
      break; // it has passed through; one crossing is all we need
    }
  }

  if (entrySec === null) return null;

  return {
    etaSec: entrySec,
    exitSec,
    // A single step inside still means a pass, just a brief one.
    durationSec: Math.max(exitSec - entrySec, o.stepSeconds),
    peakElevationDeg: peakElevation,
    peakSec,
    minSlantNm: minSlant,
    entryBearing,
    entryCompass: compass(entryBearing),
    alreadyInside: entrySec === 0,
    // Dead reckoning assumes the aircraft holds its current track. That is a
    // decent bet for a jet in cruise and a poor one for something in the
    // circuit, so callers should present distant predictions as provisional.
    confidence: entrySec <= 120 ? 'high' : entrySec <= 300 ? 'moderate' : 'low',
  };
}
