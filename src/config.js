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
  const hasNtfy = Boolean(cfg.notify.ntfyTopic);
  const hasPushover = Boolean(cfg.notify.pushoverToken && cfg.notify.pushoverUser);
  if (!hasNtfy && !hasPushover) {
    problems.push('No push target configured: set NTFY_TOPIC, or both PUSHOVER_TOKEN and PUSHOVER_USER.');
  }
  return problems;
}
