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
 * The patch of sky you can actually pick an aircraft out of is bounded by
 * three separate things, and each one binds at a different altitude:
 *
 *   1. Your horizon.   elevation >= horizonDeg. Trees, roofs and terrain cut
 *                      off the bottom of your sky. This is a property of where
 *                      you stand, not a preference - roughly 5-15 degrees in
 *                      wooded suburbia, near 0 over open water, more in a
 *                      valley. It binds for LOW aircraft.
 *   2. "Overhead".     ground distance <= maxGroundNm. However high something
 *                      is, once it is far away horizontally it is not overhead.
 *                      This binds for HIGH aircraft.
 *   3. Resolvability.  slant range <= maxSlantNm. Past that it is a dot.
 *
 * A single elevation cone cannot do this job. At 45 degrees a helicopter at
 * 400ft would have to be within 0.066nm - 133 yards - while a jet at 30,000ft
 * got a 4.9nm window. That is backwards: the low, loud, close aircraft is the
 * one you are most likely to actually see, and it was the one being excluded.
 *
 * Splitting the floor from the preference fixes both ends:
 *
 *     altitude    old 45deg cone      horizon 10deg + 3nm cap
 *       400 ft    0.07 nm             0.37 nm
 *     1,000 ft    0.16 nm             0.93 nm
 *     3,000 ft    0.49 nm             2.80 nm
 *    10,000 ft    1.65 nm             3.00 nm
 *    30,000 ft    4.94 nm             3.00 nm
 *
 * Returns the ground radius in nm, or 0 if nothing at that altitude qualifies.
 */
export function bubbleRadiusNm(altFt, cfg) {
  if (altFt == null || altFt <= 0) return 0;
  const o = cfg.overhead;
  const altNm = altFt / FT_PER_NM;
  if (altNm >= o.maxSlantNm) return 0; // too high to resolve even straight up

  const horizon = altNm / Math.tan(toRad(o.horizonDeg));
  const slant = Math.sqrt(o.maxSlantNm * o.maxSlantNm - altNm * altNm);
  return Math.min(horizon, slant, o.maxGroundNm);
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
 * Walk the dead-reckoned track between two times and report the crossing, or
 * null if it never enters the bubble in that window.
 */
function scan(a, cfg, fromSec, toSec, stepSec) {
  const o = cfg.overhead;
  const vsFtPerSec = (a.verticalRateFpm ?? 0) / 60;

  let entrySec = null;
  let exitSec = null;
  let entryBearing = null;
  let peakElevation = -Infinity;
  let peakSec = 0;
  let minSlant = Infinity;

  for (let t = Math.max(0, fromSec); t <= toSec; t += stepSec) {
    const altFt = a.altFt + vsFtPerSec * t;
    if (altFt <= 0) break; // landed before reaching us

    const travelled = (a.groundSpeedKt * t) / 3600;
    const p =
      travelled === 0
        ? { lat: a.lat, lon: a.lon }
        : destination(a.lat, a.lon, a.track, travelled);
    const { ground, slant, elevation } = look(cfg, p.lat, p.lon, altFt);

    const inside =
      elevation >= o.horizonDeg && ground <= o.maxGroundNm && slant <= o.maxSlantNm;
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
  return { entrySec, exitSec, entryBearing, peakElevation, peakSec, minSlant };
}

/**
 * Dead-reckon an aircraft forward along its current ground track and report
 * whether it will pass through the visibility bubble.
 *
 * Stepping the path rather than solving it closed-form is deliberate: the
 * bubble's radius changes with altitude, so a climbing or descending aircraft
 * is chasing a moving target and there is no clean analytic answer.
 *
 * Two passes. A coarse one finds the crossing; a fine one re-walks just that
 * window to pin down peak elevation and closest approach. Without the second
 * pass a helicopter passing directly overhead reports its peak as whatever
 * angle the coarse samples happened to land on - 50 degrees rather than 90 -
 * which would send you looking at the wrong patch of sky.
 *
 * Returns null if it will not cross, or cannot be projected.
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

  // Low bubbles are small and fast movers cross them quickly: at 500kt and
  // 400ft the whole crossing lasts about 5 seconds, which a fixed 5s step
  // could skip entirely. Shrink the step so the narrowest bubble this
  // aircraft could occupy still gets several samples.
  const radiusNow = bubbleRadiusNm(a.altFt, cfg);
  const crossingSec = radiusNow > 0 ? (2 * radiusNow * 3600) / a.groundSpeedKt : Infinity;
  const stepSec = Math.max(0.5, Math.min(o.stepSeconds, crossingSec / 4));

  const coarse = scan(a, cfg, 0, horizonSec, stepSec);
  if (!coarse) return null;

  const windowSec = coarse.exitSec - coarse.entrySec + 2 * stepSec;
  const fine =
    scan(
      a,
      cfg,
      coarse.entrySec - stepSec,
      coarse.exitSec + stepSec,
      Math.max(0.05, windowSec / 200),
    ) ?? coarse;

  return {
    etaSec: fine.entrySec,
    exitSec: fine.exitSec,
    // A single sample inside still means a pass, just a brief one.
    durationSec: Math.max(fine.exitSec - fine.entrySec, 1),
    peakElevationDeg: fine.peakElevation,
    peakSec: fine.peakSec,
    minSlantNm: fine.minSlant,
    entryBearing: fine.entryBearing,
    entryCompass: compass(fine.entryBearing),
    alreadyInside: fine.entrySec <= 0.5,
    // Dead reckoning assumes the aircraft holds its current track. That is a
    // decent bet for a jet in cruise and a poor one for something in the
    // circuit, so callers should present distant predictions as provisional.
    confidence: fine.entrySec <= 120 ? 'high' : fine.entrySec <= 300 ? 'moderate' : 'low',
  };
}
