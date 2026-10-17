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
const net = require('net');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');

// One name, so a development run and an installed copy read the same folder
// instead of quietly being two different AirChats with two sets of chats.
app.setName('AirChat');

// The window *is* the interface, so do not also pop open a browser tab.
process.env.AIRCHAT_NO_BROWSER = '1';

const ROOT = path.join(__dirname, '..');

/**
 * Run with no window: the mode `Start AirChat in Tray.bat` asks for.
 *
 * Everything else is identical - the same server, the same data folder, the same
 * public link - because a second, differently-configured AirChat is exactly the
 * confusion this file exists to remove. The tray icon is the way back to a
 * window; launching AirChat again shows it (see the single-instance handler).
 */
const BACKGROUND = process.argv.includes('--background');

/** Shown for the second or two before the interface can be.
 *
 * Creating the window first is the difference between "AirChat opened" and a
 * double-click that appears to do nothing while the server boots.
 */
const STARTING_PAGE = path.join(__dirname, 'starting.html');

/** The one record of public reachability, shared with the server (see server/link-status.js). */
const linkStatus = require(path.join(ROOT, 'server', 'link-status.js'));

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

/**
 * A log the app can be asked about.
 *
 * A window that closes by itself leaves nothing behind to look at: no console in
 * a packaged app, no message, just gone. Every decision this file can take - the
 * single-instance lock, the server, the window, the tunnel, a crash - is written
 * here first, so "it keeps closing" can be answered with facts instead of
 * guesses. `%APPDATA%\AirChat\airchat-app.log`, small and never rotated because
 * one launch's worth is a few dozen lines.
 */
const LOG_PATH = path.join(app.getPath('userData'), 'airchat-app.log');

/**
 * The port this run is actually serving on.
 *
 * Not the same thing as the configured port: if something else is holding that
 * one, the app moves rather than refusing to open, and anything else looking for
 * AirChat - the tray icon, a helper script - would look on a port with nothing
 * behind it and report the app as broken. Removed on quit, so a leftover file can
 * never send something to a port nobody is listening on.
 */
const PORT_FILE = path.join(app.getPath('userData'), 'airchat-port');

function rememberPort() {
  try {
    fs.writeFileSync(PORT_FILE, String(PORT));
  } catch (err) {
    // A port file that cannot be written is not a reason for anything to fail.
  }
}

function forgetPort() {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch (err) {
    // Already gone.
  }
}

function log(message) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch (err) {
    // A log that cannot be written must never be the reason the app fails.
  }
}

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

/**
 * The address this copy serves on.
 *
 * Deliberately not a constant. The configured port belongs to AirChat, but if
 * something else is already holding it, refusing to start - which is what used
 * to happen, with an error box and a closed app - is the least useful response
 * available. The app picks a free port instead and says so in its log.
 */
let PORT = configuredPort();
let BASE_URL = `http://localhost:${PORT}`;

/** True once the in-process server is answering. */
let serverReady = false;

/**
 * True when this copy is the one running the server, rather than a window onto a
 * copy that was already running.
 *
 * Only the owner may touch the public link: two tunnels writing one config.json
 * would fight over the address, and one of them would be giving friends a link
 * that stops working when the other one closes.
 */
let ownServer = false;

/** How many times a start is retried before anything is called a failure. */
const SERVER_ATTEMPTS = 3;

/** How long one attempt gets to answer before the next one is tried. */
const SERVER_WAIT_MS = 12000;

/**
 * What start-up is doing, for the window that is on screen while it happens.
 *
 * One object, replaced rather than edited, because the window renders whatever
 * it is handed - including the failure case, which is now a screen with a Try
 * again button instead of a dialog that closes the app.
 */
const startUp = { phase: 'idle', message: 'Opening your chats…', detail: '' };

