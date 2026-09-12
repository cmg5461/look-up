import { config } from './config.js';
import { REASONS } from './rules.js';

function priorityFor(reasons, notify) {
  if (reasons.includes('military')) return notify.priorityMilitary;
  if (reasons.some((r) => r === 'interesting' || r === 'pia' || r === 'ladd')) {
    return notify.prioritySpecial;
  }
  return notify.priorityNoCallsign;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Publish via ntfy's JSON endpoint rather than the header-based one, so
 * non-ASCII characters in the title survive intact.
 */
async function sendNtfy({ title, message, priority, tags }, notify) {
  const headers = { 'content-type': 'application/json' };
  if (notify.ntfyToken) headers.authorization = `Bearer ${notify.ntfyToken}`;

  const res = await fetch(notify.ntfyServer, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      topic: notify.ntfyTopic,
      title,
      message,
      priority: clamp(Math.round(priority), 1, 5),
      tags,
    }),
  });
  if (!res.ok) {
    throw new Error(`ntfy HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  }
}

async function sendPushover({ title, message, priority }, notify) {
  // Pushover's scale is -2..2, and 2 (emergency) requires retry/expire
  // parameters, so cap at 1 (high priority) to keep this simple.
  const mapped = clamp(Math.round(priority) - 3, -2, 1);
  const form = new URLSearchParams({
    token: notify.pushoverToken,
    user: notify.pushoverUser,
    title,
    message,
    priority: String(mapped),
  });
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`pushover HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  }
}

/**
 * Push an alert to every configured target. Never throws: a notification
 * failure must not take down the watch loop. Returns the list of errors.
 */
export async function notify({ title, message, reasons = [] }, cfg = config) {
  const n = cfg.notify;
  const priority = priorityFor(reasons, n);
  const tags = reasons.map((r) => REASONS[r]?.tag).filter(Boolean);
  const payload = { title, message, priority, tags };

  const jobs = [];
  if (n.ntfyTopic) jobs.push(['ntfy', sendNtfy(payload, n)]);
  if (n.pushoverToken && n.pushoverUser) jobs.push(['pushover', sendPushover(payload, n)]);

  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  return results
    .map((r, i) => (r.status === 'rejected' ? `${jobs[i][0]}: ${r.reason.message}` : null))
    .filter(Boolean);
}
