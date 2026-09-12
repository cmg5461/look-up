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
  const p = a.prediction;
  if (p) {
    // Lead with the thing you can act on: how long until you should look up.
    const when = p.alreadyInside ? 'OVERHEAD NOW' : `OVERHEAD in ${duration(p.etaSec)}`;
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

/** The projected-pass block: where to look, when, and for how long. */
function predictionLines(a) {
  const p = a.prediction;
  const lines = [];

  lines.push(
    p.alreadyInside
      ? `In your sky NOW, for about ${duration(p.durationSec)} more.`
      : `Enters your sky from the ${p.entryCompass} in ${duration(p.etaSec)}, ` +
        `overhead for about ${duration(p.durationSec)}.`,
  );
  if (p.belowHorizon) {
    lines.push(
      'Stays below your treeline - close enough to hear, probably not to see.',
    );
  }
  lines.push(
    `Peak ${round(p.peakElevationDeg)}° up` +
      `${p.alreadyInside ? '' : ` at ${duration(p.peakSec)}`}` +
      `, closest ${round(p.minSlantNm, 1)} nm.`,
  );

  const vs =
    a.verticalRateFpm == null || Math.abs(a.verticalRateFpm) < 200
      ? 'level'
      : a.verticalRateFpm > 0
        ? `climbing ${round(Math.abs(a.verticalRateFpm))} fpm`
        : `descending ${round(Math.abs(a.verticalRateFpm))} fpm`;
  lines.push(
    `Now: ${round(a.distNm, 1)} nm ${a.compass}, ${round(a.altFt)} ft, ${vs}, ` +
      `${round(a.groundSpeedKt)} kt on ${round(a.track)}°.`,
  );

  // Dead reckoning assumes it holds this track. Say so when that is a stretch.
  if (p.confidence !== 'high') {
    lines.push(
      `Projection assumes it holds course - ${p.confidence} confidence at this range.`,
    );
  }
  return lines;
}

export function body(a, reasons) {
  const lines = [];

  if (a.prediction) lines.push(...predictionLines(a), '');

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

  // With a prediction present, its "Now:" line already gives altitude, speed,
  // distance and bearing - no need to state all of it twice.
  if (!a.prediction) {
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
  const eta = a.prediction
    ? (a.prediction.alreadyInside ? 'NOW' : `T-${duration(a.prediction.etaSec)}`).padStart(7)
    : '       ';
  const dist = a.distNm == null ? '  ?  ' : `${a.distNm.toFixed(1).padStart(5)}nm`;
  const alt = a.altFt == null ? '     ?' : `${String(a.altFt).padStart(6)}ft`;
  const dir = a.compass ? a.compass.padEnd(3) : '  ?';
  return `${eta} ${dist} ${dir} ${alt}  ${describe(a).padEnd(28)} [${tags}]`;
}
