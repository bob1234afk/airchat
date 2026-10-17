'use strict';

/**
 * Turns AirChat's drawn icon into the file formats the installers need.
 *
 * The app already renders its own PNGs (see server/icons.js) rather than
 * committing binaries, so the Windows icon is generated the same way and cannot
 * drift from the one on a phone's home screen. Two formats come out of here:
 *
 *   .ico  a directory of images; Windows has accepted PNG data inside one since
 *         Vista, and it wants 16/32/48 for the small places plus 256 for the
 *         large ones. The installer's shortcut and the Electron window both use it.
 *   .png  what electron-builder wants as its source image; it derives the rest.
 *
 * Usage:  node tools/make-icon.js [output-directory]     (default: build/)
 */

const fs = require('fs');
const path = require('path');

const icons = require('../server/icons');

const ROOT = path.join(__dirname, '..');

/**
 * ICO container: a 6-byte header, one 16-byte directory entry per image, then
 * the image data. Width and height are one byte each, so 256 is written as 0.
 */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, png: icons.renderIcon(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;

  const directory = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette size
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...images.map((image) => image.png)]);
}

/** Read a .ico back and report what it actually holds. */
function inspectIco(buffer) {
  const count = buffer.readUInt16LE(4);
  const images = [];

  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const width = buffer[at] === 0 ? 256 : buffer[at];
    const height = buffer[at + 1] === 0 ? 256 : buffer[at + 1];
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);

    images.push({
      width,
      height,
      length,
      png: buffer.subarray(offset, offset + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      insideFile: offset + length <= buffer.length,
    });
  }

  return images;
}

function main() {
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'build'));
  fs.mkdirSync(out, { recursive: true });

  const icoFile = path.join(out, 'icon.ico');
  const icoBuffer = ico([16, 32, 48, 256]);
  fs.writeFileSync(icoFile, icoBuffer);

  const pngFile = path.join(out, 'icon.png');
  fs.writeFileSync(pngFile, icons.renderIcon(512));

  const images = inspectIco(icoBuffer);
  const broken = images.filter((image) => !image.png || !image.insideFile);
  if (broken.length) throw new Error(`the ico is malformed: ${JSON.stringify(broken)}`);

  console.log(`Wrote ${path.relative(ROOT, icoFile)} (${images.map((i) => `${i.width}x${i.height}`).join(', ')})`);
  console.log(`Wrote ${path.relative(ROOT, pngFile)} (512x512)`);
}

module.exports = { ico, inspectIco };

if (require.main === module) main();
