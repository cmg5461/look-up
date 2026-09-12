import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, flyPath } from './fixture.js';
import { TrackHistory } from '../src/history.js';

const THRESHOLD = config.overhead.maxPathResidual;

/** Fly a path and return its fit. */
function fitOf(opts) {
  const h = new TrackHistory(config);
  const hex = flyPath(h, opts);
  return h.fit(hex, config);
}

const isStraight = (fit) => fit != null && fit.residual <= THRESHOLD;

test('a straight track fits with essentially no residual', () => {
  for (const speedKt of [110, 250, 450]) {
    const fit = fitOf({ speedKt });
    assert.ok(fit.residual < 0.001, `${speedKt}kt: residual ${fit.residual}`);
    assert.ok(isStraight(fit));
  }
});

test('the residual is independent of speed', () => {
  // This is why it is reported as a fraction of distance travelled. An
  // absolute residual would be strict on jets and useless on helicopters.
  const fast = fitOf({ speedKt: 450, turnDegSec: 0.2 });
  const slow = fitOf({ speedKt: 110, turnDegSec: 0.2 });
  assert.ok(
    Math.abs(fast.residual - slow.residual) < 1e-4,
    `450kt gave ${fast.residual}, 110kt gave ${slow.residual}`,
  );
});

test('a turn is rejected and a slow drift is not', () => {
  assert.ok(isStraight(fitOf({ turnDegSec: 0.1 })), '0.1 deg/s drift is usable');
  assert.ok(!isStraight(fitOf({ turnDegSec: 0.2 })), '0.2 deg/s is not');
  assert.ok(!isStraight(fitOf({ turnDegSec: 0.83 })), 'a standard-rate turn is not');
});

test('deceleration on a dead-straight path is also rejected', () => {
  // The fit is constant *velocity*, so a deceleration curves x(t) and y(t)
  // even when the ground track is perfectly straight. Right heading, wrong
  // timing - the projection would arrive early.
  assert.ok(!isStraight(fitOf({ decelToKt: 300 })), '450 -> 300kt');
  assert.ok(isStraight(fitOf({ decelToKt: 420 })), '450 -> 420kt is within tolerance');
});

test('position jitter on a straight track stays well under the threshold', () => {
  const h = new TrackHistory(config);
  const t0 = Date.now();
  let lat = 40.6;
  let lon = -74.2;
  for (let i = 0; i < 4; i++) {
    const jitter = () => (Math.random() - 0.5) * 2 * (0.03 / 60); // ~180ft
    h.record({ hex: 'j', lat: lat + jitter(), lon: lon + jitter() }, t0 + i * 30_000);
    lat += 0.0442;
    lon += 0.0442;
  }
  const fit = h.fit('j', config);
  assert.ok(fit.residual < THRESHOLD / 3, `noise floor ${fit.residual} vs ${THRESHOLD}`);
});

test('heading is recovered exactly on the axes a y=mx+b fit would break on', () => {
  // Fitting x and y separately against time is orientation-free. Fitting y
  // against x would have infinite slope due north and blow up.
  for (const heading of [0, 90, 180, 270, 359]) {
    const fit = fitOf({ heading, turnDegSec: 0 });
    const err = Math.abs(((fit.heading - heading + 540) % 360) - 180);
    assert.ok(err < 0.1, `heading ${heading}: fitted ${fit.heading.toFixed(2)}`);
  }
});

test('fitted speed matches the flown speed', () => {
  for (const speedKt of [110, 450]) {
    const fit = fitOf({ speedKt });
    assert.ok(Math.abs(fit.speedKt - speedKt) < 1, `expected ${speedKt}, got ${fit.speedKt}`);
  }
});

test('too little history returns null, which means "not yet" and not "fine"', () => {
  for (const samples of [1, 2, 3]) {
    assert.equal(fitOf({ samples }), null, `${samples} sample(s)`);
  }
  assert.notEqual(fitOf({ samples: 4 }), null, '4 samples is enough');
});

test('a window shorter than minSpanSeconds returns null', () => {
  // Four samples only five seconds apart say nothing about a sustained turn.
  assert.equal(fitOf({ samples: 4, stepSec: 5 }), null);
});

test('repeated positions are not recorded as fresh observations', () => {
  // The feed repeats the last known position when an aircraft has not been
  // heard from. Counting those would manufacture a steady track out of no
  // new information at all.
  const h = new TrackHistory(config);
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) h.record({ hex: 'r', lat: 40.6, lon: -74.2 }, t0 + i * 30_000);
  assert.equal(h.fit('r', config), null, 'eight identical fixes are still one observation');
});

test('the retained window tracks minSamples rather than a fixed cap', () => {
  // A hardcoded cap of 8 meant raising OVERHEAD_MIN_SAMPLES above it silently
  // starved the fit, suppressing every projection forever.
  const many = structuredClone(config);
  many.overhead.minSamples = 12;
  const h = new TrackHistory(many);
  const hex = flyPath(h, { samples: 14 });
  assert.notEqual(h.fit(hex, many), null, 'minSamples=12 still produces a fit');
});

test('stale aircraft are pruned', () => {
  const h = new TrackHistory(config);
  const hex = flyPath(h, {});
  const later = Date.now() + 60 * 60_000;
  h.prune(later);
  assert.equal(h.fit(hex, config), null, 'forgotten after an hour');
});

test('recent aircraft survive pruning', () => {
  const h = new TrackHistory(config);
  const hex = flyPath(h, {});
  h.prune(Date.now());
  assert.notEqual(h.fit(hex, config), null);
});
