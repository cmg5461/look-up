import {
  distanceNm,
  bearingDeg,
  compass,
  destination,
  elevationDeg,
  toRad,
  FT_PER_NM,
} from './geo.js';

/**
 * The single definition of the patch of sky you can see, expressed as the
 * ground radius in nautical miles at a given altitude. Three constraints
 * bound it, and each binds at a different altitude:
 *
 *   1. Your horizon.   elevation >= horizonDeg. Trees, roofs and terrain cut
 *                      off the bottom of your sky. A property of where you
 *                      stand, not a preference - roughly 5-15 degrees in
 *                      wooded suburbia, near 0 over open water, more in a
 *                      valley. It binds for LOW aircraft.
 *   2. "Overhead".     ground <= maxGroundNm. However high something is, once
 *                      it is far away horizontally it is not overhead. This
 *                      binds for HIGH aircraft.
 *   3. Resolvability.  slant <= maxSlantNm. Past that it is a dot.
 *
 * Plus a cylinder, unioned in: anything within cylinderNm counts whatever its
 * elevation. The cone is right about your eyes and wrong about your ears - a
 * helicopter at 400ft beyond 0.37nm is behind the treeline, and still low,
 * close and loud. The cylinder only reaches below the altitude where the cone
 * is tighter than it is: at 10 degrees and 1nm, everything under ~1,070ft.
 *
 *     altitude    cone only    with a 1nm cylinder
 *       400 ft    0.37 nm      1.00 nm
 *     1,000 ft    0.93 nm      1.00 nm
 *     3,000 ft    2.80 nm      2.80 nm
 *    30,000 ft    3.00 nm      3.00 nm   (capped by maxGroundNm)
 *
 * Returns 0 when nothing at that altitude qualifies.
 */
export function bubbleRadiusNm(altFt, cfg) {
  if (altFt == null || altFt <= 0) return 0;
  const o = cfg.overhead;
  const altNm = altFt / FT_PER_NM;
  if (altNm >= o.maxSlantNm) return 0; // too high to resolve even straight up

  const cone = Math.min(altNm / Math.tan(toRad(o.horizonDeg)), o.maxGroundNm);
  const resolvable = Math.sqrt(o.maxSlantNm * o.maxSlantNm - altNm * altNm);
  return Math.min(Math.max(cone, o.cylinderNm), resolvable);
}

/** Where an aircraft sits relative to the observer at one instant. */
function look(cfg, lat, lon, altFt) {
  const ground = distanceNm(cfg.lat, cfg.lon, lat, lon);
  return {
    altFt,
    ground,
    slant: Math.hypot(ground, altFt / FT_PER_NM),
    elevation: elevationDeg(altFt, ground),
  };
}

/**
 * Membership, defined in terms of the radius rather than restating the
 * geometry a second time. The radius is already clipped by the slant limit,
 * so a ground distance inside it is inside every constraint.
 */
const inBubble = (l, cfg) => l.ground <= bubbleRadiusNm(l.altFt, cfg);

/**
 * Walk the dead-reckoned track between two times and report the crossing,
 * or null if it never enters the bubble in that window.
 */
function scan(a, cfg, fromSec, toSec, stepSec) {
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
    const l = look(cfg, p.lat, p.lon, altFt);

    if (inBubble(l, cfg)) {
      if (entrySec === null) {
        entrySec = t;
        entryBearing = bearingDeg(cfg.lat, cfg.lon, p.lat, p.lon);
      }
      exitSec = t;
      if (l.elevation > peakElevation) {
        peakElevation = l.elevation;
        peakSec = t;
      }
      if (l.slant < minSlant) minSlant = l.slant;
    } else if (entrySec !== null) {
      break; // it has passed through; one crossing is all we need
    }
  }

  if (entrySec === null) return null;
  return { entrySec, exitSec, entryBearing, peakElevation, peakSec, minSlant };
}

/**
 * Dead-reckon forward and describe the crossing, or null if there is none.
 *
 * Two passes. A coarse one finds the crossing, with its step shrunk to suit
 * the bubble this aircraft could occupy - at 500kt and 400ft the whole
 * crossing lasts about 5 seconds, which a fixed 5s step would skip clean over.
 * A fine pass then re-walks just that window: without it a helicopter passing
 * directly overhead reports its peak as whatever the coarse samples happened
 * to land on, 50 degrees rather than 90, sending you to the wrong patch of sky.
 */