function setStartUp(next) {
  Object.assign(startUp, next);

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('airchat:startup', startUp);
    } catch (err) {
      // A window mid-navigation is not a reason to fail start-up.
    }
  }

  return startUp;
}

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

  // Before the app set its own name, a development run said "airchat" while an
  // installed copy said "AirChat". On Windows those are the same folder; on a Mac
  // they are not, so chats made in the older one are adopted once rather than
  // left behind. The copy is skipped when the two are the same place.
  const legacy = path.join(app.getPath('appData'), 'airchat', 'home');
  const sameFolder = path.resolve(legacy) === path.resolve(HOME);

  const moves = [
    ...(sameFolder
      ? []
      : [
          { from: path.join(legacy, 'config.json'), to: path.join(HOME, 'config.json') },
          { from: path.join(legacy, 'data', 'airchat.json'), to: path.join(HOME, 'data', 'airchat.json') },
        ]),
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

/**
 * Is AirChat - specifically AirChat - answering on this port?
 *
 * A bare "HTTP 200 on /api/health" is not the question. Any other program that
 * happens to hold the port and answer there would be adopted as AirChat, and the
 * window would show somebody else's server with our name on it. The health reply
 * says which app it is, so that is what is checked.
 */
function pingServer() {
  return new Promise((resolve) => {
    const request = http.get(`${BASE_URL}/api/health`, (response) => {
      let body = '';

      response.on('data', (chunk) => {
        body += chunk;
      });

      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(false);
          return;
        }

        try {
          resolve(JSON.parse(body).app === 'AirChat');
        } catch (err) {
          resolve(false);
        }
      });
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
  // The very same server the browser version uses, in this process. The flag
  // below tells it not to call process.exit on a listen error: here that would
  // close the window along with the server, with nothing left to explain it.
  process.env.AIRCHAT_EMBEDDED = '1';
  require(path.join(ROOT, 'server', 'index.js'));
}

/** Could AirChat listen here? */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

/** Some port the operating system says is free right now. */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once('error', () => resolve(0));
    probe.listen(0, () => {
      const chosen = probe.address().port;
      probe.close(() => resolve(chosen));
    });
  });
}

/**
 * Make sure the server is up, starting it if it is not.
 *
 * This runs on every launch, because "the server starts whenever the app opens"
 * is the only launch story there is. It handles the two ways a start can fail
 * without being the person's fault:
 *
 *   - another AirChat is already answering: use it, which is what a second
 *     double-click should do;
 *   - something else owns the port: move to a free one rather than stopping.
 */
