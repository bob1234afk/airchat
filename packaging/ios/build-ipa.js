'use strict';

/**
 * Builds an unsigned iOS payload, shaped like an .ipa.
 *
 * Read this before wondering why it will not install.
 *
 * An .ipa is a zip whose root is a Payload/ folder containing an .app bundle.
 * What makes that bundle *installable* is two things this machine cannot
 * produce:
 *
 *   1. a Mach-O executable, which needs Apple's compiler (Xcode, macOS only)
 *   2. a code signature, which needs an Apple signing identity
 *
 * So the file this script writes is a real zip, with the real Info.plist, real
 * icons and the real web interface inside - and a placeholder where the compiled
 * binary goes. It is a packaging skeleton to sign, not something to send to a
 * phone. `SIGNING.md`, written next to it, is the short path to a working build.
 *
 * Usage:  node packaging/ios/build-ipa.js
 */

const fs = require('fs');
const path = require('path');

const zip = require('../../tools/zip');
const icons = require('../../server/icons');

const ROOT = path.join(__dirname, '..', '..');
const BUILD = path.join(ROOT, '.build', 'ios');
const PAYLOAD = path.join(BUILD, 'Payload');
const APP = path.join(PAYLOAD, 'AirChat.app');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version || '0.0.0';

const APP_NAME = 'AirChat';
const BUNDLE_ID = 'com.bob1234afk.airchat';

/**
 * The icon files iOS reads from Info.plist's CFBundleIconFiles.
 * Names are the long-standing convention; sizes go in the filename.
 */
const IOS_ICONS = [
  { file: 'AppIcon60x60@2x.png', size: 120 },
  { file: 'AppIcon60x60@3x.png', size: 180 },
  { file: 'AppIcon76x76@2x~ipad.png', size: 152 },
  { file: 'AppIcon1024x1024.png', size: 1024 },
];

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plist(entries) {
  function render(value, depth) {
    const pad = '\t'.repeat(depth);

    if (typeof value === 'string') return `${pad}<string>${escapeXml(value)}</string>`;
    if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
    if (typeof value === 'boolean') return `${pad}<${value ? 'true' : 'false'}/>`;

    if (Array.isArray(value)) {
      const items = value.map((item) => render(item, depth + 1)).join('\n');
      return `${pad}<array>\n${items}\n${pad}</array>`;
    }

    const pairs = Object.entries(value)
      .map(([key, item]) => `${pad}\t<key>${escapeXml(key)}</key>\n${render(item, depth + 1)}`)
      .join('\n');
    return `${pad}<dict>\n${pairs}\n${pad}</dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${render(entries, 0)}
</plist>
`;
}

function infoPlist() {
  return plist({
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: APP_NAME,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: APP_NAME,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: VERSION,
    CFBundleIconFiles: IOS_ICONS.map((icon) => icon.file.replace(/\.png$/, '')),
    LSRequiresIPhoneOS: true,
    MinimumOSVersion: '15.0',
    UIApplicationSupportsIndirectInputEvents: true,
    UIDeviceFamily: [1, 2],
    UILaunchStoryboardName: 'LaunchScreen',
    UISupportedInterfaceOrientations: [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ],
    // AirChat is served from a laptop on the user's own network, often over
    // plain http:// on the LAN, so a wrapper has to be allowed to reach it.
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: true,
      NSAllowsLocalNetworking: true,
    },
  });
}

function entitlements() {
  return plist({
    'com.apple.security.get-task-allow': true,
    'com.apple.developer.team-identifier': 'REPLACE_WITH_YOUR_TEAM_ID',
  });
}