function crossing(a, cfg) {
  const o = cfg.overhead;
  const radiusNow = bubbleRadiusNm(a.altFt, cfg);
  const crossingSec =
    radiusNow > 0 ? (2 * radiusNow * 3600) / a.groundSpeedKt : Infinity;
  const stepSec = Math.max(0.5, Math.min(o.stepSeconds, crossingSec / 4));

  const coarse = scan(a, cfg, 0, o.lookaheadMinutes * 60, stepSec);
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
    durationSec: Math.max(fine.exitSec - fine.entrySec, 1),
    peakElevationDeg: fine.peakElevation,
    peakSec: fine.peakSec,
    minSlantNm: fine.minSlant,
    entryBearing: fine.entryBearing,
    entryCompass: compass(fine.entryBearing),
    belowHorizon: fine.peakElevation < o.horizonDeg,
    // Dead reckoning assumes the aircraft holds course. A decent bet for a jet
    // in cruise, a poor one for something in the circuit, so say how far the
    // claim reaches.
    confidence:
      fine.entrySec <= 120 ? 'high' : fine.entrySec <= 300 ? 'moderate' : 'low',
  };
}

/**
 * What this aircraft means for your patch of sky. Returns null if it means
 * nothing, otherwise:
 *
 *   now        where it is, and whether that is already inside the bubble.
 *              Observed, never extrapolated, so always trustworthy.
 *   projected  the crossing its track implies, or null if none was computed.
 *   held       why extrapolation was refused when it would otherwise have
 *              produced a crossing: 'warming-up' or 'unsteady'.
 *
 * `projected === null` IS the statement that nothing was extrapolated. There
 * is no separate flag to keep in step, and no caller has to infer it from a
 * null duration or a sentinel confidence value.
 *
 * The straightness gate deliberately does not apply to `now`. Extrapolation
 * needs validating; observation does not. Without that exemption an aircraft
 * overhead during the warm-up stays silent until it has gone, and a helicopter
 * orbiting above your house never alerts at all - orbiting means a high path
 * residual, which would suppress it forever.
 */
export function predictOverhead(a, cfg, fit = null) {
  const o = cfg.overhead;
  if (a.lat == null || a.lon == null || a.altFt == null || a.altFt <= 0) return null;

  const here = look(cfg, a.lat, a.lon, a.altFt);
  const bearing = bearingDeg(cfg.lat, cfg.lon, a.lat, a.lon);
  const now = {
    insideBubble: inBubble(here, cfg),
    groundNm: here.ground,
    slantNm: here.slant,
    elevationDeg: here.elevation,
    bearing,
    compass: compass(bearing),
    belowHorizon: here.elevation < o.horizonDeg,
  };

  // Anything hovering, or reporting no track, cannot be dead-reckoned at all.
  // It can still be overhead, which is the whole point of reporting `now`.
  const projectable =
    a.track != null && a.groundSpeedKt != null && a.groundSpeedKt >= o.minSpeedKt;

  let projected = null;
  let held = null;

  if (projectable) {
    // Trust the fitted velocity when the fit is good: it averages out
    // reporting jitter, and it is the very motion the fit validated.
    const trusted =
      !o.requireStraight || (fit != null && fit.residual <= o.maxPathResidual);
    const pass = crossing(
      trusted && fit ? { ...a, track: fit.heading, groundSpeedKt: fit.speedKt } : a,
      cfg,
    );
    if (pass) {
      if (trusted) projected = pass;
      else held = fit === null ? 'warming-up' : 'unsteady';
    }
  }

  if (!now.insideBubble && !projected && !held) return null;
  return { now, projected, held };
}

/**
 * Whether a result is near enough to be worth a notification.
 *
 * Two different kinds of claim live in one result, and they deserve different
 * standards of proof. `now.insideBubble` is an observation - the aircraft is
 * above you, and no amount of future manoeuvring changes that. `projected` is
 * a prediction that it holds its present course, and that prediction weakens
 * with the distance it must reach across: at six minutes a 450kt jet has to
 * hold heading to within 3.8 degrees to still cross a 3nm bubble, at two
 * minutes it has 11.5 degrees of slack. Aircraft turning onto an approach
 * routinely break the first tolerance and rarely the second, because by two
 * minutes out they have usually already turned.
 *
 * So watching begins as soon as a crossing is predictable; only the alert
 * waits for the claim to get short enough to be nearly a statement of fact.
 */
export const alertable = (o, cfg) =>
  o.now.insideBubble ||
  (o.projected != null && o.projected.etaSec <= cfg.overhead.alertWithinSec);