async function ensureServer() {
  if (await pingServer()) {
    log(`a server was already answering on ${BASE_URL}; opening a window onto it`);
    serverReady = true;
    ownServer = false;
    return true;
  }

  // Three goes, not one. A start can fail for reasons that have nothing to do
  // with this computer: something grabbed the port in the second between
  // checking it and listening on it, a virus scanner held a file open, the
  // first listen lost a race. Those pass on the second try, and none of them
  // deserve a screen saying AirChat is broken.
  for (let attempt = 1; attempt <= SERVER_ATTEMPTS; attempt += 1) {
    // A retry exists because the first try may have actually worked slowly.
    if (attempt > 1 && (await pingServer())) {
      log(`the server answered while retrying (attempt ${attempt})`);
      serverReady = true;
      ownServer = true;
      return true;
    }

    if (!(await portIsFree(PORT))) {
      const spare = await freePort();

      if (!spare) {
        log(`port ${PORT} is taken and no free port could be found`);
        setStartUp({
          phase: 'failed',
          message: `Port ${PORT} is being used by something else, and no other port was free.`,
          detail: 'Close whatever is using it, then choose Try again.',
        });
        return false;
      }

      log(`port ${PORT} is taken by another program; using ${spare} instead`);
      PORT = spare;
      BASE_URL = `http://localhost:${PORT}`;
    }

    pinPortForServer();

    try {
      // The first attempt loads the server and starts listening. Later attempts
      // ask the copy that is already loaded to listen again on the new port
      // (server/index.js), because requiring it twice does nothing.
      if (attempt === 1) startServer();
      else process.emit('airchat:listen-on', PORT);
    } catch (err) {
      log(`attempt ${attempt}: the server could not start: ${err.stack || err.message}`);
      continue;
    }

    if (await waitForServer(SERVER_WAIT_MS)) {
      log(`the server answered on ${BASE_URL} (attempt ${attempt})`);
      serverReady = true;
      ownServer = true;
      rememberPort();
      return true;
    }

    log(`attempt ${attempt}: nothing answered on ${BASE_URL} yet`);

    if (attempt < SERVER_ATTEMPTS) {
      setStartUp({ phase: 'starting', message: 'Trying again…', detail: '' });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  log(`the server did not answer after ${SERVER_ATTEMPTS} attempts`);
  setStartUp({
    phase: 'failed',
    message: 'AirChat could not get its chat server started.',
    detail: `Nothing answered on ${BASE_URL} after ${SERVER_ATTEMPTS} tries.\n\nDetails: ${LOG_PATH}`,
  });
  return false;
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
/**
 * How long to wait before each attempt to get the public link back.
 *
 * A Quick Tunnel is a free service and it does drop: Cloudflare restarts, the
 * home connection blips, a laptop sleeps. None of that is the person's fault and
 * none of it should need a restart, so the app keeps trying - gently at first, in
 * case it was a hiccup, then further apart so a link that cannot work does not
 * spin for ever.
 */
const LINK_RETRY_MS = [4000, 8000, 15000, 30000, 60000, 120000];

let linkAttempt = 0;
let linkTimer = null;
let quitting = false;

function scheduleLinkRetry(why) {
  if (quitting || linkTimer) return;

  const delay = LINK_RETRY_MS[Math.min(linkAttempt, LINK_RETRY_MS.length - 1)];
  linkAttempt += 1;

  log(`public link: trying again in ${Math.round(delay / 1000)}s (${why})`);

  linkTimer = setTimeout(() => {
    linkTimer = null;
    startPublicLink();
  }, delay);

  // A pending retry must never keep the app alive after it was asked to quit.
  if (typeof linkTimer.unref === 'function') linkTimer.unref();
}

/** The tunnel object, created once so its own cloudflared is not started twice. */
function tunnelForThisRun() {
  if (tunnel) return tunnel;

  stopOrphanTunnels();

  const { Tunnel } = require(path.join(ROOT, 'server', 'tunnel.js'));
  tunnel = new Tunnel({ root: ROOT, port: PORT, configPath: path.join(HOME, 'config.json') });

  tunnel.on('url', (url) => {
    tunnelUrl = url;
    log(`public link: ${url}`);
  });

  tunnel.on('provision', (event) => {
    if (event.phase === 'start') {
      log('public link: fetching cloudflared, because this machine has none');
    } else if (event.phase === 'done') {
      log(`public link: cloudflared is ready (${event.version || 'version unknown'})`);
    } else if (event.phase === 'failed') {
      log(`public link: cloudflared could not be fetched: ${event.detail}`);
    }
  });

  // An unexpected exit. `stop()` does not emit this, so anything arriving here is
  // the link genuinely dropping rather than the app shutting down.
  tunnel.on('exit', (code, wasLive) => {
    tunnelUrl = '';
    log(`public link: closed (cloudflared exit ${code})${wasLive ? '' : ' before it was ready'}`);
    scheduleLinkRetry('the link dropped');
  });

  return tunnel;
}

async function startPublicLink() {
  if (quitting) return;

  try {
    const result = await tunnelForThisRun().start();

    if (result.ok) {
      tunnelUrl = result.url;
      linkAttempt = 0;

      // Nothing else has to be told: server/index.js watches config.json and
      // adopts a fresh https address within a couple of seconds, then tells every
      // open window to redraw. The app deliberately does not add a second path
      // for the same thing.
      log(`public link ready: ${tunnelUrl}`);
      return;
    }

    log(`no public link: ${result.detail}`);

    if (result.permanent) {
      // Retrying cannot help until something changes on this machine, so say so
      // rather than pretending a fix is in progress.
      linkStatus.set({ state: linkStatus.STATE.UNAVAILABLE, detail: result.detail });
      return;
    }

    linkStatus.set({ state: linkStatus.STATE.RETRYING, detail: result.detail });
    scheduleLinkRetry(result.detail);
  } catch (err) {
    log(`the public link could not start: ${err.message}`);
    scheduleLinkRetry(err.message);
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

  log(`window created for ${BASE_URL}`);

  mainWindow.once('ready-to-show', () => {
    log('window ready; showing it');
    mainWindow.show();
  });
  mainWindow.on('close', () => {
    // Whatever asked, its stack is the only way to know: a close that arrives
    // while nobody is touching the app is the one thing that looks like "it
    // closed itself", and Electron's own frames name the path it came through.
    const from = new Error('who asked').stack.split('\n').slice(1, 6).join(' | ');
    log(`a close was requested on the window (${from})`);
  });

  mainWindow.on('closed', () => {
    log('the window was closed');
    mainWindow = null;
  });

  // The renderer dying is the one failure that looks exactly like "it closed
  // itself", so it is recorded rather than left as a blank window.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log(`the interface process ended: ${details.reason} (exit ${details.exitCode})`);
  });

  // Where the window was, and where it tried to go, when it closes by itself.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    log(`the window is navigating to ${url}`);
  });

  mainWindow.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) log(`the window started loading ${url}`);
  });

  mainWindow.webContents.on('destroyed', () => {
    log('the window\'s page was destroyed');
  });

  mainWindow.webContents.on('did-fail-load', (event, code, description, url) => {
    log(`the interface failed to load: ${description} (${code}) ${url}`);
  });

  // What the interface says when something goes wrong. Warnings and errors only:
  // everything else is the app working normally, and this log is read by people.
  mainWindow.webContents.on('console-message', (...args) => {
    const details = args.find((value) => value && typeof value === 'object' && 'message' in value);

    if (details) {
      const important =
        details.level === 'error' ||
        details.level === 'warning' ||
        // The window's own notes (a page asking to close, for instance) are not
        // errors, and they are the only explanation there is for some closes.
        String(details.message || '').startsWith('AirChat:');

      if (important) log(`the window said (${details.level}): ${details.message}`);
      return;
    }

    const [, level, message] = args;
    if (Number(level) >= 2) log(`the window said: ${message}`);
  });

  // A window that closes itself can only be explained by the code that closed it,
  // and the page's own window.close is not reachable from a sandboxed preload -
  // so it is wrapped here, in the page, as soon as there is a page to wrap.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents
      .executeJavaScript(
        `(() => {
          if (window.__airchatCloseHooked) return true;
          window.__airchatCloseHooked = true;
          const original = window.close.bind(window);
          window.close = function () {
            try { console.log('AirChat: the page asked to close the window: ' + new Error().stack); } catch (err) {}
            return original();
          };
          return true;
        })()`,
        true
      )
      .catch(() => {
        // A page that will not run this is not a failure; it just cannot explain itself.
      });
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
  if (serverReady) showInterface();
  else loadStartingScreen();
}

