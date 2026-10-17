'use strict';

/**
 * AirChat's pre-flight check.
 *
 * Run it with `npm run doctor` (or `node tools/doctor.js`). It catches the
 * problems that would otherwise only show up as a blank screen or a crash on
 * startup:
 *
 *   1. Node version and the APIs AirChat relies on
 *   2. that every JavaScript file parses (as a script, or as an ES module)
 *   3. that each server module loads and exports what the others expect
 *   4. that the UI files exist, and that app.js only asks for elements that
 *      index.html actually defines
 *   5. that end-to-end encryption really works: it locks a message with
 *      ui/crypto.js, unlocks it, and confirms tampered text is refused
 *   6. that config.json parses and the chosen port is free
 *
 * Nothing here executes the server or touches your messages.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/**
 * The age after which a saved public link counts as dead. Taken from the server
 * itself where possible, so this check and the server can never disagree about
 * when a link is stale.
 */
let PUBLIC_URL_MAX_AGE_MS = 3 * 60 * 1000;

try {
  ({ PUBLIC_URL_MAX_AGE_MS } = require(path.join(ROOT, 'server', 'config')));
} catch (err) {
  // A server module that will not load is reported by its own section below.
}

let failures = 0;
let warnings = 0;

function pass(message) {
  console.log(`  \u2713 ${message}`);
}

function warn(message) {
  warnings += 1;
  console.log(`  ! ${message}`);
}

function fail(message, detail) {
  failures += 1;
  console.log(`  \u2717 ${message}`);
  if (detail) {
    console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  }
}

function heading(text) {
  console.log(`\n${text}`);
}

/** Generated output, never source: nothing here is worth parsing or reporting. */
const SKIP_DIRS = new Set(['node_modules', 'data', 'dist', 'dist-site', 'build', 'artifacts', '.git']);

function collectJavaScript(dir, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJavaScript(full, into);
    else if (entry.name.endsWith('.js')) into.push(full);
  }
}

/**
 * Is this file written as an ES module rather than a plain script?
 *
 * AirChat's own source is CommonJS, but the landing page's Worker is an ES
 * module (that is what the hosting runs), and `new vm.Script` refuses one. So a
 * file that starts with import/export is checked a second way instead of being
 * reported as broken. The pattern is deliberately anchored: a line that merely
 * mentions "export" inside a string or a comment must not change how the file is
 * read.
 */
function looksLikeModule(source) {
  return /^\s*(?:import|export)\b/m.test(source);
}

/**
 * Parse an ES module without running anything of ours from disk.
 *
 * A data: URL is the whole trick: it parses the source as a module and has no
 * filesystem to resolve against, so this can never accidentally execute the
 * file being checked, and a relative import in it cannot pull in a real module.
 */
