'use strict';

/**
 * AirChat as a real desktop window (Windows and macOS).
 *
 * The app is the whole product now, not a browser tab with a frame around it.
 * That means four things the browser used to provide by accident have to be
 * provided properly here:
 *
 *   1. **A place for your data that outlives the app.** The code lives in a
 *      folder the operating system replaces on every update, so messages and
 *      settings go in the app's own data folder instead - see AIRCHAT_HOME below.
 *      An update must never be able to lose a conversation.
 *   2. **The free public link.** Friends join by opening a link, so the app opens
 *      the Quick Tunnel itself (server/tunnel.js) rather than asking you to
 *      launch a .bat file next to it.
 *   3. **Permission to show notifications.** A browser asks once and remembers;
 *      Electron denies by default and never asks. Without the handler below,
 *      "Turn on notifications" silently fails in the app while working on the
 *      website - which is exactly the kind of difference this file exists to
 *      remove.
 *   4. **The interface knowing where it is.** desktop/preload.js tells it, so it
 *      stops offering to install itself to a home screen it is already on.
 *
 * Behaviour worth knowing:
 *   - If AirChat is already running on the port, this just opens a window onto
 *     it instead of failing with EADDRINUSE.
 *   - Links inside messages open in your normal browser, never in the app.
 *   - Closing the window closes AirChat: an app that keeps a server running with
 *     no window and no tray icon is an app nobody can stop.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');

// The window *is* the interface, so do not also pop open a browser tab.
process.env.AIRCHAT_NO_BROWSER = '1';

const ROOT = path.join(__dirname, '..');

/** The same version the installers carry, read once, for the window to show. */
const VERSION = (() => {
  try {
    return require(path.join(ROOT, 'package.json')).version || '0.0.0';
  } catch (err) {
    return '0.0.0';
  }
})();

/**
 * Where your messages and settings live.
 *
 * Set before the server is required, because server/config.js reads it once, at
 * load. Inside a packaged app the code sits under resources/app (or an .asar),
 * which is read-only in production and replaced wholesale by an update.
 */
const HOME = path.join(app.getPath('userData'), 'home');
process.env.AIRCHAT_HOME = HOME;

let mainWindow = null;
let tunnel = null;
let tunnelUrl = '';

/** Read the port straight out of config.json so both agree without starting up. */
function configuredPort() {
  // AIRCHAT_PORT is an AirChat-specific instruction and is honoured. A generic
  // PORT is not: it is set by all sorts of unrelated things (dev servers,
  // containers, shells) and it used to move the server off the port the window
  // and the invite links were built around, which looks like the app simply not
  // working. The app owns its port, and says so below.
  const explicit = Number(process.env.AIRCHAT_PORT || 0);
  if (explicit > 0) return explicit;

  for (const file of [path.join(HOME, 'config.json'), path.join(ROOT, 'config.json')]) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Number(parsed.port)) return Number(parsed.port);
    } catch (err) {
      // A broken config.json gets a clear error from the server; use the default.
    }
  }

  return 4000;
}

const PORT = configuredPort();
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Tell the in-process server which port this app is on.
 *
 * The server reads config.json and the environment; the window above reads the
 * same config. Setting AIRCHAT_PORT makes that one answer instead of two, and
 * dropping PORT stops an unrelated value from silently overriding the file.
 */
function pinPortForServer() {
  process.env.AIRCHAT_PORT = String(PORT);
  delete process.env.PORT;
}

/**
 * Move an existing installation's files into the app's data folder.
 *
 * Anyone who used AirChat from the folder they downloaded has a config.json and
 * a data/airchat.json sitting next to the code. Copying them across once means
 * installing the app cannot look like losing your chats, and the originals are
 * left alone in case they would rather go back.
 */
