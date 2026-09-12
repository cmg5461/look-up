import { REASONS } from './rules.js';

const round = (n, places = 0) =>
  n == null ? null : Number(n.toFixed(places)).toLocaleString('en-US');

/** Best available human name for the aircraft. */
export function describe(a) {
  const name = a.callsign || a.registration || a.hex.toUpperCase();
  const type = a.typeName || a.typeCode;
  if (type) return `${name} (${type})`;
  return a.unidentified ? `${name} (UNIDENTIFIED)` : name;
}

export function title(a, reasons) {
  const labels = reasons.map((r) => REASONS[r].label).join(' + ');
  const where =
    a.elevationDeg != null && a.elevationDeg >= 60
      ? 'directly overhead'
      : a.compass
        ? `${round(a.distNm, 1)} nm ${a.compass}`
        : 'nearby';
  return `${labels} - ${describe(a)} ${where}`;
}

export function body(a, reasons) {
  const lines = [];

  if (!a.callsign && !reasons.includes('noCallsign')) {
    lines.push('No callsign broadcast.');
  }

  // The free feeds share a community tail database that is missing plenty of
  // rows, including some genuinely rare airframes. An unresolved record is a
  // gap in that database, NOT a boring aircraft - never let the alert imply
  // otherwise, and send the reader somewhere with a better database.
  if (a.unidentified) {
    lines.push(
      'NOT IN TAIL DATABASE - type and operator unknown. This feed cannot ' +
        'identify it; ADSBExchange often can. Worth a look.',
    );
  }
  if (a.operator) lines.push(`Operator: ${a.operator}`);
  if (a.registration && a.registration !== a.callsign) {
    lines.push(`Reg/tail: ${a.registration}${a.year ? ` (${a.year})` : ''}`);
  }

  const altText =
    a.altFt == null
      ? 'altitude unknown'
      : a.altFt === 0
        ? 'on the ground'
        : `${round(a.altFt)} ft`;
  const speedText = a.groundSpeedKt == null ? null : `${round(a.groundSpeedKt)} kt`;
  lines.push([altText, speedText].filter(Boolean).join(', '));

  if (a.distNm != null) {
    const look =
      a.elevationDeg == null
        ? ''
        : ` - look ${round(a.elevationDeg)}\u00b0 up`;
    lines.push(
      `${round(a.distNm, 1)} nm away, bearing ${round(a.bearing)}\u00b0 ${a.compass}${look}`,
    );
  }

  if (a.namedLocally) lines.push('(named from local tail database; the feed had no row)');
  if (a.squawk && a.squawk !== '1200') lines.push(`Squawk ${a.squawk}`);
  if (a.emergency && a.emergency !== 'none') {
    lines.push(`EMERGENCY: ${a.emergency}`);
  }
  if (a.positionSource !== 'adsb') {
    lines.push(`Position via ${a.positionSource.toUpperCase()} (not direct ADS-B)`);
  }

  // Send unidentified contacts to the tracker with the better tail
  // database, rather than to the one that just failed to name it.
  lines.push(
    a.unidentified
      ? `https://globe.adsbexchange.com/?icao=${a.hex}`
      : `https://globe.adsb.fi/?icao=${a.hex}`,
  );
  return lines.join('\n');
}

/** One-line summary for the console log. */
export function logLine(a, reasons) {
  const tags = reasons.map((r) => REASONS[r].tag).join(',');
  const dist = a.distNm == null ? '  ?  ' : `${a.distNm.toFixed(1).padStart(5)}nm`;
  const alt = a.altFt == null ? '     ?' : `${String(a.altFt).padStart(6)}ft`;
  const dir = a.compass ? a.compass.padEnd(3) : '  ?';
  return `${dist} ${dir} ${alt}  ${describe(a).padEnd(28)} [${tags}]`;
}
