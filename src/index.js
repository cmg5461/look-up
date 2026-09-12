#!/usr/bin/env node
import { config, validate } from './config.js';
import { fetchNearby } from './sources.js';
import { normalize, classify, flagReasons, enrich } from './rules.js';
import { predictOverhead } from './predict.js';
import { TailDb } from './taildb.js';
import { title, body, logLine } from './format.js';
import { notify } from './notify.js';
import { Tracker } from './tracker.js';

const args = new Set(process.argv.slice(2));
const runOnce = args.has('--once');
const testNotify = args.has('--test-notify');
const updateDb = args.has('--update-db');

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

async function testNotification() {
  log('Sending a test notification to every configured target...');
  const errors = await notify({
    title: 'look-up test - MILITARY + NO CALLSIGN',
    message:
      'If you can read this on your phone, alerts are wired up correctly.\n' +
      'This is a test, not a real contact.',
    reasons: ['military'],
  });
  if (errors.length) {
    console.error('Failed:', errors.join('; '));
    process.exitCode = 1;
  } else {
    log('Sent. Check your phone.');
  }
}

/**
 * Make sure the local tail database is present and reasonably fresh.
 * Returns a usable TailDb, or null if it could not be obtained - a missing
 * database degrades alert detail, it does not stop the watch.
 */
async function prepareTailDb({ force = false } = {}) {
  if (!config.taildb.enabled) return null;
  const db = new TailDb(config.taildb.path);
  const age = db.ageDays();
  const stale = age === null || age > config.taildb.maxAgeDays;

  if (force || stale) {
    const why = age === null ? 'not present' : `${age.toFixed(1)} days old`;
    log(`Tail database ${why}, downloading (~8MB)...`);
    try {
      const bytes = await db.download();
      log(`Tail database ready: ${(bytes / 1048576).toFixed(0)}MB at ${config.taildb.path}`);
    } catch (err) {
      console.error(`[warn] tail database download failed: ${err.message}`);
      if (age === null) {
        console.error('[warn] continuing without it; unnamed aircraft will show as UNIDENTIFIED');
        return null;
      }
      console.error('[warn] falling back to the existing local copy');
    }
  }
  return db.open() ? db : null;
}

async function poll(tracker, taildb) {
  // Dead reckoning needs a much wider net than the alert radius: an aircraft
  // that will be overhead in six minutes is a long way off right now.
  const searchNm = config.overhead.enabled
    ? Math.max(config.radiusNm, config.overhead.searchRadiusNm)
    : config.radiusNm;

  const { aircraft, source } = await fetchNearby({ radiusNm: searchNm });
  const now = Date.now();
  const overheadOnly = config.overhead.enabled && config.overhead.only;

  const candidates = [];
  for (const raw of aircraft) {
    if (!raw?.hex) continue;
    const a = normalize(raw, config);
    const here = classify(a, config);

    if (config.overhead.enabled) {
      // Ask "is this worth projecting?" from the flags alone - `classify`
      // would have already discarded it for being outside the alert radius,
      // which is exactly where interesting approaching traffic lives.
      const flagged = flagReasons(a, config);
      if (config.overhead.scope === 'all' || flagged.length) {
        const prediction = predictOverhead(a, config);
        if (prediction) {
          a.prediction = prediction;
          candidates.push({
            a: enrich(a, taildb),
            reasons: [...new Set([...flagged, 'overhead'])],
          });
          continue;
        }
      }
    }

    // Interesting, but its track will not bring it through your patch of sky.
    if (here.length && !overheadOnly) {
      candidates.push({ a: enrich(a, taildb), reasons: here });
    }
  }

  // Soonest first. A predicted pass is ranked by when it arrives; anything
  // merely nearby sorts after all of them, by distance.
  const rank = ({ a }) =>
    a.prediction ? a.prediction.etaSec : 1e6 + (a.distNm ?? 1e5);
  candidates.sort((x, y) => rank(x) - rank(y));

  let alerted = 0;
  for (const { a, reasons } of candidates) {
    if (!tracker.shouldAlert(a.hex, reasons, config, now)) {
      log(`  (known) ${logLine(a, reasons)}`);
      continue;
    }
    alerted++;
    log(`  ALERT   ${logLine(a, reasons)}`);
    const errors = await notify({
      title: title(a, reasons),
      message: body(a, reasons),
      reasons,
    });
    if (errors.length) console.error(`  [warn] push failed - ${errors.join('; ')}`);
  }

  tracker.prune(config, now);
  tracker.save();

  log(
    `${String(aircraft.length).padStart(3)} aircraft in ${searchNm}nm via ${source}` +
      ` | ${candidates.length} of interest | ${alerted} alerted`,
  );
}

async function main() {
  const problems = validate();
  if (problems.length) {
    console.error('Configuration problems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    console.error('\nRun `npm run init` to create .env, then fill it in.');
    console.error('See docs/setup.md for a step-by-step walkthrough.');
    process.exit(1);
  }

  if (testNotify) return testNotification();

  if (updateDb) {
    await prepareTailDb({ force: true });
    return;
  }

  const taildb = await prepareTailDb();
  const tracker = new Tracker(config.statePath);
  const enabled = Object.entries(config.rules)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(', ');

  log(
    `Watching ${config.radiusNm}nm around ${config.lat.toFixed(4)}, ${config.lon.toFixed(4)}` +
      ` every ${config.pollSeconds}s. Rules: ${enabled}.`,
  );
  if (config.overhead.enabled) {
    const o = config.overhead;
    log(
      `Overhead prediction: ${o.minElevationDeg}° cone, ${o.maxSlantNm}nm max slant,` +
        ` ${o.lookaheadMinutes}min lookahead, scope=${o.scope}` +
        `${o.only ? ', predicted passes only' : ''}.`,
    );
  }
  if (!taildb) log('No local tail database - relying on feed enrichment only.');

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('Stopping, saving state...');
    tracker.save();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let backoff = 0;
  for (;;) {
    try {
      await poll(tracker, taildb);
      backoff = 0;
    } catch (err) {
      // Both feeds are volunteer-run and do go down. Back off rather than
      // spinning, and keep the watch alive.
      backoff = Math.min(backoff ? backoff * 2 : config.pollSeconds, 600);
      console.error(`[${stamp()}] poll failed: ${err.message} - retrying in ${backoff}s`);
      if (runOnce) process.exitCode = 1;
    }
    if (runOnce) break;
    const wait = (backoff || config.pollSeconds) * 1000;
    await new Promise((r) => setTimeout(r, wait));
  }
  tracker.save();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
