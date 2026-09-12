import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, aircraftAt, perfectFit } from './fixture.js';
import { bubbleRadiusNm, predictOverhead, alertable } from '../src/predict.js';
import { FT_PER_NM } from '../src/geo.js';

/** What this aircraft means, in one word, for readable assertions. */
function verdict(spec, fit = undefined) {
  const a = aircraftAt(spec);
  const r = predictOverhead(a, config, fit === undefined ? perfectFit(a) : fit);
  if (!r) return 'nothing';
  if (r.projected) return 'pass';
  if (r.now.insideBubble) return 'observed';
  return r.held ?? 'nothing';
}

test('bubble radius: the treeline binds low, the ground cap binds high', () => {
  // At a 10 degree horizon the cone radius is alt/tan(10deg); the 1nm cylinder
  // wins below ~1,070ft, and the 3nm ground cap wins above ~10,000ft.
  const r = (ft) => Number(bubbleRadiusNm(ft, config).toFixed(2));
  assert.equal(r(400), 1.0, '400ft: cylinder wins');
  assert.equal(r(1000), 1.0, '1000ft: cylinder still wins');
  assert.equal(r(3000), 2.8, '3000ft: treeline cone binds');
  assert.equal(r(10000), 3.0, '10000ft: ground cap binds');
  assert.equal(r(30000), 3.0, '30000ft: ground cap binds');
  assert.equal(r(0), 0, 'on the ground is not overhead');
});

test('bubble radius is zero above the slant limit', () => {
  const tooHigh = config.overhead.maxSlantNm * FT_PER_NM;
  assert.equal(bubbleRadiusNm(tooHigh + 1, config), 0);
});

test('an aircraft tracking straight at you is predicted', () => {
  assert.equal(
    verdict({ bearing: 225, distanceNm: 40, track: 45, altFt: 30000, speedKt: 450 }),
    'pass',
  );
});

test('the ground cap rejects a high aircraft passing to one side', () => {
  const spec = { bearing: 225, distanceNm: 40, track: 45, altFt: 30000, speedKt: 450 };
  assert.equal(verdict({ ...spec, offsetNm: 2 }), 'pass', '2nm off: inside the 3nm cap');
  assert.equal(verdict({ ...spec, offsetNm: 4 }), 'nothing', '4nm off: outside it');
});

test('the cylinder catches a low helicopter the treeline would hide', () => {
  const spec = { bearing: 180, distanceNm: 3, track: 0, altFt: 400, speedKt: 110 };
  // At 400ft the cone alone reaches only 0.37nm; the 1nm cylinder extends it.
  assert.equal(verdict({ ...spec, offsetNm: 0.6 }), 'pass', 'inside the cylinder');
  assert.equal(verdict({ ...spec, offsetNm: 1.3 }), 'nothing', 'outside it');
});

test('an aircraft flying away is not predicted', () => {
  assert.equal(
    verdict({ bearing: 45, distanceNm: 10, track: 45, altFt: 30000, speedKt: 450 }),
    'nothing',
  );
});

test('a descending aircraft is projected against a shrinking bubble', () => {
  assert.equal(
    verdict({
      bearing: 270, distanceNm: 25, track: 90,
      altFt: 18000, speedKt: 300, verticalRateFpm: -1500,
    }),
    'pass',
  );
});

test('a fast low crossing is not stepped over', () => {
  // At 500kt and 400ft the whole crossing lasts about 5 seconds, which a fixed
  // 5s step would skip entirely. The adaptive coarse step must catch it.
  assert.equal(
    verdict({ bearing: 180, distanceNm: 20, track: 0, altFt: 400, speedKt: 500 }),
    'pass',
  );
});

test('peak elevation is refined, not read off the coarse samples', () => {
  // A helicopter passing directly overhead must report ~90 degrees. Without
  // the fine second pass this lands on whatever the coarse step happened to
  // sample - about 50 degrees - which points you at the wrong sky.
  const a = aircraftAt({ bearing: 180, distanceNm: 3, track: 0, altFt: 400, speedKt: 110 });
  const { projected } = predictOverhead(a, config, perfectFit(a));
  assert.ok(
    projected.peakElevationDeg > 85,
    `expected near-vertical, got ${projected.peakElevationDeg.toFixed(1)} degrees`,
  );
});

