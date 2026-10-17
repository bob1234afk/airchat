'use strict';

/**
 * AirChat's public link - free, and with no account of any kind.
 *
 * Cloudflare's Quick Tunnels give your laptop a public HTTPS address without an
 * account, a domain, or opening a port on your router. This script is the
 * terminal route to one:
 *
 *   1. make sure this copy can have the port (stop leftovers, or explain)
 *   2. open the tunnel and record its address in config.json
 *   3. start the server (which is why step 2 has to come first - the server
 *      reads publicUrl once, at startup)
 *   4. print the exact link to send each friend, and ask the internet whether it
 *      really answers
 *
 * The tunnel itself lives in server/tunnel.js, because the desktop app needs the
 * same thing without a terminal around it. What stays here is the part that only
 * makes sense from a command line: the port preflight, the printed summary, and
 * starting the server as a child process.
 *
 * Quick tunnel URLs are random and change every time this runs, which is the
 * trade for not needing an account. Re-run it and send the new link.
 */

const { spawn, spawnSync } = require('child_process');
const https = require('https');
const net = require('net');
const path = require('path');

const { Tunnel, readJson } = require('../server/tunnel');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DB_PATH = path.join(ROOT, 'data', 'airchat.json');

const config = readJson(CONFIG_PATH) || {};
const port = Number(config.port) || 4000;

/**
 * `--no-browser` starts AirChat without opening a browser tab. The tray launcher
 * passes it, because there the tray icon is the way in.
 */
const NO_BROWSER = process.argv.includes('--no-browser');

let tunnel = null;
let server = null;
const watchers = [];

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

async function startTunnel() {
  console.log('');
  console.log('  AirChat  ·  public link');
  console.log('');
  console.log('  Opening a free Cloudflare Quick Tunnel (no account, no signup)...');

  tunnel = new Tunnel({ root: ROOT, port, configPath: CONFIG_PATH });

  if (tunnel.binary !== 'cloudflared') {
    console.log(`  Using the cloudflared in this folder: ${path.basename(tunnel.binary)}`);
  }

  tunnel.on('log', (text) => {
    // Nothing of cloudflared's own chatter is worth showing; only problems are,
    // and those arrive through the exit and error paths below.
    if (/\berr\b|error|failed/i.test(text)) process.stdout.write(`  ${text.trim()}\n`);
  });

  tunnel.on('exit', (code, wasLive) => {
    if (wasLive) {
      console.log(`\n  The public link closed (cloudflared exit ${code}). Re-run to get a new one.`);
      console.log('  The address has been removed from config.json, so AirChat will not');
      console.log('  hand a friend a link that no longer works.');
      return;
    }

    console.log(`  cloudflared stopped before it produced a link (exit ${code}).`);
    startServer(null);
  });

  const stillWaiting = setTimeout(() => {
    if (!tunnel.url) console.log('  Still waiting for cloudflared... (first run can take ~20 seconds)');
  }, 20000);
  if (typeof stillWaiting.unref === 'function') stillWaiting.unref();
  watchers.push(stillWaiting);

  const result = await tunnel.start();
  clearTimeout(stillWaiting);

  if (!result.ok) {
    if (/not installed/i.test(result.detail)) explainMissingTunnel();
    else {
      console.error(`  ${result.detail}`);
      startServer(null);
    }
    return;
  }

  console.log(`  Public address  ${result.url}`);
  console.log('  Saved it to config.json as "publicUrl".');
  console.log('  This address dies with this window: closing it, or pulling the plug,');
  console.log('  ends the link. Friends then need a fresh one - run this again.');

  startServer(result.url);
}

function explainMissingTunnel() {
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

  for (const timer of watchers) clearTimeout(timer);
  watchers.length = 0;

  // Withdraws the address as well as killing the process, so config.json cannot
  // be left holding a link that no longer resolves.
  if (tunnel) tunnel.stop();

  // The tunnel killed its own child above; only the server is left here.
  if (server && !server.killed) {
    try {
      server.kill();
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
