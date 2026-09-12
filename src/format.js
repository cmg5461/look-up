import { REASONS } from './rules.js';

/** Compact duration: "45s", "4m", "4m10s". */
export function duration(sec) {
  const t = Math.round(sec);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  const r = t % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

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
  if (a.overhead) {
    // Lead with the thing you can act on: how long until you should look up.
    const { now, projected } = a.overhead;
    const when = now.insideBubble
      ? 'OVERHEAD NOW'
      : `OVERHEAD in ${duration(projected.etaSec)}`;
    const flags = reasons.filter((r) => r !== 'overhead');
    const what = flags.length ? `${flags.map((r) => REASONS[r].label).join(' + ')} ` : '';
    return `${when} - ${what}${describe(a)}`;
  }

  const labels = reasons.map((r) => REASONS[r].label).join(' + ');
  const where =
    a.elevationDeg != null && a.elevationDeg >= 60
      ? 'directly overhead'
      : a.compass
        ? `${round(a.distNm, 1)} nm ${a.compass}`
        : 'nearby';
  return `${labels} - ${describe(a)} ${where}`;
}

/**
 * Where to look, when, and for how long.
 *
 * `projected === null` means nothing was extrapolated - a hovering helicopter,
 * or one with no track to reckon from. Branch on that once, here, rather than
 * letting every line re-derive it from a null duration or a sentinel.
 */
function overheadLines(a) {
  const { now, projected } = a.overhead;
  const lines = [];

  if (now.insideBubble) {
    lines.push(
      projected
        ? `In your sky NOW, for about ${duration(projected.durationSec)} more.`
        : `In your sky NOW, ${round(now.elevationDeg)}° up to the ${now.compass}.`,
    );
  } else {
    lines.push(
      `Enters your sky from the ${projected.entryCompass} in ` +
        `${duration(projected.etaSec)}, overhead for about ` +
        `${duration(projected.durationSec)}.`,
    );
  }

  if (projected ? projected.belowHorizon : now.belowHorizon) {
    lines.push('Stays below your treeline - close enough to hear, probably not to see.');
  }

  lines.push(
    projected
      ? `Peak ${round(projected.peakElevationDeg)}° up` +
        `${now.insideBubble ? '' : ` at ${duration(projected.peakSec)}`}` +
        `, closest ${round(projected.minSlantNm, 1)} nm.`
      : 'Hovering or no track reported - position is current, nothing projected.',
  );

  const vs =
    a.verticalRateFpm == null || Math.abs(a.verticalRateFpm) < 200
      ? 'level'
      : `${a.verticalRateFpm > 0 ? 'climbing' : 'descending'} ` +
        `${round(Math.abs(a.verticalRateFpm))} fpm`;
  // Speed and track can both be absent - a hovering helicopter reports
  // neither - so build this from whatever is actually known.
  const motion = [
    a.groundSpeedKt == null ? null : `${round(a.groundSpeedKt)} kt`,
    a.track == null ? null : `on ${round(a.track)}°`,
  ].filter(Boolean);
  lines.push(
    `Now: ${round(now.groundNm, 1)} nm ${now.compass}, ${round(a.altFt)} ft, ${vs}` +
      `${motion.length ? `, ${motion.join(' ')}` : ''}.`,
  );

  // Dead reckoning assumes it holds course. Say so when that is a stretch.
  if (projected && projected.confidence !== 'high') {
    lines.push(
      `Projection assumes it holds course - ${projected.confidence} confidence at this range.`,
    );
  }
  return lines;
}

export function body(a, reasons) {
  const lines = [];

  if (a.overhead) lines.push(...overheadLines(a), '');

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

  // With an overhead block present, its "Now:" line already gives altitude,
  // speed, distance and bearing - no need to state all of it twice.
  if (!a.overhead) {
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
  const eta = a.overhead
    ? (a.overhead.now.insideBubble
        ? 'NOW'
        : `T-${duration(a.overhead.projected.etaSec)}`
      ).padStart(7)
    : '       ';
  const dist = a.distNm == null ? '  ?  ' : `${a.distNm.toFixed(1).padStart(5)}nm`;
  const alt = a.altFt == null ? '     ?' : `${String(a.altFt).padStart(6)}ft`;
  const dir = a.compass ? a.compass.padEnd(3) : '  ?';
  return `${eta} ${dist} ${dir} ${alt}  ${describe(a).padEnd(28)} [${tags}]`;
}