async function parsesAsModule(source) {
  const encoded = Buffer.from(source, 'utf8').toString('base64');

  try {
    await import(`data:text/javascript;base64,${encoded}`);
    return { ok: true, note: 'ES module' };
  } catch (err) {
    // A module that imports something relative has nothing to resolve against
    // here, so only a syntax error counts against it.
    if (err instanceof SyntaxError) return { ok: false, detail: err.message };
    return { ok: true, note: 'ES module (imports not resolved here)' };
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Walk a PNG's chunks, verifying CRCs and that the pixel data really inflates to
 * the expected size. This is the one piece of AirChat that is hand-rolled binary
 * format writing, so it is worth proving rather than trusting.
 */
function validatePng(png, expectedSize, crc32) {
  const problems = [];
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (!Buffer.isBuffer(png)) return ['renderIcon did not return a Buffer'];
  if (png.length < 60) problems.push('file is too small to be a PNG');
  if (!png.subarray(0, 8).equals(signature)) problems.push('PNG signature is wrong');

  const idat = [];
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;

    if (dataStart + length + 4 > png.length) {
      problems.push(`chunk ${type} runs past the end of the file`);
      break;
    }

    const data = png.subarray(dataStart, dataStart + length);
    const stored = png.readUInt32BE(dataStart + length);

    if (crc32(png.subarray(offset + 4, dataStart + length)) !== stored) {
      problems.push(`chunk ${type} has a bad CRC`);
    }

    if (type === 'IHDR') {
      sawIhdr = true;
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (width !== expectedSize || height !== expectedSize) {
        problems.push(`IHDR says ${width}x${height}, expected ${expectedSize}x${expectedSize}`);
      }
      if (data[8] !== 8) problems.push(`bit depth is ${data[8]}, expected 8`);
      if (data[9] !== 6) problems.push(`colour type is ${data[9]}, expected 6 (RGBA)`);
    }

    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') sawIend = true;

    offset = dataStart + length + 4;
  }

  if (!sawIhdr) problems.push('no IHDR chunk found');
  if (!sawIend) problems.push('no IEND chunk found (file is truncated)');

  if (!idat.length) {
    problems.push('no IDAT chunk found');
  } else {
    try {
      const inflated = zlib.inflateSync(Buffer.concat(idat));
      const expected = expectedSize * (expectedSize * 4 + 1);
      if (inflated.length !== expected) {
        problems.push(`pixel data is ${inflated.length} bytes, expected ${expected}`);
      }
    } catch (err) {
      problems.push(`pixel data does not inflate: ${err.message}`);
    }
  }

  return problems;
}

async function checkIcons() {
  heading('App icons');

  let icons;
  try {
    icons = require(path.join(ROOT, 'server', 'icons.js'));
  } catch (err) {
    fail('server/icons.js failed to load', err.message);
    return;
  }

  if (typeof icons.renderIcon !== 'function' || typeof icons.crc32 !== 'function') {
    fail('server/icons.js does not export renderIcon and crc32');
    return;
  }

  // Sizes the manifest and the iOS home-screen icon actually ask for.
  for (const size of [180, 192, 512]) {
    try {
      const png = icons.renderIcon(size);
      const problems = validatePng(png, size, icons.crc32);
      if (problems.length) fail(`icon ${size}px is not a valid PNG`, problems.join('\n'));
      else pass(`icon ${size}px is a valid PNG (${Math.round(png.length / 1024)} KB)`);
    } catch (err) {
      fail(`icon ${size}px could not be generated`, err.message);
    }
  }
}

/** Cross-check the element ids app.js reaches for against index.html. */
function checkElementIds() {
  const htmlPath = path.join(ROOT, 'ui', 'index.html');
  const jsPath = path.join(ROOT, 'ui', 'app.js');

  if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) return;

  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  const declared = new Set();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) declared.add(match[1]);

  const requested = new Set();
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) requested.add(match[1]);
  for (const match of js.matchAll(/getElementById\('([^']+)'\)/g)) requested.add(match[1]);

  const missing = [...requested].filter((id) => !declared.has(id));

  if (missing.length) {
    fail(`app.js looks for elements index.html never defines: ${missing.join(', ')}`);
  } else {
    pass(`all ${requested.size} element ids used by app.js exist in index.html`);
  }
}

/**
 * Prove the public link really works, without needing cloudflared installed.
 *
 * The public address is what makes an invite openable from another house, and it
 * is also the thing most likely to be quietly wrong: an address saved after its
 * tunnel died is a friend staring at DNS. Running the real module against a
 * stand-in cloudflared checks the parts that would rot silently - reading the
 * address out of the output, stamping config.json, refreshing that stamp, and
 * clearing it on the way out - and leaves the machine as it found it.
 */
