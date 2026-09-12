import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env without pulling in a dependency.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const str = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const bool = (key, fallback) => {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};
const num = (key, fallback) => {
  const v = str(key);
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${v}"`);
  return n;
};
/** Optional number: blank means "no limit". */
const optNum = (key) => (str(key) === '' ? null : num(key));

export const ROOT_DIR = ROOT;

export const config = {
  lat: num('LAT', NaN),
  lon: num('LON', NaN),
  radiusNm: num('RADIUS_NM', 25),

  pollSeconds: num('POLL_SECONDS', 30),

  rules: {
    military: bool('ALERT_MILITARY', true),
    noCallsign: bool('ALERT_NO_CALLSIGN', true),
    interesting: bool('ALERT_INTERESTING', true),
    pia: bool('ALERT_PIA', true),
    ladd: bool('ALERT_LADD', false),
  },

  // Global gates, applied to every candidate.
  maxAltFt: optNum('MAX_ALT_FT'),
  minElevationDeg: optNum('MIN_ELEVATION_DEG'),
  ignoreGround: bool('IGNORE_GROUND', true),

  // Tighter gates for the no-callsign rule, which is much noisier
  // than the others. Blank means "fall back to the global gate".
  noCallsign: {
    maxNm: optNum('NO_CALLSIGN_MAX_NM'),
    maxAltFt: optNum('NO_CALLSIGN_MAX_ALT_FT'),
    skipUnpositioned: bool('NO_CALLSIGN_SKIP_MLAT_TISB', true),
  },

  // Re-alert about the same aircraft only after it has been out of
  // range (or unheard) for this long.
  revisitMinutes: num('REVISIT_MINUTES', 30),
  // Hard ceiling on how often one aircraft can alert, even if it
  // picks up a new reason while still overhead.
  reAlertMinutes: num('RE_ALERT_MINUTES', 10),

  notify: {
    ntfyTopic: str('NTFY_TOPIC'),
    ntfyServer: str('NTFY_SERVER', 'https://ntfy.sh').replace(/\/+$/, ''),
    ntfyToken: str('NTFY_TOKEN'),
    pushoverToken: str('PUSHOVER_TOKEN'),
    pushoverUser: str('PUSHOVER_USER'),
    // ntfy's scale: 3 is an ordinary notification, 4 is a long vibration
    // burst, 5 repeats it and bypasses Do Not Disturb. Default to ordinary.
    priorityMilitary: num('PRIORITY_MILITARY', 3),
    prioritySpecial: num('PRIORITY_SPECIAL', 3),
    priorityNoCallsign: num('PRIORITY_NO_CALLSIGN', 3),
  },

  // Dead-reckoning: project aircraft forward and alert on the ones whose
  // tracks will carry them through the patch of sky you can actually see.
  overhead: {
    enabled: bool('OVERHEAD', true),
    // Only alert on predicted passes, suppressing plain in-radius alerts for
    // aircraft that will never come overhead.
    only: bool('OVERHEAD_ONLY', true),
    // 'flagged' projects only aircraft that trip a rule (military, PIA, ...);
    // 'all' projects every aircraft, which means every airliner too.
    scope: str('OVERHEAD_SCOPE', 'flagged').toLowerCase(),
    // Your local horizon: how far above level the treeline, rooftops or
    // terrain sit. Below this you see nothing, whatever the geometry says.
    horizonDeg: num('OVERHEAD_HORIZON_DEG', 10),
    // How far away horizontally still counts as "overhead". Binds for high
    // aircraft, where the horizon angle alone would sweep in half the county.
    maxGroundNm: num('OVERHEAD_MAX_GROUND_NM', 3),
    // A cylinder unioned onto the cone: anything this close horizontally
    // counts whatever its elevation. Catches low traffic that the treeline
    // would otherwise hide - it only reaches below the altitude where the
    // cone is narrower than this, about 1,070ft at 10 degrees and 1nm.
    cylinderNm: num('OVERHEAD_CYLINDER_NM', 1),
    maxSlantNm: num('OVERHEAD_MAX_SLANT_NM', 25),
    lookaheadMinutes: num('OVERHEAD_LOOKAHEAD_MIN', 6),
    stepSeconds: num('OVERHEAD_STEP_SECONDS', 5),
    minSpeedKt: num('OVERHEAD_MIN_SPEED_KT', 40),
    // How far out to fetch. Must comfortably exceed how far a fast aircraft
    // travels within the lookahead window, or it appears already on top of you.
    searchRadiusNm: num('OVERHEAD_SEARCH_NM', 60),
  },

  // Local tail database, used to name aircraft the aggregator APIs serve
  // stale or empty rows for.
  taildb: {
    enabled: bool('TAILDB', true),
    path: str('TAILDB_PATH', path.join(ROOT, 'data', 'aircraft.csv')),
    maxAgeDays: num('TAILDB_MAX_AGE_DAYS', 14),
  },

  statePath: str('STATE_PATH', path.join(ROOT, 'state.json')),
  userAgent: str('USER_AGENT', 'look-up/1.0 (personal aircraft alerter)'),
};

