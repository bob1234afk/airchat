'use strict';

/**
 * AirChat's public link - free, and with no account of any kind.
 *
 * Cloudflare's Quick Tunnels give your laptop a public HTTPS address without an
 * account, a domain, or opening a port on your router. This script ties it
 * together:
 *
 *   1. starts the tunnel and waits for the trycloudflare.com URL
 *   2. saves that URL into config.json as `publicUrl`, so the invite links
 *      AirChat hands out actually work from outside your house
 *   3. starts the server (which is why step 2 has to come first - the server
 *      reads publicUrl once, at startup)
 *   4. prints the exact link to send each friend
 *
 * Quick tunnel URLs are random and change every time this runs, which is the
 * trade for not needing an account. Re-run it and send the new link.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DB_PATH = path.join(ROOT, 'data', 'airchat.json');

/**
 * Prefer a cloudflared dropped next to this project.
 *
 * Installing the tunnel should be "download one file" for anyone who would
 * rather not use a package manager, so a cloudflared.exe in the AirChat folder
 * wins over whatever happens to be on PATH.
 */
function findCloudflared() {
  const local = path.join(ROOT, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  return 'cloudflared';
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`  Could not read ${path.relative(ROOT, file)}: ${err.message}`);
    return null;
  }
}

const config = readJson(CONFIG_PATH) || {};
const port = Number(config.port) || 4000;

/**
 * `--no-browser` starts AirChat without opening a browser tab. The tray launcher
 * passes it, because there the tray icon is the way in.
 */
const NO_BROWSER = process.argv.includes('--no-browser');

let tunnel = null;
let server = null;
let announced = false;
let output = '';

/** The address currently advertised in config.json, or null when there is none. */
let livePublicUrl = null;
let heartbeat = null;
/** A failed write is reported once per streak, not every 20 seconds. */
let writeTrouble = false;

/**
 * How often the link's proof of life is refreshed while the tunnel is up.
 *
 * server/config.js refuses to hand out a public link whose `publicUrlAt` stamp
 * is older than a few minutes (PUBLIC_URL_MAX_AGE_MS), so this interval has to
 * be comfortably shorter than that.
 */
const HEARTBEAT_MS = 20000;

/* ------------------------------------------------------------------ *
 * 0. Make sure this copy can actually take the port
 * ------------------------------------------------------------------ */

/**
 * Does anything already answer on AirChat's port?
 *
 * A second copy used to find out the hard way: it opened a tunnel, wrote that
 * address into config.json, then died on "port in use" - leaving a link that
 * pointed at a tunnel nobody was serving, while the leftover copy carried on
 * handing that dead address to friends. Asking first means a dead address is
 * never written.
 */
