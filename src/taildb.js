import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DB_URL = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz';

/**
 * Local copy of the community tail database that maps a broadcast ICAO hex
 * address to type, registration and operator. The aggregator APIs do this
 * lookup for us, but they serve stale snapshots: adsb.lol returns no type at
 * all for AF3FA3, while this database correctly names it an E6.
 *
 * The file is ~617k rows, sorted by hex, so it is binary-searched on disk.
 * Loading it into a Map would cost ~170MB of heap; this costs a few reads.
 */
export class TailDb {
  #path;
  #typesPath;
  #fd = null;
  #size = 0;
  #cache = new Map();
  #types = null;

  constructor(dbPath) {
    this.#path = dbPath;
    this.#typesPath = `${dbPath}.types.json`;
  }

  get available() {
    return this.#fd !== null;
  }

  /** Age of the local copy in days, or null if absent. */
  ageDays() {
    try {
      return (Date.now() - fs.statSync(this.#path).mtimeMs) / 86_400_000;
    } catch {
      return null;
    }
  }

  /** Download and decompress the database. Returns bytes written. */
  async download() {
    fs.mkdirSync(path.dirname(this.#path), { recursive: true });
    const res = await fetch(DB_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`tail database download failed: HTTP ${res.status}`);

    const tmp = `${this.#path}.part`;
    await pipeline(
      Readable.fromWeb(res.body),
      zlib.createGunzip(),
      fs.createWriteStream(tmp),
    );
    fs.renameSync(tmp, this.#path);
    this.close();
    this.buildTypeIndex();
    return fs.statSync(this.#path).size;
  }

  /**
   * Some rows carry a type code but no description - AF3FA3 is "E6" with the
   * description left blank, which would alert as a bare, meaningless "E6".
   * Other rows for the same type do carry it ("Boeing E-6B Mercury"), so the
   * names are derived from the database itself rather than fetched from
   * anywhere else: for each type code, take the most common description
   * across every row that has one.
   */
  buildTypeIndex() {
    const counts = new Map();
    for (const line of fs.readFileSync(this.#path, 'utf8').split('\n')) {
      const f = line.split(';');
      const code = (f[2] ?? '').trim();
      const desc = (f[4] ?? '').trim();
      if (!code || !desc) continue;
      let byDesc = counts.get(code);
      if (!byDesc) counts.set(code, (byDesc = new Map()));
      byDesc.set(desc, (byDesc.get(desc) ?? 0) + 1);
    }
    const best = {};
    for (const [code, byDesc] of counts) {
      best[code] = [...byDesc].sort((a, b) => b[1] - a[1])[0][0];
    }
    fs.writeFileSync(this.#typesPath, JSON.stringify(best));
    this.#types = best;
    return Object.keys(best).length;
  }

  #typeName(code) {
    if (!code) return '';
    if (this.#types === null) {
      try {
        this.#types = JSON.parse(fs.readFileSync(this.#typesPath, 'utf8'));
      } catch {
        // Index missing or corrupt (an older download, say). Rebuild it from
        // the database we already have rather than going without names.
        try {
          this.buildTypeIndex();
        } catch {
          this.#types = {};
        }
      }
    }
    return this.#types[code] ?? '';
  }

  open() {
    if (this.#fd !== null) return true;
    try {
      this.#fd = fs.openSync(this.#path, 'r');
      this.#size = fs.fstatSync(this.#fd).size;
      return true;
    } catch {
      this.#fd = null;
      return false;
    }
  }

  close() {
    if (this.#fd !== null) fs.closeSync(this.#fd);
    this.#fd = null;
    this.#cache.clear();
  }

  /**
   * Byte offset of the start of the line containing `pos`, found by scanning
   * back to the previous newline. Seeking *forward* instead would skip the
   * line whenever `pos` landed exactly on its first byte, which silently
   * loses rows that the search then reports as absent.
   */
  #lineStart(pos) {
    if (pos <= 0) return 0;
    const buf = Buffer.allocUnsafe(4096);
    let end = pos;
    while (end > 0) {
      const len = Math.min(buf.length, end);
      const from = end - len;
      const n = fs.readSync(this.#fd, buf, 0, len, from);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).lastIndexOf(0x0a);
      if (nl !== -1) return from + nl + 1;
      end = from;
    }
    return 0;
  }

  #readLine(start) {
    const buf = Buffer.allocUnsafe(512);
    let out = '';
    let pos = start;
    while (pos < this.#size) {
      const n = fs.readSync(this.#fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) return out + slice.subarray(0, nl).toString('utf8');
      out += slice.toString('utf8');
      pos += n;
    }
    return out;
  }

  /**
   * Binary search the sorted file for one hex. Returns the raw line or null.
   * `lo` is always held at a line start, and the search window [lo, hi)
   * always contains the target line's start byte.
   */
  #find(key) {
    let lo = 0;
    let hi = this.#size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const start = Math.max(lo, this.#lineStart(mid));
      const line = this.#readLine(start);
      const sep = line.indexOf(';');
      const hex = sep === -1 ? line : line.slice(0, sep);
      if (hex === key) return line;
      if (hex < key) {
        lo = start + Buffer.byteLength(line) + 1;
      } else {
        if (start <= lo) break; // window exhausted; key is not present
        hi = start;
      }
    }
    return null;
  }

  /**
   * Look up an ICAO hex. Returns null when the database has no row for it,
   * or when the row carries no type and no registration (present but empty,
   * which is no more useful than absent).
   */
  lookup(hex) {
    if (!hex || !this.open()) return null;
    const key = hex.toUpperCase();
    if (this.#cache.has(key)) return this.#cache.get(key);

    let result = null;
    try {
      const line = this.#find(key);
      if (line) {
        const f = line.split(';');
        const typeCode = (f[2] ?? '').trim();
        const registration = (f[1] ?? '').trim();
        if (typeCode || registration) {
          result = {
            registration,
            typeCode,
            typeName: (f[4] ?? '').trim() || this.#typeName(typeCode),
            year: (f[5] ?? '').trim(),
            operator: (f[6] ?? '').trim(),
            dbFlags: parseFlags(f[3]),
          };
        }
      }
    } catch {
      result = null;
    }

    this.#cache.set(key, result);
    return result;
  }
}

/**
 * The flags column is a binary string written least-significant bit first,
 * so "10" is bit 0 (military) and "0001" is bit 3 (LADD).
 */
function parseFlags(field) {
  let flags = 0;
  const s = (field ?? '').trim();
  for (let i = 0; i < s.length; i++) if (s[i] === '1') flags |= 1 << i;
  return flags;
}