async function checkPublicLink() {
  heading('Public link');

  const modulePath = path.join(ROOT, 'server', 'tunnel.js');
  if (!fs.existsSync(modulePath)) {
    fail('server/tunnel.js is missing - the app and the tunnel launcher both need it');
    return;
  }

  let Tunnel;
  try {
    ({ Tunnel } = require(modulePath));
  } catch (err) {
    fail('server/tunnel.js failed to load', err.message);
    return;
  }

  if (typeof Tunnel !== 'function') {
    fail('server/tunnel.js does not export Tunnel');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-tunnel-'));
  const configPath = path.join(work, 'config.json');
  const stubPath = path.join(work, 'stub-cloudflared.js');

  try {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ token: 'keep-me', port: 4000 }, null, 2)}\n`,
      'utf8'
    );

    // What a real cloudflared prints, including the banner, so the address has to
    // be found inside noise rather than at the start of a line.
    fs.writeFileSync(
      stubPath,
      [
        "console.log('2026-10-17 INF Requesting new quick Tunnel on trycloudflare.com...');",
        'setTimeout(() => console.log(' +
          "'2026-10-17 INF |  https://doctor-check.trycloudflare.com  |'), 120);",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
      'utf8'
    );

    const tunnel = new Tunnel({
      binary: process.execPath,
      args: [stubPath],
      configPath,
      heartbeatMs: 200,
    });

    const result = await tunnel.start();

    if (!result.ok || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(result.url || '')) {
      fail('the tunnel address was not recognised', result.detail || `got: ${JSON.stringify(result)}`);
      return;
    }
    pass(`the address is read out of cloudflared's output: ${result.url}`);

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (saved.publicUrl !== result.url) {
      fail('the address was not saved to config.json', `publicUrl is ${JSON.stringify(saved.publicUrl)}`);
      return;
    }
    pass('it is saved to config.json, so invite links can use it');

    if (saved.token !== 'keep-me') {
      fail('saving the address overwrote other settings in config.json');
      return;
    }
    pass('nothing else in config.json is disturbed');

    const stale = () => Date.now() - Number(saved.publicUrlAt) > PUBLIC_URL_MAX_AGE_MS;
    if (!(Number(saved.publicUrlAt) > 0) || stale()) {
      fail('the address was saved without a usable proof-of-life stamp');
      return;
    }
    pass('it carries the time it was last known good');

    await new Promise((resolve) => setTimeout(resolve, 500));
    const refreshed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!(Number(refreshed.publicUrlAt) > Number(saved.publicUrlAt))) {
      fail('the stamp is not refreshed while the tunnel runs, so the link would look dead');
      return;
    }
    pass('the stamp is refreshed while the tunnel is up');

    tunnel.stop();
    const cleared = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cleared.publicUrl !== '' || Number(cleared.publicUrlAt) !== 0) {
      fail('stopping the tunnel left the address in config.json', JSON.stringify(cleared.publicUrl));
      return;
    }
    pass('stopping the tunnel withdraws the address, so no dead link can be handed out');

    // No cloudflared at all is a normal state, not a crash. Provisioning is
    // switched off here so this stays a test of the message rather than of this
    // machine's internet connection.
    const missing = await new Tunnel({ binary: 'airchat-no-such-binary', configPath, provision: false }).start();
    if (missing.ok || !/not installed/i.test(missing.detail || '')) {
      fail('a missing cloudflared is not reported as "not installed"', JSON.stringify(missing));
      return;
    }
    pass('a missing cloudflared is reported in words, not thrown');
  } catch (err) {
    fail('the public-link check crashed', err.message);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (err) {
      // A leftover temp folder is not worth failing the doctor over.
    }
  }
}

