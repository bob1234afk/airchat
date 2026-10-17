'use strict';

/**
 * A tiny ZIP writer, with no dependencies.
 *
 * AirChat already draws its own PNGs rather than committing binaries, and this
 * is the same idea for packaging: the macOS app bundle and the iOS payload have
 * to arrive as zips, but the tools that make zips on Windows
 * (Compress-Archive, Explorer's "Send to > Compressed folder") throw away Unix
 * file modes. An executable that arrives as 0644 is an app that will not launch,
 * so the packing is done here, where the mode is written into the archive.
 *
 * What it supports is exactly what the packaging needs:
 *   - stored or deflated entries, chosen per entry by whichever is smaller
 *   - UTF-8 names (the general-purpose bit 11 is set)
 *   - Unix modes in the "version made by" field, so unzip/Archive Utility
 *     restore 0755 on an executable
 *   - mtimes, so a rebuild is not a different file every time
 *
 * It does not do Zip64, encryption, or comments. The largest thing it packs is a
 * few megabytes, so none of those matter.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Reuse the CRC32 the PNG encoder already has, rather than writing a third one.
const { crc32 } = require('../server/icons');

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0: deflate
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED; // 3 = Unix, so modes survive
const FLAG_UTF8 = 0x0800;

const DEFAULTS = {
  file: 0o644,
  executable: 0o755,
};

/** Date -> the packed MS-DOS time/date pair ZIP has used since 1989. */
function dosStamp(date) {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  // ZIP cannot represent anything before 1980, and clamps to that year.
  const year = Math.max(1980, when.getFullYear());

  return {
    time:
      ((when.getHours() & 0x1f) << 11) |
      ((when.getMinutes() & 0x3f) << 5) |
      ((Math.floor(when.getSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((when.getMonth() + 1) & 0x0f) << 5) | (when.getDate() & 0x1f),
  };
}

function deflate(data) {
  const packed = zlib.deflateRawSync(data, { level: 9 });
  // Storing is smaller for things that are already compressed, and a store is
  // also what makes the archive readable if anything ever goes wrong with zlib.
  return packed.length < data.length ? packed : null;
}

/**
 * Build the archive in memory.
 *
 * @param {{name: string, data: Buffer|string, mode?: number, mtime?: Date}[]} entries
 * @returns {Buffer}
 */
function build(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('A zip needs at least one entry.');
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`Refusing to pack an unsafe path: ${name}`);
    }

    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const mode = entry.mode === undefined ? DEFAULTS.file : entry.mode;
    const stamp = dosStamp(entry.mtime);

    const packed = deflate(data);
    const body = packed || data;
    const method = packed ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(Buffer.byteLength(name), 26);
    local.writeUInt16LE(0, 28); // no extra field

    locals.push(local, Buffer.from(name, 'utf8'), body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(Buffer.byteLength(name), 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // Unix mode in the high half: this is what unzip restores as permissions.
    central.writeUInt32LE((mode & 0xffff) << 16, 38);
    central.writeUInt32LE(offset, 42);

    centrals.push(central, Buffer.from(name, 'utf8'));
    offset += local.length + body.length + Buffer.byteLength(name);
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/** Write `entries` to a .zip / .ipa / .app archive on disk. */
function write(file, entries) {
  const archive = build(entries);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, archive);
  return { file, bytes: archive.length, entries: entries.length };
}

/**
 * Walk a directory and return entries ready for build().
 *
 * `executables` is a list of paths (relative to `root`, forward slashes) that
 * must keep their 0755 bit. On Windows every file looks non-executable to
 * fs.stat, so the caller states the intent instead of the filesystem.
 */
function tree(root, options) {
  const opts = options || {};
  const prefix = String(opts.prefix || '').replace(/\/+$/, '');
  const executables = new Set((opts.executables || []).map((value) => value.replace(/\\/g, '/')));
  const skip = opts.skip || (() => false);
  const entries = [];

  function walk(dir, relative) {
    const listing = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

    for (const item of listing) {
      const full = path.join(dir, item.name);
      const inside = relative ? `${relative}/${item.name}` : item.name;
      if (skip(inside, item)) continue;

      if (item.isDirectory()) {
        walk(full, inside);
        continue;
      }

      if (!item.isFile()) continue; // symlinks are not part of any artifact here

      const stat = fs.statSync(full);
      entries.push({
        name: prefix ? `${prefix}/${inside}` : inside,
        data: fs.readFileSync(full),
        mode: executables.has(inside) ? DEFAULTS.executable : DEFAULTS.file,
        mtime: stat.mtime,
      });
    }
  }

  walk(root, '');
  return entries;
}

/**
 * Read an archive's central directory back.
 *
 * Packaging is the one place where a silent mistake means "the download does
 * not open", so every artifact is inspected after it is written rather than
 * trusted because the writer returned without throwing.
 */
function list(file) {
  const buffer = fs.readFileSync(file);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error(`${path.basename(file)} is not a zip: no end-of-central-directory record`);

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_HEADER) {
      throw new Error(`${path.basename(file)} has a corrupt central directory at entry ${i}`);
    }

    const madeBy = buffer.readUInt16LE(offset + 4);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      name,
      method,
      crc,
      compressed,
      size,
      mode: (external >>> 16) & 0xffff,
      unix: madeBy >>> 8 === 3,
      offset: localOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Read one entry's bytes back out, verifying its CRC. */
function read(file, name) {
  const buffer = fs.readFileSync(file);
  const entry = list(file).find((item) => item.name === name);
  if (!entry) throw new Error(`${name} is not in ${path.basename(file)}`);

  const local = entry.offset;
  if (buffer.readUInt32LE(local) !== LOCAL_HEADER) throw new Error('bad local header');
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const body = buffer.subarray(start, start + entry.compressed);
  const data = entry.method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);

  if (crc32(data) !== entry.crc) throw new Error(`${name} does not match its CRC`);
  return data;
}

module.exports = { build, write, tree, list, read, DEFAULTS };
