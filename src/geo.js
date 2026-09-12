export const FT_PER_NM = 6076.12;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, in degrees true (0-360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * The point reached by travelling `distNm` from (lat, lon) along a constant
 * true bearing. Great-circle, so it stays honest over the tens of nautical
 * miles a dead-reckoned track can cover.
 */
export function destination(lat, lon, bearing, distNm) {
  const d = distNm / 3440.065;
  const b = toRad(bearing);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}

/** 16-point compass label for a true bearing. */
export function compass(deg) {
  return POINTS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/**
 * Angle above the horizon, in degrees, of an aircraft at `altFt`
 * whose ground track is `groundNm` away. Flat-earth approximation,
 * which is accurate to well under a degree at these ranges.
 * 90 means directly overhead, 0 means on the horizon.
 */
export function elevationDeg(altFt, groundNm) {
  if (altFt == null || groundNm == null) return null;
  if (groundNm <= 0) return 90;
  return toDeg(Math.atan2(altFt, groundNm * FT_PER_NM));
}