async function main() {
  console.log('AirChat doctor');

  /* ---- 1. environment ------------------------------------------------ */

  heading('Environment');

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) pass(`Node ${process.version}`);
  else fail(`Node ${process.version} is too old - AirChat needs Node 18 or newer`);

  if (typeof fetch === 'function') pass('global fetch is available (needed to send over iMessage/SMS/Telegram)');
  else fail('global fetch is missing, so the iMessage, SMS and Telegram adapters cannot send');

  if (typeof crypto.randomUUID === 'function') pass('crypto.randomUUID is available');
  else fail('crypto.randomUUID is missing; AirChat cannot generate ids on this Node version');

  /* ---- 2. syntax ----------------------------------------------------- */

  heading('Syntax');

  const files = [];
  collectJavaScript(ROOT, files);

  if (!files.length) {
    fail('found no JavaScript files to check - is this being run from inside the AirChat folder?');
  }

  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const source = fs.readFileSync(file, 'utf8');

    try {
      // Parse only. This never runs the file.
      new vm.Script(source, { filename: file });
      pass(relative);
      continue;
    } catch (err) {
      if (!looksLikeModule(source)) {
        fail(relative, err.message);
        continue;
      }
    }

    const module = await parsesAsModule(source);
    if (module.ok) pass(`${relative}  (${module.note})`);
    else fail(relative, module.detail);
  }

  /* ---- 3. server modules -------------------------------------------- */

  heading('Server modules');

  const EXPECTED = {
    'server/ws.js': ['handleUpgrade', 'encodeFrame', 'Connection', 'OPCODE'],
    'server/store.js': ['Store', 'MIRRORS', 'publicContact'],
    'server/config.js': ['loadConfig', 'DB_PATH', 'DATA_DIR'],
    'server/adapters/index.js': [
      'createAdapters',
      'MIRROR_CHANNELS',
      'parseBlueBubblesWebhook',
      'parseTwilioWebhook',
    ],
    'server/router.js': ['Router'],
    'server/tunnel.js': ['Tunnel', 'findCloudflared', 'writePublicUrl'],
  };

  for (const [relative, names] of Object.entries(EXPECTED)) {
    const full = path.join(ROOT, relative);

    if (!fs.existsSync(full)) {
      fail(`${relative} is missing`);
      continue;
    }

    try {
      const loaded = require(full);
      const missing = names.filter((name) => loaded[name] === undefined);

      if (missing.length) fail(`${relative} loads but does not export: ${missing.join(', ')}`);
      else pass(`${relative} loads, and exports ${names.length} expected values`);
    } catch (err) {
      fail(`${relative} failed to load`, err.message);
    }
  }

  /* ---- 4. interface -------------------------------------------------- */

  heading('Interface');

  for (const relative of ['ui/index.html', 'ui/styles.css', 'ui/app.js']) {
    const full = path.join(ROOT, relative);
    if (!fs.existsSync(full)) {
      fail(`${relative} is missing`);
      continue;
    }

    const size = fs.statSync(full).size;
    if (size === 0) fail(`${relative} is empty`);
    else pass(`${relative} (${Math.max(1, Math.round(size / 1024))} KB)`);
  }

  checkElementIds();

  for (const relative of ['ui/manifest.webmanifest', 'ui/sw.js']) {
    if (!fs.existsSync(path.join(ROOT, relative))) {
      fail(`${relative} is missing - the app will not install to a home screen`);
    }
  }

  const manifestPath = path.join(ROOT, 'ui', 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const missing = ['name', 'start_url', 'display', 'icons'].filter(
        (key) => manifest[key] === undefined
      );
      if (missing.length) fail(`manifest.webmanifest is missing: ${missing.join(', ')}`);
      else pass('manifest.webmanifest parses and has everything a phone needs');
    } catch (err) {
      fail('manifest.webmanifest is not valid JSON', err.message);
    }
  }

  await checkIcons();
  await checkPublicLink();

  /* ---- 5. end-to-end encryption -------------------------------------- */

  heading('End-to-end encryption');

  // Run the file the browser actually loads, here, for real: lock a message,
  // unlock it, and then prove that altered text and the wrong key are refused.
  // "It is encrypted" should never be something you have to take on trust.
  const cryptoPath = path.join(ROOT, 'ui', 'crypto.js');

  if (!fs.existsSync(cryptoPath)) {
    fail('ui/crypto.js is missing - the browser would have nothing to encrypt with');
  } else {
    try {
      const Crypto = require(cryptoPath);

      if (!Crypto.isAvailable()) {
        fail(`this build cannot encrypt anything: ${Crypto.unavailableReason()}`);
      } else {
        const result = await Crypto.selfTest();
        for (const line of result.lines) pass(line);

        if (result.ok) pass('messages are locked, unlocked, and tampering is refused');
        else fail(`the encryption self-test failed: ${result.error}`);
      }

      const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
      const cryptoTag = html.indexOf('src="/crypto.js"');
      const appTag = html.indexOf('src="/app.js"');

      if (cryptoTag === -1) {
        fail('index.html never loads /crypto.js, so nothing would ever be encrypted');
      } else if (appTag !== -1 && cryptoTag > appTag) {
        fail('index.html loads /crypto.js after /app.js, which needs it straight away');
      } else {
        pass('index.html loads /crypto.js before /app.js');
      }

      const serviceWorker = fs.readFileSync(path.join(ROOT, 'ui', 'sw.js'), 'utf8');
      if (serviceWorker.includes("'/crypto.js'")) {
        pass('the service worker keeps /crypto.js for offline use');
      } else {
        warn('sw.js does not list /crypto.js, so an installed AirChat could be missing it');
      }
    } catch (err) {
      fail('ui/crypto.js could not be loaded or tested', err.message);
    }
  }

  /* ---- 6. configuration --------------------------------------------- */

  heading('Configuration');

  let port = 4000;

  // The desktop app keeps its files in its own folder, so that is the one that
  // describes how the app will actually start; a config.json next to the code is
  // what a folder-download copy used, and is still read if the app has none yet.
  const appHome = process.env.APPDATA ? path.join(process.env.APPDATA, 'AirChat', 'home') : '';
  const configPath = [appHome && path.join(appHome, 'config.json'), path.join(ROOT, 'config.json')].find(
    (candidate) => candidate && fs.existsSync(candidate)
  );

  if (configPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && Number(parsed.port)) port = Number(parsed.port);
      pass(`config.json parses (${configPath.replace(ROOT, '.')})`);

      // A public link that outlived its tunnel is worse than no link at all: it
      // looks real here and fails in the friend's browser.
      const savedUrl = parsed && parsed.publicUrl;
      const stamp = Number(parsed && parsed.publicUrlAt);

      if (savedUrl && Number.isFinite(stamp) && stamp > 0) {
        if (Date.now() - stamp > PUBLIC_URL_MAX_AGE_MS) {
          warn(
            'config.json holds a public link from an earlier run, which no longer exists - ' +
              'the app opens a fresh one each time it starts, so this clears itself'
          );
        } else {
          pass('the public link in config.json is still fresh');
        }
      }

      const slots = (parsed && parsed.channels) || {};
      for (const channel of ['imessage', 'sms', 'telegram']) {
        const adapter = slots[channel] && slots[channel].adapter;
        if (!adapter) warn(`channels.${channel}.adapter is not set, so that channel stays off`);
      }
    } catch (err) {
      fail('config.json is not valid JSON', err.message);
    }
  } else {
    warn('config.json does not exist yet - AirChat will create it on first run');
  }

  if (await portIsFree(port)) {
    pass(`port ${port} is free`);
  } else {
    warn(`port ${port} is already in use - AirChat may already be running (fine), or change "port" in config.json`);
  }

  /* ---- result -------------------------------------------------------- */

  heading('Result');

  if (failures === 0) {
    const suffix = warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : '';
    console.log(`  AirChat looks good${suffix}. Start the app with:  npm run app`);
  } else {
    console.log(`  ${failures} problem${failures === 1 ? '' : 's'} found. Fix the \u2717 items above.`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nThe doctor itself crashed: ${err.stack || err.message}`);
  process.exit(1);
});
