/** Signed difference b - a, wrapped to [-180, 180]. */
function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/**
 * A rolling window of recent observations per aircraft, used to decide
 * whether a track is steady enough to extrapolate from.
 *
 * Dead reckoning is only honest if the aircraft is actually flying straight.
 * One sample cannot tell you that - a jet halfway round a turn looks exactly
 * like a jet flying straight on that heading, and projecting it produces a
 * confidently wrong answer. Two or three samples across successive polls
 * make the difference obvious.
 *
 * Kept in memory only. It rebuilds within a couple of polls after a restart,
 * and persisting it would mean reasoning about stale positions on startup.
 */
export class TrackHistory {
  #byHex = new Map();
  #keep;

  constructor({ keep = 6 } = {}) {
    this.#keep = keep;
  }

  /** Record one observation. Ignores aircraft without a usable fix. */
  record(a, now = Date.now()) {
    if (a.lat == null || a.track == null || a.altFt == null) return;
    let samples = this.#byHex.get(a.hex);
    if (!samples) this.#byHex.set(a.hex, (samples = []));

    // The feed repeats the same position between polls when an aircraft has
    // not been heard from; recording those would fake a steady track out of
    // no new information at all.
    const last = samples[samples.length - 1];
    if (last && last.lat === a.lat && last.lon === a.lon && last.track === a.track) {
      return;
    }

    samples.push({
      t: now,
      lat: a.lat,
      lon: a.lon,
      track: a.track,
      altFt: a.altFt,
      groundSpeedKt: a.groundSpeedKt,
    });
    if (samples.length > this.#keep) samples.shift();
  }

  /**
   * How steady has this aircraft been? Returns null when there is not enough
   * history to judge, which callers should treat as "not yet", not "fine".
   */
  steadiness(hex, cfg) {
    const o = cfg.overhead;
    const samples = this.#byHex.get(hex);
    if (!samples || samples.length < o.minSamples) return null;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanSec = (last.t - first.t) / 1000;
    if (spanSec < o.minSpanSeconds) return null;

    // Net change across the window rather than the largest step between
    // samples: a sustained turn accumulates, while reporting jitter cancels
    // itself out and should not veto an otherwise straight track.
    const turnDeg = Math.abs(angleDiff(first.track, last.track));
    const turnRate = turnDeg / spanSec;

    const speedDriftPct =
      first.groundSpeedKt > 0 && last.groundSpeedKt != null
        ? (Math.abs(last.groundSpeedKt - first.groundSpeedKt) / first.groundSpeedKt) * 100
        : 0;

    return {
      samples: samples.length,
      spanSec,
      turnDeg,
      turnRate,
      speedDriftPct,
      steady: turnRate <= o.maxTurnRateDegSec && speedDriftPct <= o.maxSpeedDriftPct,
    };
  }

  /** Forget aircraft not heard from in a while, to bound memory. */
  prune(now = Date.now(), ttlMs = 900_000) {
    for (const [hex, samples] of this.#byHex) {
      if (now - samples[samples.length - 1].t > ttlMs) this.#byHex.delete(hex);
    }
  }

  get size() {
    return this.#byHex.size;
  }
}
