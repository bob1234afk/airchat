'use strict';

/**
 * Builds the Windows installer, on Windows, with nothing installed.
 *
 * The .exe is made by IExpress, which ships with every copy of Windows - so
 * "download AirChat" does not first require downloading a build system. It packs
 * two files:
 *
 *   app.zip     the whole program (a zip, so IExpress never has to understand
 *               subfolders, and so one writer makes every archive in the repo)
 *   install.cmd what runs afterwards: unpack into %LOCALAPPDATA%\AirChat, check
 *               for Node, drop a shortcut on the Desktop, start it
 *
 * Also written, and used as the shortcut's icon: airchat.ico, from
 * tools/make-icon.js, which turns the app's own PNG renderer into a real ICO so
 * the shortcut cannot show a different icon from the app.
 *
 * Usage:  node packaging/windows/build-sfx.js
 *         node packaging/windows/build-sfx.js --keep   (leave .build/sfx in place)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const zip = require('../../tools/zip');
const { ico } = require('../../tools/make-icon');

const ROOT = path.join(__dirname, '..', '..');
const BUILD = path.join(ROOT, '.build', 'sfx');
const STAGE = path.join(BUILD, 'stage');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version || '0.0.0';
const SETUP_NAME = `AirChat-Setup-${VERSION}.exe`;

const IEXPRESS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'iexpress.exe');

/**
 * Everything the app needs to run, and nothing that is only about this checkout.
 *
 * Getting this list wrong is not a cosmetic bug: leaving out `dist/` once meant
 * the installer tried to pack 273 MB of already-packaged Electron output, which
 * took so long it looked like the build tool had hung. The size check in main()
 * exists so that mistake reports itself in one line instead.
 */
const EXCLUDED = new Set([
  '.git',
  '.gitattributes',
  '.freebuff',
  '.build',
  'artifacts',
  'build',
  'data',
  'dist',
  'dist-site',
  'node_modules',
  'packaging',
  'site',
]);

/** A payload larger than this means something is being packed that should not be. */
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