test('a pass that never clears the treeline is flagged as such', () => {
  const a = aircraftAt({
    bearing: 180, distanceNm: 3, track: 0, altFt: 400, speedKt: 110, offsetNm: 0.9,
  });
  const { projected } = predictOverhead(a, config, perfectFit(a));
  assert.equal(projected.belowHorizon, true);
  assert.ok(projected.peakElevationDeg < config.overhead.horizonDeg);
});

test('something already overhead is reported even when it cannot be projected', () => {
  // A hovering helicopter has no usable track or speed, so nothing can be
  // dead-reckoned - but it is still above your house, which is the point.
  const a = aircraftAt({
    bearing: 180, distanceNm: 0.1, altFt: 800, speedKt: 0, track: null,
  });
  const r = predictOverhead(a, config, null);
  assert.ok(r, 'reported');
  assert.equal(r.now.insideBubble, true);
  assert.equal(r.projected, null, 'nothing extrapolated');
  assert.ok(r.now.elevationDeg > 45, 'and it knows where to look');
});

test('a hovering aircraft that is NOT overhead stays silent', () => {
  const a = aircraftAt({ bearing: 180, distanceNm: 2, altFt: 800, speedKt: 0, track: null });
  assert.equal(predictOverhead(a, config, null), null);
});

test('the straightness gate never suppresses something already overhead', () => {
  // Passing no fit is the warm-up case. An aircraft in the bubble must still
  // be reported, or an orbiting helicopter above your house never alerts.
  const a = aircraftAt({ bearing: 180, distanceNm: 0.3, altFt: 900, speedKt: 65, track: 270 });
  const r = predictOverhead(a, config, null);
  assert.ok(r, 'reported despite having no fit');
  assert.equal(r.now.insideBubble, true);
});

test('without a trusted fit, an approaching aircraft is held, not projected', () => {
  const spec = { bearing: 225, distanceNm: 40, track: 45, altFt: 30000, speedKt: 450 };
  assert.equal(verdict(spec, null), 'warming-up', 'no history yet');
  assert.equal(
    verdict(spec, { residual: 0.05, heading: 45, speedKt: 450 }),
    'unsteady',
    'fit says it is turning',
  );
  assert.equal(verdict(spec, { residual: 0.001, heading: 45, speedKt: 450 }), 'pass');
});

test('held is only reported for aircraft that would otherwise have crossed', () => {
  // An aircraft flying away is simply of no interest; it should not be
  // reported as "held", which would fill the log with irrelevant lines.
  assert.equal(
    verdict({ bearing: 45, distanceNm: 10, track: 45, altFt: 30000, speedKt: 450 }, null),
    'nothing',
  );
});

test('aircraft without a position are ignored', () => {
  assert.equal(predictOverhead({ lat: null, lon: null, altFt: 1000 }, config, null), null);
  assert.equal(predictOverhead({ lat: 40, lon: -73, altFt: null }, config, null), null);
});

test('a projection further out than the alert window is watched, not alerted', () => {
  // 40nm at 450kt is about 5 minutes away - far enough that holding heading
  // to within 4 degrees is an assumption, not an observation.
  const far = aircraftAt({ bearing: 225, distanceNm: 40, track: 45, altFt: 30000, speedKt: 450 });
  const r = predictOverhead(far, config, perfectFit(far));
  assert.ok(r.projected, 'the crossing is still predicted');
  assert.ok(r.projected.etaSec > config.overhead.alertWithinSec, 'and it is beyond the window');
  assert.equal(alertable(r, config), false, 'but it does not earn a push yet');
});

test('the same aircraft becomes alertable once it is close enough', () => {
  const near = aircraftAt({ bearing: 225, distanceNm: 10, track: 45, altFt: 30000, speedKt: 450 });
  const r = predictOverhead(near, config, perfectFit(near));
  assert.ok(r.projected.etaSec <= config.overhead.alertWithinSec);
  assert.equal(alertable(r, config), true);
});

test('the alert window never gates something already overhead', () => {
  // An observation is not a prediction, so it is not subject to a prediction's
  // shelf life. A hovering helicopter has no ETA at all and must still alert.
  const a = aircraftAt({ bearing: 180, distanceNm: 0.1, altFt: 800, speedKt: 0, track: null });
  const r = predictOverhead(a, config, null);
  assert.equal(r.projected, null, 'nothing extrapolated');
  assert.equal(alertable(r, config), true, 'and it alerts anyway');
});