/** Show the "starting" window. The one thing that is always possible. */
function loadStartingScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.loadFile(STARTING_PAGE).catch((err) => {
    log(`the starting screen did not load: ${err.message}`);
  });
}

/**
 * Move the window from "starting" to AirChat itself.
 *
 * A failure here is shown rather than swallowed: a window that keeps saying it is
 * starting, for ever, is indistinguishable from a frozen app.
 */
function showInterface() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  setStartUp({ phase: 'ready', message: 'Ready', detail: '' });

  mainWindow.loadURL(`${BASE_URL}/?app=desktop`).catch((err) => {
    log(`the interface could not load: ${err.message}`);

    setStartUp({
      phase: 'failed',
      message: 'The window could not open AirChat.',
      detail: `${err.message}\n\nDetails: ${LOG_PATH}`,
    });

    loadStartingScreen();
  });
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
    //
    // Bounded, because this is housekeeping and not start-up. When another copy
    // of AirChat already has the profile open, this call can wait on a storage
    // lock that will not be released until that copy closes - and an app that
    // waits there shows no window at all, which is the one thing this file is
    // built to avoid.
    const clearing = session.defaultSession.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });

    await Promise.race([
      clearing.catch((err) => {
        console.warn(`[airchat] could not clear a cached interface: ${err.message}`);
      }),
      new Promise((resolve) => setTimeout(resolve, 4000).unref()),
    ]);
  } catch (err) {
    // Not fatal: the app still opens, it may just show a cached interface once.
    console.warn(`[airchat] could not clear a cached interface: ${err.message}`);
  }
}

async function boot() {
  adoptExistingFiles();

  // Only the copy that runs the server may forget the previous link: a second
  // window onto a running AirChat would otherwise clear the live address the
  // running copy just handed out, and every invite built on it would break.
  if (isOwner) forgetPreviousLink();

  // The window goes up before anything that can fail or wait, because the window
  // is what "AirChat opened" means. Whatever happens next - the server, the port,
  // the tunnel, even a profile another copy has locked - is reported inside it
  // rather than instead of it.
  if (BACKGROUND) log('starting with no window, for the tray icon');
  else createWindow();

  await evictStaleInterface();

  await startEverything();
}

/**
 * Start the server, then hand the window over to the real interface.
 *
 * Every failure ends on a screen a person can act on. Nothing here closes the
 * app: a dialog that quits on a transient problem is the difference between "it
 * did not work that time" and "it keeps closing by itself".
 */
async function startEverything() {
  const ready = await ensureServer();

  if (!ready) {
    if (!BACKGROUND && !mainWindow) createWindow();
    return;
  }

  if (!mainWindow && !BACKGROUND) createWindow();
  else if (mainWindow) showInterface();

  // After the window exists, so the public address can be handed straight to the
  // interface rather than waiting for its next refresh. Only the copy that runs
  // the server opens a link: a window onto somebody else's server has nothing to
  // tunnel, and a second tunnel would replace the address already handed out.
  if (ownServer) startPublicLink();
  else log('not opening a public link: the copy that is already running owns it');
}

