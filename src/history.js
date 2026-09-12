const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * A rolling window of recent positions per aircraft, used to decide whether
 * a track is steady enough to extrapolate from.
 *
 * Dead reckoning is only honest if the aircraft is actually flying straight
 * at a steady speed. One sample cannot tell you that - a jet halfway round a
 * turn looks exactly like a jet holding that heading - so a projection built
 * on it is confidently wrong.
 *
 * Kept in memory only. It rebuilds within a few polls after a restart, and
 * persisting it would mean reasoning about stale positions on startup.
 */
export class TrackHistory {
  #byHex = new Map();
  #keep;

  constructor({ keep = 8 } = {}) {
    this.#keep = keep;
  }

  /** Record one observation. Ignores aircraft without a usable fix. */
  record(a, now = Date.now()) {
    if (a.lat == null || a.lon == null) return;
    let samples = this.#byHex.get(a.hex);
    if (!samples) this.#byHex.set(a.hex, (samples = []));

    // The feed repeats the last known position between polls when an aircraft
    // has not been heard from. Recording those would manufacture a perfectly
    // steady track out of no new information at all.
    const last = samples[samples.length - 1];
    if (last && last.lat === a.lat && last.lon === a.lon) return;

    samples.push({ t: now / 1000, lat: a.lat, lon: a.lon });
    if (samples.length > this.#keep) samples.shift();
  }

  /**
   * Least-squares fit of the recent ground track, ignoring altitude.
   *
   * Two independent regressions, x against time and y against time, which
   * together describe motion at constant velocity - precisely the assumption
   * dead reckoning makes. So the residual is not an abstract goodness-of-fit:
   * it measures how wrong that assumption already is over the window just
   * observed. A turn curves the path; a deceleration curves x(t) and y(t)
   * even when the path is dead straight. One number catches both.
   *
   * Fitting x and y separately rather than fitting y against x matters: a
   * due-north track has infinite slope in y=mx+b and would blow up.
   *
   * The residual is reported as a fraction of distance travelled, which makes
   * it independent of speed - a 0.2 deg/s turn reads 0.0175 whether the
   * aircraft is doing 450 knots or 110.
   *
   * Returns null when there is not enough history, which callers must treat
   * as "not yet", not "fine".
   */
  fit(hex, cfg) {
    const o = cfg.overhead;
    const all = this.#byHex.get(hex);
    if (!all || all.length < o.minSamples) return null;

    // Always fit exactly the most recent N, so the residual stays comparable
    // against a fixed threshold rather than drifting with the window length.
    const s = all.slice(-o.minSamples);
    const spanSec = s[s.length - 1].t - s[0].t;
    if (spanSec < o.minSpanSeconds) return null;

    // Flat-earth frame in nautical miles about the first sample. Over the few
    // miles a window covers, the error from ignoring curvature is negligible.
    const kx = 60 * Math.cos(toRad(s[0].lat));
    const pts = s.map((p) => ({
      t: p.t - s[0].t,
      x: (p.lon - s[0].lon) * kx,
      y: (p.lat - s[0].lat) * 60,
    }));

    const n = pts.length;
    const mt = pts.reduce((acc, p) => acc + p.t, 0) / n;
    const mx = pts.reduce((acc, p) => acc + p.x, 0) / n;
    const my = pts.reduce((acc, p) => acc + p.y, 0) / n;

    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (const p of pts) {
      const dt = p.t - mt;
      stt += dt * dt;
      stx += dt * (p.x - mx);
      sty += dt * (p.y - my);
    }
    if (stt === 0) return null;

    const vx = stx / stt; // nm per second, east
    const vy = sty / stt; // nm per second, north

    let ss = 0;
    for (const p of pts) {
      const dt = p.t - mt;
      const ex = p.x - (mx + vx * dt);
      const ey = p.y - (my + vy * dt);
      ss += ex * ex + ey * ey;
    }
    const rmsNm = Math.sqrt(ss / n);

    const travelledNm = Math.hypot(
      pts[n - 1].x - pts[0].x,
      pts[n - 1].y - pts[0].y,
    );
    const residual = travelledNm > 0 ? rmsNm / travelledNm : 1;

    const speedKt = Math.hypot(vx, vy) * 3600;
    // Bearing from an (east, north) velocity vector.
    const heading = (toDeg(Math.atan2(vx, vy)) + 360) % 360;

    return {
      samples: n,
      spanSec,
      travelledNm,
      rmsNm,
      residual,
      heading,
      speedKt,
      straight: residual <= o.maxPathResidual && speedKt >= o.minSpeedKt,
    };
  }

  /** Forget aircraft not heard from in a while, to bound memory. */
  prune(now = Date.now(), ttlMs = 900_000) {
    const cutoff = (now - ttlMs) / 1000;
    for (const [hex, samples] of this.#byHex) {
      if (samples[samples.length - 1].t < cutoff) this.#byHex.delete(hex);
    }
  }

  get size() {
    return this.#byHex.size;
  }
}