export function validate(cfg = config) {
  const problems = [];
  if (!Number.isFinite(cfg.lat) || cfg.lat < -90 || cfg.lat > 90) {
    problems.push('LAT must be set to your latitude in decimal degrees (-90..90).');
  }
  if (!Number.isFinite(cfg.lon) || cfg.lon < -180 || cfg.lon > 180) {
    problems.push('LON must be set to your longitude in decimal degrees (-180..180).');
  }
  if (cfg.radiusNm <= 0 || cfg.radiusNm > 250) {
    problems.push('RADIUS_NM must be between 1 and 250 (the upstream API caps at 250).');
  }
  if (cfg.pollSeconds < 5) {
    problems.push('POLL_SECONDS must be at least 5; these feeds are free, do not hammer them.');
  }
  if (!Object.values(cfg.rules).some(Boolean)) {
    problems.push('All alert rules are disabled, so nothing would ever fire.');
  }
  const o = cfg.overhead;
  if (o.enabled) {
    if (o.horizonDeg < 0 || o.horizonDeg >= 90) {
      problems.push('OVERHEAD_HORIZON_DEG must be between 0 and 89 (it is your treeline, not a preference).');
    }
    if (o.maxGroundNm <= 0) problems.push('OVERHEAD_MAX_GROUND_NM must be positive.');
    if (o.cylinderNm < 0) problems.push('OVERHEAD_CYLINDER_NM cannot be negative (0 disables it).');
    if (o.maxSlantNm <= 0) problems.push('OVERHEAD_MAX_SLANT_NM must be positive.');
    if (o.stepSeconds <= 0) problems.push('OVERHEAD_STEP_SECONDS must be positive.');
    if (!['flagged', 'all'].includes(o.scope)) {
      problems.push(`OVERHEAD_SCOPE must be "flagged" or "all", got "${o.scope}".`);
    }
    // A 450kt jet covers 7.5nm a minute; if the search radius does not cover
    // the lookahead window, aircraft materialise already inside the bubble.
    const reach = 500 * (o.lookaheadMinutes / 60);
    if (o.searchRadiusNm < reach) {
      problems.push(
        `OVERHEAD_SEARCH_NM (${o.searchRadiusNm}) is too small for ` +
          `OVERHEAD_LOOKAHEAD_MIN (${o.lookaheadMinutes}): a fast aircraft covers ` +
          `~${Math.ceil(reach)}nm in that time. Raise it or shorten the lookahead.`,
      );
    }
    if (o.searchRadiusNm > 250) {
      problems.push('OVERHEAD_SEARCH_NM must be 250 or less (the upstream API caps there).');
    }
  }
  const hasNtfy = Boolean(cfg.notify.ntfyTopic);
  const hasPushover = Boolean(cfg.notify.pushoverToken && cfg.notify.pushoverUser);
  if (!hasNtfy && !hasPushover) {
    problems.push('No push target configured: set NTFY_TOPIC, or both PUSHOVER_TOKEN and PUSHOVER_USER.');
  }
  return problems;
}
