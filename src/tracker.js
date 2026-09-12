import fs from 'node:fs';
import path from 'node:path';

const MINUTE = 60_000;

/**
 * Remembers which aircraft have already been alerted about, so a jet that
 * loiters overhead for twenty minutes produces one notification rather than
 * forty. State is persisted so a restart does not replay the whole sky.
 */
export class Tracker {
  #seen = new Map(); // hex -> { lastSeen, alertedAt, reasons: string[] }
  #path;
  #dirty = false;

  constructor(statePath) {
    this.#path = statePath;
    this.#load();
  }

  #load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.#path, 'utf8'));
      for (const [hex, entry] of Object.entries(saved.seen ?? {})) {
        this.#seen.set(hex, entry);
      }
    } catch {
      // No state file yet, or it is unreadable. Either way, start clean.
    }
  }

  save() {
    if (!this.#dirty) return;
    const seen = Object.fromEntries(this.#seen);
    try {
      fs.mkdirSync(path.dirname(this.#path), { recursive: true });
      fs.writeFileSync(this.#path, JSON.stringify({ seen }, null, 2));
      this.#dirty = false;
    } catch (err) {
      // Losing state costs at most a few duplicate alerts; not fatal.
      console.error(`[warn] could not write state: ${err.message}`);
    }
  }

  /**
   * Should this aircraft, tripping these reasons, produce a notification now?
   * Records the decision either way.
   */
  shouldAlert(hex, reasons, cfg, now = Date.now()) {
    const prior = this.#seen.get(hex);
    const entry = { lastSeen: now, alertedAt: prior?.alertedAt ?? 0, reasons: prior?.reasons ?? [] };
    this.#seen.set(hex, entry);
    this.#dirty = true;

    // Never alerted, or gone long enough that this counts as a fresh visit.
    const goneLongEnough =
      !prior || now - prior.lastSeen > cfg.revisitMinutes * MINUTE;
    if (goneLongEnough || entry.alertedAt === 0) {
      entry.alertedAt = now;
      entry.reasons = reasons;
      return true;
    }

    // Still around, but it has picked up a reason it did not have before
    // (e.g. it dropped its callsign, or squawked something new).
    const isNew = reasons.some((r) => !entry.reasons.includes(r));
    if (isNew && now - entry.alertedAt > cfg.reAlertMinutes * MINUTE) {
      entry.alertedAt = now;
      entry.reasons = [...new Set([...entry.reasons, ...reasons])];
      return true;
    }

    entry.reasons = [...new Set([...entry.reasons, ...reasons])];
    return false;
  }

  /** Drop aircraft not heard from in a long while, to bound the state file. */
  prune(cfg, now = Date.now()) {
    const ttl = Math.max(cfg.revisitMinutes, 120) * MINUTE;
    for (const [hex, entry] of this.#seen) {
      if (now - entry.lastSeen > ttl) {
        this.#seen.delete(hex);
        this.#dirty = true;
      }
    }
  }

  get size() {
    return this.#seen.size;
  }
}