function include(relative) {
  const top = relative.split('/')[0];
  if (EXCLUDED.has(top)) return false;
  if (relative === 'config.json') return false; // may hold Twilio/BlueBubbles secrets
  if (relative.startsWith('airchat-tray') && relative.endsWith('.log')) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * The payload
 * ------------------------------------------------------------------ */

function appsZip(target) {
  const entries = zip.tree(ROOT, {
    skip: (relative) => !include(relative),
  });

  // The shortcut points at airchat.ico in the install folder.
  entries.push({
    name: 'airchat.ico',
    data: ico([16, 32, 48, 256]),
    mtime: new Date(),
  });

  entries.push({
    name: 'READ-ME-FIRST.txt',
    data: [
      `AirChat ${VERSION}`,
      '',
      'Installed by the AirChat setup program into:',
      '  %LOCALAPPDATA%\\AirChat',
      '',
      'To start it:',
      '  Start AirChat in Tray.bat        running quietly by the clock, with a public link',
      '  Start AirChat + Public Link.bat  the same, but in a window you can watch',
      '  Start AirChat.bat                no public link, this PC and your Wi-Fi only',
      '',
      'To check everything is in place:',
      '  Check AirChat.bat',
      '',
      'Your messages and settings live in this folder too (data\\airchat.json and',
      'config.json). Copying the folder is a complete backup. config.json holds any',
      'Twilio or BlueBubbles passwords you add, so keep it to yourself.',
      '',
      'AirChat needs Node.js 18 or newer:  https://nodejs.org',
      '',
    ].join('\r\n'),
    mtime: new Date(),
  });

  return zip.write(target, entries);
}

/* ------------------------------------------------------------------ *
 * The IExpress package
 * ------------------------------------------------------------------ */

/**
 * IExpress is driven by a "self extraction directive" - an INI file describing
 * what to pack and what to run. It wants CRLF line endings.
 */
function directive(targetExe) {
  const lines = [
    '[Version]',
    'Class=IEXPRESS',
    'SEDVersion=3',
    '[Options]',
    'PackagePurpose=InstallApp',
    'ShowInstallProgramWindow=1',
    'HideExtractAnimation=1',
    'UseLongFileName=1',
    'InsideCompressed=0',
    'CAB_FixedSize=0',
    'CAB_ResvCodeSigning=0',
    'RebootMode=N',
    'InstallPrompt=',
    'DisplayLicense=',
    'FinishMessage=',
    `TargetName=${targetExe}`,
    `FriendlyName=AirChat ${VERSION} setup`,
    'AppLaunched=install.cmd',
    'PostInstallCmd=<None>',
    'AdminQuietInstCmd=',
    'UserQuietInstCmd=',
    'SourceFiles=SourceFiles',
    '[Strings]',
    'FILE0="install.cmd"',
    'FILE1="app.zip"',
    '[SourceFiles]',
    `SourceFiles0=${STAGE}\\`,
    '[SourceFiles0]',
    '%FILE0%=',
    '%FILE1%=',
    '',
  ];

  return lines.join('\r\n');
}

function describe(file) {
  const stat = fs.statSync(file);
  return `${Math.round(stat.size / 1024)} KB`;
}

function main() {
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  /* 1. the payload */
  const zipResult = appsZip(path.join(STAGE, 'app.zip'));

  // cmd.exe wants CRLF. A checkout on a Mac or Linux would hand this file LF
  // line endings (see .gitattributes), and the batch parser is old enough to
  // care, so the step is stamped in here rather than left to chance.
  const installerScript = fs
    .readFileSync(path.join(__dirname, 'install.cmd'), 'utf8')
    .replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(STAGE, 'install.cmd'), installerScript, 'utf8');

  const payloadSize = fs.statSync(path.join(STAGE, 'app.zip')).size;
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `the payload is ${Math.round(payloadSize / 1048576)} MB, which is far more than the app itself ` +
        '- something like dist/ or node_modules/ is being packed by mistake'
    );
  }

  console.log(`Packed the app: ${zipResult.entries} files, ${describe(path.join(STAGE, 'app.zip'))}`);

  /* 2. the installer */
  if (!fs.existsSync(IEXPRESS)) {
    throw new Error(`IExpress is missing from this Windows install (${IEXPRESS})`);
  }

  const target = path.join(ARTIFACTS, SETUP_NAME);
  fs.rmSync(target, { force: true });

  const sed = path.join(BUILD, 'airchat.sed');
  fs.writeFileSync(sed, directive(target), 'latin1');

  const built = spawnSync(IEXPRESS, ['/N', '/Q', sed], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${built.stdout || ''}${built.stderr || ''}`.trim();
  if (output) console.log(output);

  if (!fs.existsSync(target)) {
    throw new Error(`IExpress exited ${built.status} without producing ${SETUP_NAME}`);
  }

  /* 3. prove it: extract the installer without running it */
  const probe = path.join(BUILD, 'extracted');
  fs.rmSync(probe, { recursive: true, force: true });

  // /Q quiet, /T:<dir> extract here, /C extract only (never run install.cmd).
  const extract = spawnSync(target, ['/Q', `/T:${probe}`, '/C'], { stdio: ['ignore', 'pipe', 'pipe'] });

  if (!fs.existsSync(path.join(probe, 'install.cmd'))) {
    throw new Error(`the installer could not be extracted (exit ${extract.status}) - it would not install`);
  }

  const listing = zip.list(path.join(probe, 'app.zip'));
  const needed = ['server/index.js', 'ui/app.js', 'ui/index.html', 'tools/tunnel.js', 'airchat.ico', 'Start AirChat in Tray.bat'];
  const missing = needed.filter((name) => !listing.some((entry) => entry.name === name));
  if (missing.length) throw new Error(`the payload is missing: ${missing.join(', ')}`);

  const leaked = listing.filter((entry) =>
    /(^|\/)(config\.json|data\/|\.git\/|dist\/|node_modules\/|packaging\/)/.test(entry.name)
  );
  if (leaked.length) throw new Error(`the payload would ship private files: ${leaked.map((e) => e.name).join(', ')}`);

  console.log(`Built ${path.relative(ROOT, target)}`);
  console.log(`  ${describe(target)}, self-extracting, no admin rights needed`);
  console.log(`  payload verified by extracting it: ${listing.length} files, no config.json or data/ inside`);

  if (!process.argv.includes('--keep')) fs.rmSync(BUILD, { recursive: true, force: true });
}

main();
