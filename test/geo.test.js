import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceNm,
  bearingDeg,
  destination,
  compass,
  elevationDeg,
  FT_PER_NM,
} from '../src/geo.js';

const close = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );

test('distance and destination are inverses', () => {
  for (const bearing of [0, 45, 90, 180, 270, 359]) {
    for (const nm of [0.1, 5, 60, 250]) {
      const p = destination(40.78, -73.96, bearing, nm);
      close(distanceNm(40.78, -73.96, p.lat, p.lon), nm, 1e-6, `${nm}nm on ${bearing}`);
      close(bearingDeg(40.78, -73.96, p.lat, p.lon), bearing, 1e-6, `bearing ${bearing}`);
    }
  }
});

test('destination wraps longitude across the antimeridian', () => {
  const p = destination(0, 179.9, 90, 60); // due east, over the line
  assert.ok(p.lon >= -180 && p.lon <= 180, `lon stayed in range, got ${p.lon}`);
  close(distanceNm(0, 179.9, p.lat, p.lon), 60, 1e-6, 'distance across antimeridian');
});

test('compass covers all 16 points and wraps at north', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(90), 'E');
  assert.equal(compass(180), 'S');
  assert.equal(compass(270), 'W');
  assert.equal(compass(360), 'N');
  assert.equal(compass(359), 'N', 'just short of north is still north');
  assert.equal(compass(22.5), 'NNE');
  assert.equal(new Set([...Array(16)].map((_, i) => compass(i * 22.5))).size, 16);
});

test('elevation angle: 45 degrees is where ground distance equals altitude', () => {
  const altFt = 30000;
  const altNm = altFt / FT_PER_NM;
  close(elevationDeg(altFt, altNm), 45, 1e-9, 'equal legs give 45 degrees');
  close(elevationDeg(altFt, 0), 90, 1e-9, 'directly overhead');
  assert.ok(elevationDeg(altFt, 1000) < 1, 'far away is near the horizon');
});

test('elevation is null when altitude is unknown', () => {
  assert.equal(elevationDeg(null, 5), null);
  assert.equal(elevationDeg(1000, null), null);
});