function startHere() {
  return `AirChat for iPhone and iPad - unsigned scaffold
================================================

This .ipa is the packaging shape, not a finished app.

It contains the real Info.plist, the real icons, the real web interface, and a
placeholder where the compiled program belongs. Nothing here is signed, and
there is no Apple compiler on the machine that produced it (Apple's toolchain
runs only on macOS), so iOS will refuse to install this file as it stands.

What is missing, and where to get it
------------------------------------

1. The app binary.  Xcode, on a Mac. Two routes:

   Easiest - wrap it with Capacitor:

     npm install --save @capacitor/core @capacitor/cli @capacitor/ios
     npx cap init AirChat ${BUNDLE_ID} --web-dir=ui
     npx cap add ios
     npx cap open ios          # opens Xcode

   In Xcode, point the WebView at your AirChat address (the app already is a
   web app, so most of the work is done). Then:

     Product -> Archive -> Distribute App -> Development/Ad Hoc -> Export

   That produces a signed, installable .ipa.

2. The signature.  iOS runs nothing unsigned. Signing needs an Apple ID:
   a free one gets 7-day development installs; the $99/year program gets
   TestFlight and a year-long install. Both are done from Xcode:

     Signing & Capabilities -> Team -> your Apple ID

Signing this scaffold by hand, if you already have a certificate
---------------------------------------------------------------

On a Mac, with a signing identity in your keychain:

  unzip AirChat-${VERSION}-unsigned.ipa
  codesign --force --sign "Apple Development: you@example.com" \\
           --entitlements Payload/AirChat.app/entitlements.plist \\
           --timestamp=none Payload/AirChat.app
  zip -qry AirChat-signed.ipa Payload

The executable inside has to be a real Mach-O before any of that can work -
codesign will say so plainly.

Installing what you build
-------------------------

  * Xcode: Window -> Devices and Simulators -> drag the .ipa onto the phone
  * or:    xcrun devicectl device install app --device <id> AirChat.ipa
  * or:    a sideloading tool such as AltStore or Sideloadly (free Apple ID is
           enough; the install expires after 7 days)

What is inside this file
------------------------

  Payload/AirChat.app/Info.plist          bundle identity, icon names, ATS rules
  Payload/AirChat.app/AppIcon*.png        rendered from server/icons.js
  Payload/AirChat.app/AirChat             placeholder for the compiled program
  Payload/AirChat.app/www/                the interface, for a wrapper to serve
  Payload/AirChat.app/entitlements.plist  a starting point for signing
  Payload/AirChat.app/START-HERE.md       this file

The www/ copy is the browser interface as-is. It talks to an AirChat server for
messages, so a wrapper has to be pointed at one - opening www/index.html on its
own will show the interface with nothing behind it.
`;
}

function placeholderBinary() {
  return `This file is where AirChat's compiled iOS program belongs.

It is a placeholder: an .ipa needs an executable at this path, and building one
needs Apple's compiler, which only runs on macOS. See START-HERE.md for the two
ways to produce the real thing (Xcode directly, or Capacitor then Xcode).

Until then this bundle cannot be signed and iOS will not install it.
`;
}

function assemble() {
  fs.rmSync(BUILD, { recursive: true, force: true });

  fs.mkdirSync(APP, { recursive: true });

  fs.writeFileSync(path.join(APP, 'Info.plist'), infoPlist());
  fs.writeFileSync(path.join(APP, 'entitlements.plist'), entitlements());
  fs.writeFileSync(path.join(APP, 'START-HERE.md'), startHere());
  fs.writeFileSync(path.join(APP, APP_NAME), placeholderBinary());

  for (const icon of IOS_ICONS) {
    fs.writeFileSync(path.join(APP, icon.file), icons.renderIcon(icon.size));
  }

  // The interface itself, so the wraps-with-Capacitor route has the real UI to
  // serve rather than a rebuild of it.
  fs.cpSync(path.join(ROOT, 'ui'), path.join(APP, 'www'), { recursive: true });

  fs.writeFileSync(
    path.join(BUILD, 'README.txt'),
    'This folder is the flutter-free, toolchain-free half of an .ipa.\n' +
      'Payload/ zips into the .ipa; see Payload/AirChat.app/START-HERE.md.\n'
  );
}

function pack() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const target = path.join(ARTIFACTS, `${APP_NAME}-${VERSION}-unsigned.ipa`);

  const entries = zip.tree(BUILD, {
    executables: [`Payload/${APP_NAME}.app/${APP_NAME}`],
    skip: (name) => name === 'README.txt',
  });

  const result = zip.write(target, entries);
  const listing = zip.list(target);

  // An .ipa is only an .ipa if Payload/ is at the root, so check rather than
  // assume - this is the mistake that produces a file no tool will accept.
  const required = [
    `Payload/${APP_NAME}.app/Info.plist`,
    `Payload/${APP_NAME}.app/${APP_NAME}`,
    `Payload/${APP_NAME}.app/START-HERE.md`,
    `Payload/${APP_NAME}.app/entitlements.plist`,
    `Payload/${APP_NAME}.app/www/index.html`,
  ];

  for (const name of required) {
    if (!listing.some((entry) => entry.name === name)) {
      throw new Error(`the ipa is missing ${name}`);
    }
  }

  for (const icon of IOS_ICONS) {
    if (!listing.some((entry) => entry.name.endsWith(icon.file))) {
      throw new Error(`the ipa is missing ${icon.file}`);
    }
  }

  return { ...result, target, listing };
}

function main() {
  assemble();
  const result = pack();

  console.log(`Built ${path.relative(ROOT, result.target)}`);
  console.log(`  ${result.entries} files, ${Math.round(result.bytes / 1024)} KB`);
  console.log('  Payload/AirChat.app present with Info.plist, icons, entitlements and www/');
  console.log('  UNSIGNED and without a compiled binary: it will not install until signed.');
}

main();
