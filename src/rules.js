import { distanceNm, bearingDeg, compass, elevationDeg } from './geo.js';

// Bit flags on the `dbFlags` field of a readsb aircraft record.
export const DB_MILITARY = 1;
export const DB_INTERESTING = 2;
export const DB_PIA = 4; // Privacy ICAO Address
export const DB_LADD = 8; // Limiting Aircraft Data Displayed

export const REASONS = {
  military: { label: 'MILITARY', tag: 'military' },
  noCallsign: { label: 'NO CALLSIGN', tag: 'no-callsign' },
  interesting: { label: 'SPECIAL', tag: 'interesting' },
  pia: { label: 'PIA (anonymised)', tag: 'pia' },
  ladd: { label: 'LADD (blocked)', tag: 'ladd' },
  overhead: { label: 'OVERHEAD', tag: 'overhead' },
};

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** Altitude in feet, with "ground" mapped to 0 and geometric alt as backup. */
function altitudeFt(ac) {
  if (typeof ac.alt_baro === 'number') return ac.alt_baro;
  if (ac.alt_baro === 'ground') return 0;
  if (typeof ac.alt_geom === 'number') return ac.alt_geom;
  return null;
}

/**
 * Turn a raw feed record into the shape the rest of the app uses.
 * Distance and bearing are recomputed from the true coordinate rather than
 * trusting the feed's `dst`/`dir`, which are relative to the rounded query
 * point we actually sent.
 */
export function normalize(ac, cfg) {
  const hasPosition = typeof ac.lat === 'number' && typeof ac.lon === 'number';
  const altFt = altitudeFt(ac);
  const distNm = hasPosition ? distanceNm(cfg.lat, cfg.lon, ac.lat, ac.lon) : null;
  const bearing = hasPosition ? bearingDeg(cfg.lat, cfg.lon, ac.lat, ac.lon) : null;

  return {
    hex: ac.hex,
    callsign: trimmed(ac.flight),
    registration: trimmed(ac.r),
    typeCode: trimmed(ac.t),
    typeName: trimmed(ac.desc),
    operator: trimmed(ac.ownOp),
    year: trimmed(ac.year),
    squawk: trimmed(ac.squawk),
    emergency: trimmed(ac.emergency),
    dbFlags: ac.dbFlags ?? 0,
    altFt,
    lat: hasPosition ? ac.lat : null,
    lon: hasPosition ? ac.lon : null,
    groundSpeedKt: typeof ac.gs === 'number' ? ac.gs : null,
    // Ground track, not heading: dead reckoning cares where it is actually
    // going, not where the nose points.
    track: typeof ac.track === 'number' ? ac.track : null,
    verticalRateFpm:
      typeof ac.baro_rate === 'number'
        ? ac.baro_rate
        : typeof ac.geom_rate === 'number'
          ? ac.geom_rate
          : null,
    // A position from MLAT or TIS-B is second-hand: multilaterated by
    // ground receivers or rebroadcast by ATC radar. Such targets very often
    // carry no callsign simply because none was ever transmitted.
    positionSource: ac.mlat?.length ? 'mlat' : ac.tisb?.length ? 'tisb' : 'adsb',
    // No type, no registration: the tail database has no row for this hex.
    // Says nothing about the aircraft, only about the database.
    unidentified: !trimmed(ac.t) && !trimmed(ac.r),
    seenSec: typeof ac.seen === 'number' ? ac.seen : null,
    distNm,
    bearing,
    compass: bearing == null ? null : compass(bearing),
    elevationDeg: elevationDeg(altFt, distNm),
    raw: ac,
  };
}

/** Does this aircraft clear the global distance/altitude/elevation gates? */
function passesGlobalGates(a, cfg) {
  if (a.distNm == null || a.distNm > cfg.radiusNm) return false;
  // Something sitting on a ramp or taxiing is not overhead, however
  // interesting it is. Treat "on the ground" and "crawling" as parked.
  if (cfg.ignoreGround && a.altFt === 0 && (a.groundSpeedKt ?? 0) < 40) return false;
  if (cfg.maxAltFt != null && a.altFt != null && a.altFt > cfg.maxAltFt) return false;
  if (
    cfg.minElevationDeg != null &&
    a.elevationDeg != null &&
    a.elevationDeg < cfg.minElevationDeg
  ) {
    return false;
  }
  return true;
}

/** The no-callsign rule carries its own, usually tighter, gates. */
function passesNoCallsignGates(a, cfg) {
  const { maxNm, maxAltFt, skipUnpositioned } = cfg.noCallsign;
  if (skipUnpositioned && a.positionSource !== 'adsb') return false;
  if (maxNm != null && a.distNm != null && a.distNm > maxNm) return false;
  if (maxAltFt != null && a.altFt != null && a.altFt > maxAltFt) return false;
  return true;
}

/**
 * Which flag-based rules this aircraft trips, ignoring where it is. Used both
 * by `classify` and by the overhead predictor, which needs to know whether a
 * contact 40nm away is worth projecting long before it is close enough to
 * alert on.
 */
export function flagReasons(a, cfg) {
  const reasons = [];
  const flags = a.dbFlags;

  if (cfg.rules.military && flags & DB_MILITARY) reasons.push('military');
  if (cfg.rules.interesting && flags & DB_INTERESTING) reasons.push('interesting');
  if (cfg.rules.pia && flags & DB_PIA) reasons.push('pia');
  if (cfg.rules.ladd && flags & DB_LADD) reasons.push('ladd');

  // Only bother with the noisy no-callsign rule if nothing better already
  // caught this aircraft; a flagged military jet with a blank callsign is
  // already an alert, and listing both reasons just dilutes the headline.
  if (cfg.rules.noCallsign && !a.callsign && reasons.length === 0) {
    reasons.push('noCallsign');
  }

  return reasons;
}

/**
 * Which alert rules does this aircraft trip right now? Returns a list of
 * reason keys, empty if it is of no interest or out of range.
 */
export function classify(a, cfg) {
  if (!passesGlobalGates(a, cfg)) return [];

  const reasons = flagReasons(a, cfg);
  // The no-callsign rule carries tighter gates of its own.
  if (reasons.length === 1 && reasons[0] === 'noCallsign' && !passesNoCallsignGates(a, cfg)) {
    return [];
  }
  return reasons;
}

/**
 * Fill in type, registration and operator from the local tail database for
 * aircraft the feed could not name. The feed's own answer always wins when
 * it has one; this only fills genuine gaps.
 */
export function enrich(a, db) {
  if (!db || !a.unidentified) return a;
  const row = db.lookup(a.hex);
  if (!row) return a;

  a.registration = a.registration || row.registration;
  a.typeCode = a.typeCode || row.typeCode;
  a.typeName = a.typeName || row.typeName;
  a.operator = a.operator || row.operator;
  a.year = a.year || row.year;
  if (!a.dbFlags) a.dbFlags = row.dbFlags;
  a.unidentified = !a.typeCode && !a.registration;
  a.namedLocally = !a.unidentified;
  return a;
}
