'use strict';

/**
 * Builds the macOS app bundle, on Windows or anywhere else with Node.
 *
 * A .app is just a folder with a known shape, so it can be assembled here and
 * zipped without a Mac in the loop. What a Mac is still needed for is the DMG
 * (see make-dmg.command): that is Apple's own disk-image format and only
 * hdiutil writes it.
 *
 *   packaging/mac/AirChat-launcher.sh   -> Contents/MacOS/AirChat   (0755)
 *   server/, ui/, tools/                -> Contents/Resources/app/
 *   server/icons.js                     -> Contents/Resources/AppIcon.icns
 *
 * The icon is rendered by the same code that serves /icon-512.png, so the app in
 * the Dock cannot drift from the icon on a phone's home screen.
 *
 * Usage:  node packaging/mac/build-mac.js
 *         node packaging/mac/build-mac.js --no-zip
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const zip = require('../../tools/zip');
const icons = require('../../server/icons');

const ROOT = path.join(__dirname, '..', '..');
const BUILD = path.join(ROOT, '.build', 'mac');
const APP = path.join(BUILD, 'AirChat.app');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version || '0.0.0';

const APP_NAME = 'AirChat';
const BUNDLE_ID = 'com.bob1234afk.airchat';

/* ------------------------------------------------------------------ *
 * The icon
 * ------------------------------------------------------------------ */

/**
 * ICNS is the container macOS reads for an app icon: a header, then chunks.
 * Modern macOS accepts PNG data inside a chunk, which is exactly what
 * server/icons.js already produces, so the icon needs no converter.
 *
 * Sizes below map to the chunk types Apple documents for PNG payloads.
 */
const ICNS_CHUNKS = [
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
];

function icns() {
  const chunks = ICNS_CHUNKS.map(({ type, size }) => {
    const png = icons.renderIcon(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + body.length, 4);

  return Buffer.concat([header, body]);
}

/* ------------------------------------------------------------------ *
 * Info.plist
 * ------------------------------------------------------------------ */

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function infoPlist() {
  const entries = {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: APP_NAME,
    CFBundleIconFile: 'AppIcon',
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: APP_NAME,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: VERSION,
    LSApplicationCategoryType: 'public.app-category.social-networking',
    LSMinimumSystemVersion: '11.0',
    NSHighResolutionCapable: 'true',
    NSHumanReadableCopyright: 'AirChat runs on your own computer. Your messages stay there.',
  };

  const body = Object.entries(entries)
    .map(([key, value]) => `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

const APPSOURCES = ['server', 'ui', 'tools', 'package.json', 'config.example.json', 'README.md'];

function copyInto(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function assemble() {
  fs.rmSync(BUILD, { recursive: true, force: true });

  const macos = path.join(APP, 'Contents', 'MacOS');
  const resources = path.join(APP, 'Contents', 'Resources');
  const appSource = path.join(resources, 'app');

  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(appSource, { recursive: true });

  // The executable. Mode is set here as well as in the zip, so a local copy is
  // runnable too; on Windows this is a no-op, which is why the zip matters.
  const launcher = fs.readFileSync(path.join(__dirname, 'AirChat-launcher.sh'));
  fs.writeFileSync(path.join(macos, APP_NAME), launcher);
  fs.chmodSync(path.join(macos, APP_NAME), 0o755);

  fs.writeFileSync(path.join(APP, 'Contents', 'Info.plist'), infoPlist());
  fs.writeFileSync(path.join(APP, 'Contents', 'PkgInfo'), 'APPL????');
  fs.writeFileSync(path.join(resources, 'AppIcon.icns'), icns());

  for (const item of APPSOURCES) {
    const source = path.join(ROOT, item);
    if (fs.existsSync(source)) copyInto(source, path.join(appSource, item));
  }

  // A user opening the zip should be able to read what they have, without
  // launching it to find out.
  fs.writeFileSync(
    path.join(BUILD, 'READ-ME-FIRST.txt'),
    [
      'AirChat for macOS',
      '',
      `Version ${VERSION}`,
      '',
      'This app needs Node.js 18 or newer:  https://nodejs.org',
      '',
      'It is not signed with an Apple Developer certificate, so the first time',
      'you open it macOS will refuse. To allow it once:',
      '',
      '  1. Drag AirChat.app into Applications (or anywhere you like).',
      '  2. Right-click it and choose Open, then Open again in the dialog.',
      '     (A double-click after that works normally.)',
      '',
      'If macOS says the app is damaged, it is the download quarantine:',
      '  xattr -dr com.apple.quarantine /Applications/AirChat.app',
      '',
      'Your messages and settings live in:',
      '  ~/Library/Application Support/AirChat',
      '',
      'A real .dmg can be built on any Mac from this folder with:',
      '  ./make-dmg.command',
      '',
      'The free public link needs cloudflared:  brew install cloudflared',
      'Without it AirChat still runs, on your Wi-Fi only.',
      '',
    ].join('\n')
  );
}

function pack() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const target = path.join(ARTIFACTS, `${APP_NAME}-${VERSION}-mac.zip`);

  // Both the app and the read-me, so the zip is self-explanatory before the
  // .app is opened. Only the launcher is executable.
  const entries = zip.tree(BUILD, {
    executables: [`${APP_NAME}.app/Contents/MacOS/${APP_NAME}`],
  });

  const result = zip.write(target, entries);

  // Prove the archive is what it claims: the launcher kept 0755, and the icon
  // and plist are there at all.
  const listing = zip.list(target);
  const launcherEntry = listing.find((entry) => entry.name.endsWith(`Contents/MacOS/${APP_NAME}`));

  if (!launcherEntry) throw new Error('the packaged bundle has no launcher');
  if (launcherEntry.mode !== 0o755) {
    throw new Error(`the launcher was packed ${launcherEntry.mode.toString(8)}, expected 755`);
  }
  if (!listing.some((entry) => entry.name.endsWith('Info.plist'))) {
    throw new Error('the packaged bundle has no Info.plist');
  }
  if (!listing.some((entry) => entry.name.endsWith('AppIcon.icns'))) {
    throw new Error('the packaged bundle has no icon');
  }

  return { ...result, target, listing, launcherMode: launcherEntry.mode };
}

function main() {
  assemble();

  const noZip = process.argv.includes('--no-zip');

  if (noZip) {
    console.log(`Built ${path.relative(ROOT, APP)} (unzipped)`);
    return;
  }

  const result = pack();
  const kb = Math.round(result.bytes / 1024);

  console.log(`Built ${path.relative(ROOT, result.target)}`);
  console.log(`  ${result.entries} files, ${kb} KB`);
  console.log(`  launcher mode ${result.launcherMode.toString(8)}, icon + plist present`);

  if (process.platform === 'darwin') {
    // Only possible on a Mac, and only worth doing there.
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'ignore' });
      console.log('  ad-hoc signed with codesign (enough for local use, not for distribution)');
    } catch (err) {
      console.log('  could not ad-hoc sign: ' + err.message);
    }
  }
}

main();