function portAnswers() {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;

    const done = (answer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };

    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Stop the leftovers of an older AirChat: node processes running something from
 * this exact folder, and any cloudflared. Nothing else is touched, and this
 * process never kills itself.
 */
function stopStaleCopies() {
  if (process.platform !== 'win32') return false;

  const root = ROOT.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = '${root}'`,
    "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      `Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and ` +
      '($_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore',
  });

  return !result.error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when AirChat can safely open a tunnel. The one thing that must
 * never happen is a public address existing without a server behind it.
 */
async function preflight() {
  if (!(await portAnswers())) return true;

  console.log('');
  console.log(`  Port ${port} is already in use - an older AirChat is still running.`);
  console.log('  Stopping it first, so the new link is not pointed at a dead server...');

  if (!stopStaleCopies()) {
    console.log('  Could not stop it automatically.');
    return explainPortBusy();
  }

  await wait(1500);

  if (!(await portAnswers())) {
    console.log('  Done - the old copy is stopped.');
    return true;
  }

  return explainPortBusy();
}

function explainPortBusy() {
  console.log('');
  console.log(`  Something else is holding port ${port}, so AirChat cannot start.`);
  console.log('  Close every AirChat window, then open Task Manager -> Details and end');
  console.log('  every node.exe and cloudflared.exe. Start this again afterwards.');
  console.log('');
  console.log('  No tunnel was opened, so no dead link was saved anywhere.');
  console.log('  (If you would rather use another port, change "port" in config.json.)');
  console.log('');
  return false;
}

/* ------------------------------------------------------------------ *
 * 1. The tunnel
 * ------------------------------------------------------------------ */

function startTunnel() {
  console.log('');
  console.log('  AirChat  ·  public link');
  console.log('');
  console.log('  Opening a free Cloudflare Quick Tunnel (no account, no signup)...');

  const binary = findCloudflared();
  if (binary !== 'cloudflared') {
    console.log(`  Using the cloudflared in this folder: ${path.basename(binary)}`);
  }

  try {
    tunnel = spawn(binary, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    explainMissingTunnel(err.message);
    return;
  }

  tunnel.stdout.on('data', (chunk) => watch(chunk));
  tunnel.stderr.on('data', (chunk) => watch(chunk));

  tunnel.on('error', (err) => {
    // Once the link exists the server is already on its way up; a later tunnel
    // hiccup must not start a second copy of it.
    if (announced) {
      console.error(`  cloudflared reported a problem: ${err.message}`);
      return;
    }

    if (err.code === 'ENOENT') explainMissingTunnel(null);
    else {
      console.error(`  Could not start cloudflared: ${err.message}`);
      startServer(null);
    }
  });

  tunnel.on('exit', (code) => {
    if (!announced) {
      console.error(`  cloudflared stopped before it produced a link (exit ${code}).`);
      startServer(null);
      return;
    }
    console.log(`\n  The public link closed (cloudflared exit ${code}). Re-run to get a new one.`);
    clearPublicUrl();
  });

  setTimeout(() => {
    if (!announced) {
      console.log('  Still waiting for cloudflared... (first run can take ~20 seconds)');
    }
  }, 20000);
}

function watch(chunk) {
  output += chunk.toString();

  if (announced) return;

  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;

  announced = true;
  onTunnelReady(match[0].replace(/\/+$/, ''));
}

function onTunnelReady(base) {
  console.log(`  Public address  ${base}`);

  if (savePublicUrl(base)) {
    console.log('  Saved it to config.json as "publicUrl".');
    console.log('  This address dies with this window: closing it, or pulling the plug,');
    console.log('  ends the link. Friends then need a fresh one - run this again.');
    startHeartbeat();
  } else {
    console.error('  Invite links will only work on your Wi-Fi until you set it by hand.');
  }

  startServer(base);
}

/**
 * Save - or, with an empty base, clear - the public link in config.json.
 *
 * A Quick Tunnel address only exists while this process does. Left behind in
 * config.json it becomes a link that AirChat happily hands to a friend and that
 * their browser answers with "server IP address could not be found", which is
 * how a dead app looks from the outside. So the link is written with the time
 * it was last known good (`publicUrlAt`), refreshed while the tunnel runs, and
 * removed when it stops.
 *
 * The file is re-read before writing rather than saving the startup snapshot,
 * so the token the server minted meanwhile - or an edit made while running - is
 * not overwritten.
 */
function savePublicUrl(base, quiet) {
  try {
    const current = readJson(CONFIG_PATH) || config;
    const next = Object.assign({}, current, {
      publicUrl: base,
      publicUrlAt: base ? Date.now() : 0,
    });

    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    livePublicUrl = base;
    writeTrouble = false;
    return true;
  } catch (err) {
    if (!quiet || !writeTrouble) {
      console.error(`  Could not save publicUrl to config.json: ${err.message}`);
      if (!quiet) {
        console.error('  Invite links will only work on your Wi-Fi until you set it by hand.');
      }
      writeTrouble = true;
    }
    return false;
  }
}

function startHeartbeat() {
  if (heartbeat) return;

  heartbeat = setInterval(() => {
    if (livePublicUrl) savePublicUrl(livePublicUrl, true);
  }, HEARTBEAT_MS);

  // A timer must never be the reason this window refuses to close.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

/** Stop advertising an address once it can no longer work. */
function clearPublicUrl() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (!livePublicUrl) return;
  livePublicUrl = null;

  if (savePublicUrl('')) {
    console.log('  Removed the expired public link from config.json, so AirChat will');
    console.log('  not hand out an address that no longer exists.');
  }
}

function explainMissingTunnel(detail) {
  if (detail) console.error(`  cloudflared did not start: ${detail}`);
  console.log('');
  console.log('  cloudflared is not installed, so AirChat will stay on your Wi-Fi only.');
  console.log('  To get a free public link (no account needed):');
  console.log('');
  console.log('      winget install --id Cloudflare.cloudflared');
  console.log('');
  console.log('  Then close this window and run this again.');
  startServer(null);
}

/* ------------------------------------------------------------------ *
 * 2. The server
 * ------------------------------------------------------------------ */

let serverStarted = false;

function startServer(publicBase) {
  if (serverStarted) return;
  serverStarted = true;

  console.log('');
  console.log('  Starting AirChat...');
  console.log('');

  const env = Object.assign({}, process.env);

  // Normally let the server open the browser for us; --no-browser suppresses it.
  if (NO_BROWSER) env.AIRCHAT_NO_BROWSER = '1';
  else delete env.AIRCHAT_NO_BROWSER;

  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });

  server.on('error', (err) => {
    console.error(`  Could not start the AirChat server: ${err.message}`);
    stop();
  });

  server.on('exit', (code) => {
    console.log(`\n  AirChat stopped (exit ${code}).`);
    stop();
  });

  // Give the server a moment to create its database before reading it back.
  setTimeout(() => {
    printFriendLinks(publicBase);
    if (publicBase) verifyPublicUrl(publicBase);
  }, 1500);
}

/**
 * Print the per-chat guest links, the ones actually safe to send to a friend.
 * The owner's own ?token= link is deliberately not printed here - it opens the
 * whole app.
 */
function printFriendLinks(publicBase) {
  const db = readJson(DB_PATH);

  if (!publicBase) {
    console.log('  No public link, so friends can only connect on your Wi-Fi.');
    console.log('  Open AirChat and click "Invite" in a chat for a local link.');
    console.log('');
    return;
  }

  if (!db || !Array.isArray(db.conversations)) {
    console.log('  Could not read data/airchat.json, so no friend links to show yet.');
    console.log('');
    return;
  }

  const guests = Array.isArray(db.guests) ? db.guests : [];

  const links = db.conversations
    .map((conversation) => {
      const guest = guests.find((entry) => entry.conversationId === conversation.id);
      if (!guest) return null;
      return { title: conversation.title, url: `${publicBase}/?guest=${guest.token}` };
    })
    .filter(Boolean);

  if (!links.length) {
    console.log('  No friend links yet. In AirChat, open a chat and click "Invite".');
    console.log('  That creates the link, and this window will not show it until you re-run.');
    console.log('');
    return;
  }

  console.log('  Links to send your friends  (they open it, then "Add to Home Screen"):');
  console.log('');
  for (const link of links) {
    console.log(`    ${link.title}`);
    console.log(`    ${link.url}`);
    console.log('');
  }

  // The key that unlocks a chat lives in the browser that made it, so it is
  // nowhere on this side to add to the address. Saying so is the difference
  // between "the link does not work" and "wrong copy of the link".
  console.log('  These open the chat but carry no key. For a locked chat, open Invite in');
  console.log('  AirChat and copy the link from there - that copy carries the key.');
  console.log('');
}

/**
 * Ask the internet whether the address this window just advertised really
 * answers. "My friend says the link does not work" is impossible to argue with
 * when the window itself reports the result, so it reports it.
 */
function verifyPublicUrl(base) {
  let attempts = 0;

  const once = () => {
    attempts += 1;

    const req = https.get(`${base}/`, { timeout: 8000 }, (res) => {
      res.resume();

      if (res.statusCode >= 500) {
        console.log(`  Checked from the internet: reached, but AirChat is not answering yet (HTTP ${res.statusCode}).`);
        return;
      }

      console.log(`  Checked from the internet: the link answers (HTTP ${res.statusCode}).`);
      console.log('  That is the address that works from your friend\u2019s phone.');
      console.log('');
    });

    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => {
      if (attempts < 3) {
        setTimeout(once, 4000);
        return;
      }

      console.log(`  Checked from the internet: no answer (${err.code || err.message}).`);
      console.log(`  ${base} does not work from outside this PC.`);
      console.log('  Wait a few seconds, or look at the cloudflared messages above for why.');
      console.log('');
    });
  };

  once();
}

/* ------------------------------------------------------------------ *
 * Shutting down
 * ------------------------------------------------------------------ */

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;

  clearPublicUrl();

  for (const child of [server, tunnel]) {
    if (!child || child.killed) continue;
    try {
      child.kill();
    } catch (err) {
      // Already gone; nothing to clean up.
    }
  }

  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

preflight().then((ready) => {
  if (!ready) process.exit(1);
  startTunnel();
});