function adoptExistingFiles() {
  fs.mkdirSync(HOME, { recursive: true });

  const moves = [
    { from: path.join(ROOT, 'config.json'), to: path.join(HOME, 'config.json') },
    { from: path.join(ROOT, 'data', 'airchat.json'), to: path.join(HOME, 'data', 'airchat.json') },
  ];

  for (const { from, to } of moves) {
    try {
      if (fs.existsSync(to) || !fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      console.log(`[airchat] adopted ${path.relative(ROOT, from)} into ${to}`);
    } catch (err) {
      console.error(`[airchat] could not adopt ${from}: ${err.message}`);
    }
  }
}

function pingServer() {
  return new Promise((resolve) => {
    const request = http.get(`${BASE_URL}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });

    request.on('error', () => resolve(false));
    request.setTimeout(1200, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await pingServer()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

function startServer() {
  // The very same server the browser version uses, in this process.
  require(path.join(ROOT, 'server', 'index.js'));
}

/**
 * Stop orphaned tunnels that point at this port.
 *
 * If AirChat was killed rather than closed, its cloudflared is left behind and
 * keeps a public address alive that leads to a server that is not running - a
 * friend opening that link gets a Cloudflare error page, and the address looks
 * perfectly real to everyone else. Only cloudflared processes tunnelling *this*
 * port are touched, so another project's tunnel is none of our business.
 */
function stopOrphanTunnels() {
  if (process.platform !== 'win32') return;

  const needle = `--url http://localhost:${PORT}`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | " +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ` +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore',
  });

  if (!result.error) console.log('[airchat] cleared any tunnel left over from a previous run');
}

/**
 * Open the free public link, so an invite works away from home.
 *
 * Failing is normal and is not reported as an error: no cloudflared installed,
 * or no internet, simply means AirChat stays on your Wi-Fi - and the Invite
 * window already says exactly that. The one thing this must never do is take the
 * app down with it.
 */
async function startPublicLink() {
  try {
    stopOrphanTunnels();

    const { Tunnel } = require(path.join(ROOT, 'server', 'tunnel.js'));
    tunnel = new Tunnel({ root: ROOT, port: PORT, configPath: path.join(HOME, 'config.json') });

    tunnel.on('exit', (code, wasLive) => {
      tunnelUrl = '';
      if (wasLive) console.log(`[airchat] the public link closed (cloudflared exit ${code})`);
    });

    const result = await tunnel.start();

    if (result.ok) {
      tunnelUrl = result.url;
      // Nothing has to be told: server/index.js watches config.json and adopts a
      // fresh https address within a couple of seconds, then tells every open
      // window to redraw. The app deliberately does not add a second path for
      // the same thing.
      console.log(`[airchat] public link ready: ${tunnelUrl}`);
      return;
    }

    console.log(`[airchat] no public link: ${result.detail}`);
  } catch (err) {
    console.error(`[airchat] the public link could not start: ${err.message}`);
  }
}

/**
 * Let the interface ask for notifications.
 *
 * Electron refuses every permission unless a handler answers, and the browser
 * interface's "Turn on notifications" button has no way to tell the difference
 * between a refusal and a broken button. So: grant notifications, because that
 * is a request from our own interface on our own origin, and refuse everything
 * else by saying nothing about it.
 */
function grantOwnPermissions() {
  const isOurs = (url) => {
    try {
      const { origin } = new URL(url);
      return origin === BASE_URL || origin === `http://127.0.0.1:${PORT}`;
    } catch (err) {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'notifications' && isOurs((details && details.requestingUrl) || webContents.getURL())) {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, origin) => {
    if (permission === 'notifications' && isOurs(origin || '')) return true;
    return false;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 430,
    minHeight: 540,
    backgroundColor: '#08090d',
    title: 'AirChat',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // A sandboxed preload cannot read package.json, so the version travels in
      // the window's arguments instead of being looked up there.
      additionalArguments: [`--airchat-version=${VERSION}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // An invite link copied out of the app is meant to be opened elsewhere, so the
  // app never tries to load one itself.
  mainWindow.loadURL(`${BASE_URL}/?app=desktop`);
}

/**
 * Forget the previous run's public link before anything reads it.
 *
 * A Cloudflare Quick Tunnel address is handed out per run and stops resolving
 * the moment the process behind it ends, so whatever is written in config.json
 * when the app starts is an address that cannot be opened. The app either opens
 * a fresh one below or has none; keeping the old one would show a dead link and
 * build every invite on it, which is worse than having no link at all.
 */
function forgetPreviousLink() {
  const file = path.join(HOME, 'config.json');

  try {
    if (!fs.existsSync(file)) return;

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || !saved.publicUrl) return;

    saved.publicUrl = '';
    saved.publicUrlAt = 0;
    fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}
`);
    console.log("[airchat] forgot the previous run's public link");
  } catch (err) {
    // Not fatal: the server drops an address it cannot verify anyway.
    console.warn(`[airchat] could not clear the previous public link: ${err.message}`);
  }
}

/**
 * Remove a cached copy of an older interface before anything is loaded.
 *
 * A service worker registered by an earlier build sits in front of the app and
 * serves the files it cached - including the old app.js, which registers the
 * worker again. That loop cannot be broken from inside the interface (the new
 * code never gets to run), so it is broken here, before the window loads.
 *
 * Only those two storages are cleared. The chat keys live in localStorage and
 * the invite in a cookie, and both are left exactly as they were.
 */
async function evictStaleInterface() {
  try {
    // Deliberately not filtered by origin: a registration keyed slightly
    // differently (a trailing slash, a scheme) survives an origin-filtered
    // clear, and then the old interface is served again on every launch. This
    // session belongs to the app alone, so clearing these two storages across
    // it cannot touch anything of the user's.
    await session.defaultSession.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
  } catch (err) {
    // Not fatal: the app still opens, it may just show a cached interface once.
    console.warn(`[airchat] could not clear a cached interface: ${err.message}`);
  }
}

async function boot() {
  pinPortForServer();
  adoptExistingFiles();
  forgetPreviousLink();
  await evictStaleInterface();

  const alreadyRunning = await pingServer();

  if (!alreadyRunning) {
    try {
      startServer();
    } catch (err) {
      dialog.showErrorBox('AirChat could not start', err.message);
      app.quit();
      return;
    }

    if (!(await waitForServer(8000))) {
      dialog.showErrorBox(
        'AirChat could not start',
        `Nothing answered on ${BASE_URL} after starting the server.\n\nTry running "node server/index.js" in a terminal to see the error.`
      );
      app.quit();
      return;
    }
  }

  createWindow();

  // After the window exists, so the public address can be handed straight to the
  // interface rather than waiting for its next refresh.
  startPublicLink();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // AirChat draws its own UI, so the default menu bar adds nothing on Windows.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    grantOwnPermissions();
    boot();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Take the tunnel down with the app. A tunnel left running would keep a public
  // address alive that points at a server that is no longer there.
  app.on('will-quit', () => {
    if (tunnel) tunnel.stop();
  });
}