/**
 * A crash used to close AirChat, which is the one thing nobody can diagnose.
 *
 * Now it is written down and shown in the window, and the app stays up: most of
 * what can throw here is one feature failing, and closing everything hides that
 * behind "it just closed".
 */
process.on('uncaughtException', (err) => {
  log(`CRASH ${err && err.stack ? err.stack : err}`);

  setStartUp({
    phase: 'failed',
    message: 'AirChat ran into a problem.',
    detail: `${(err && err.message) || err}\n\nDetails: ${LOG_PATH}`,
  });

  if (mainWindow && !mainWindow.isDestroyed()) loadStartingScreen();
  else if (!BACKGROUND) {
    try {
      createWindow();
    } catch (failed) {
      log(`the window could not be shown after a crash: ${failed.message}`);
    }
  }
});

/**
 * The server could not listen (see server/index.js).
 *
 * In a terminal that is a fatal error; embedded in the app it is a screen with a
 * Try again button, because the app is still perfectly able to show one.
 */
process.on('airchat:server-failed', (err) => {
  // Recorded, then answered by trying again on another port (see ensureServer).
  // Showing "could not start" here would be a screen about one failed attempt,
  // put in front of a person while the app is already recovering.
  log(`the server could not listen: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION ${reason && reason.stack ? reason.stack : reason}`);
});

log(`start ${VERSION} ${process.platform} ${process.arch} port=${PORT} home=${HOME}`);

/**
 * Is this the copy that owns AirChat?
 *
 * Asking for the lock also tells a running copy to show its window, which is
 * what makes a second double-click feel exactly like the first one. Losing it
 * used to mean this copy quit on the spot - and if the copy that held it had no
 * window to show, the double-click appeared to do nothing at all. That is
 * precisely what "AirChat keeps closing" looks like from the outside.
 *
 * So losing it no longer quits. The window opens anyway, pointed at the server
 * that is already running (ensureServer finds it), and this copy simply does not
 * own the server or the public link. One AirChat, one server, one link, however
 * many times its icon is clicked.
 */
const isOwner = app.requestSingleInstanceLock();

if (!isOwner) log('another copy is already running; opening a window onto it');

if (!isOwner && BACKGROUND) {
  // A second background copy would be a duplicate of the first, with nothing to
  // add. The tray icon that asked for it is already pointing at the real one.
  log('already running; a second background copy is not needed, so this one stops');
  app.quit();
} else {
  if (isOwner) {
    app.on('second-instance', () => {
      log('a second launch was asked to show this window');

      // A running copy with no window - left behind by a failed start - would
      // otherwise swallow every later double-click in silence.
      if (!mainWindow) {
        createWindow();
        return;
      }

      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }

  app.whenReady().then(() => {
    log('ready');

    // AirChat draws its own UI, so the default menu bar adds nothing on Windows.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    grantOwnPermissions();
    boot();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    // Started from the tray, the icon - not the window - is how AirChat is
    // stopped, so closing the window leaves it running. Started normally, closing
    // the window still means stop, exactly as before.
    if (BACKGROUND) {
      log('the last window closed; still running, because it was started in the tray');
      return;
    }

    log('the last window closed; quitting');
    app.quit();
  });

  // Take the tunnel down with the app. A tunnel left running would keep a public
  // address alive that points at a server that is no longer there.
  // What the window says about itself, into the same log (see desktop/preload.js).
  ipcMain.on('airchat:note', (event, message) => {
    log(`from the window: ${message}`);
  });

  // The starting screen asks where start-up got to, and is told when it moves.
  ipcMain.handle('airchat:startup', () => startUp);

  // Retry is a clean restart rather than a clever partial one: the port may have
  // been taken, the tunnel may have been mid-handshake, and relaunching answers
  // all of that with the same code path that launched the app in the first place.
  ipcMain.on('airchat:retry', () => {
    log('the window asked to try again; relaunching');

    quitting = true;
    if (linkTimer) clearTimeout(linkTimer);
    if (tunnel) tunnel.stop();

    app.relaunch();
    app.exit(0);
  });

  app.on('before-quit', () => {
    const from = new Error('who asked').stack.split('\n').slice(1, 4).join(' | ');
    log(`quitting; requested by ${from}`);

    // No more attempts, and no timer left that would keep the process alive.
    quitting = true;
    if (linkTimer) {
      clearTimeout(linkTimer);
      linkTimer = null;
    }
  });

  app.on('will-quit', () => {
    if (tunnel) tunnel.stop();
    if (ownServer) forgetPort();
  });
}
