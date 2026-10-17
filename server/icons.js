'use strict';

/**
 * AirChat draws its own app icon, at runtime, with nothing but Node's zlib.
 *
 * A phone home-screen icon has to be a PNG. Rather than committing binary files
 * that cannot be reviewed or resized, the server renders them on demand - so the
 * icon is source code, and `/icon-512.png` always matches the brand colours in
 * the stylesheet.
 *
 * The encoder is deliberately minimal: 8-bit RGBA, filter type 0 on every
 * scanline, one IDAT chunk. That is the simplest valid PNG that every browser
 * and iOS accepts.
 */

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Largest icon we will ever render, to keep a bad request cheap. */
const MAX_SIZE = 1024;

/* ------------------------------------------------------------------ *
 * CRC32 (required by the PNG format)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([length, body, crc]);
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/** Brand gradient, left to right: the same violet-to-blue as the interface. */
const GRADIENT_FROM = { r: 139, g: 92, b: 255 };
const GRADIENT_TO = { r: 47, g: 139, b: 255 };

/**
 * The mark: two rounded bars, echoing the speech-bubble lines in the wordmark.
 * All coordinates are 0..1 so the same shapes work at every size, and they sit
 * well inside the centre of the canvas so the icon survives being cropped into a
 * circle by Android's maskable icons.
 */
const BARS = [
  { x: 0.26, y: 0.375, width: 0.48, height: 0.075 },
  { x: 0.26, y: 0.545, width: 0.32, height: 0.075 },
];

/** Is this point inside a pill-shaped bar? */
function insideBar(px, py, bar) {
  const radius = bar.height / 2;

  if (px < bar.x || px > bar.x + bar.width) return false;
  if (py < bar.y || py > bar.y + bar.height) return false;

  // Clamp to the inner rectangle, then test against the end capsule.
  const cx = Math.min(Math.max(px, bar.x + radius), bar.x + bar.width - radius);
  const cy = Math.min(Math.max(py, bar.y + radius), bar.y + bar.height - radius);

  const dx = px - cx;
  const dy = py - cy;

  return dx * dx + dy * dy <= radius * radius;
}

function gradientAt(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    r: GRADIENT_FROM.r + (GRADIENT_TO.r - GRADIENT_FROM.r) * clamped,
    g: GRADIENT_FROM.g + (GRADIENT_TO.g - GRADIENT_FROM.g) * clamped,
    b: GRADIENT_FROM.b + (GRADIENT_TO.b - GRADIENT_FROM.b) * clamped,
  };
}

/**
 * Render the icon.
 *
 * Edges are antialiased by supersampling: every pixel is sampled on a 3x3 grid
 * and averaged, which is cheap enough to do on demand and avoids hand-rolling
 * coverage maths.
 */
function renderIcon(size) {
  const dimension = Math.round(size);
  if (!Number.isFinite(dimension) || dimension < 8 || dimension > MAX_SIZE) {
    throw new Error(`Icon size must be between 8 and ${MAX_SIZE} pixels.`);
  }

  const samples = 3;
  const stride = dimension * 4 + 1;
  const raw = Buffer.alloc(dimension * stride);

  for (let y = 0; y < dimension; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // PNG filter type: None

    for (let x = 0; x < dimension; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / dimension;
          const py = (y + (sy + 0.5) / samples) / dimension;

          let onBar = false;
          for (const bar of BARS) {
            if (insideBar(px, py, bar)) {
              onBar = true;
              break;
            }
          }

          if (onBar) {
            r += 255;
            g += 255;
            b += 255;
          } else {
            // Diagonal gradient, so it reads as light coming from the top left.
            const shade = gradientAt((px + py) / 2);
            r += shade.r;
            g += shade.g;
            b += shade.b;
          }
        }
      }

      const total = samples * samples;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = Math.round(r / total);
      raw[offset + 1] = Math.round(g / total);
      raw[offset + 2] = Math.round(b / total);
      raw[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(dimension, 0); // width
  header.writeUInt32BE(dimension, 4); // height
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache = new Map();

/** Render once, then reuse - the same handful of sizes are asked for repeatedly. */
function icon(size) {
  const key = Math.round(Number(size));
  if (!cache.has(key)) cache.set(key, renderIcon(key));
  return cache.get(key);
}

module.exports = { renderIcon, icon, crc32, MAX_SIZE, PNG_SIGNATURE };
