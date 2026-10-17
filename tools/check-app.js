'use strict';

/**
 * Proves the desktop app does the things the website used to do.
 *
 * The app and the browser load the same interface, so "it works on the website"
 * is not evidence that it works here - the app has to provide a secure context,
 * crypto, notifications and the public link itself, and each of those can be
 * silently missing while the interface looks perfectly normal.
 *
 * So this launches the real app, attaches to its own DevTools protocol endpoint,
 * and asks the running interface the questions that matter:
 *
 *   1. does it know it is the app (desktop/preload.js reached it)?
 *   2. is it a secure context with real WebCrypto behind it?
 *   3. does the encryption self-test pass, in the app?
 *   4. can a locked message survive a full round trip - browser to server to disk
 *      to browser - with the plain text nowhere on disk?
 *   5. do the chat keys survive a reload (an app that forgets its keys is an app
 *      that loses every conversation it ever had)?
 *   6. are notifications actually permitted? Electron denies by default.
 *   7. is there a public link, and does it answer from the internet?
 *   8. does opening it a second time open a window, instead of closing?
 *
 * Usage:  node tools/check-app.js                 (launches the app itself)
 *         node tools/check-app.js --attach 9222   (a copy already running)
 *         node tools/check-app.js --port 9333     (different debug port)
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

const DEBUG_PORT = Number(readFlag('--port')) || 9222;
const ATTACH = Number(readFlag('--attach')) || 0;
const KEEP_OPEN = process.argv.includes('--keep-open');

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
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
}

function heading(text) {
  console.log(`\n${text}`);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the app's own config.json says about the public link right now. */
function readStoredLink() {
  try {
    const file = path.join(appHome().dir, 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Where the app keeps the user's own files.
 *
 * Electron names that folder after the app, and a development run and an
 * installed one disagree about capitalisation (`airchat` against `AirChat`),
 * so both are looked for rather than guessing one and reporting a false alarm.
 */
function appHome() {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config');

  const candidates = ['AirChat', 'airchat'].map((name) => path.join(base || '', name, 'home'));
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'config.json')));

  return { dir: found || candidates[0], candidates };
}

/* ------------------------------------------------------------------ *
 * Talking to the running app
 * ------------------------------------------------------------------ */

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = require('http').get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`could not read ${url}: ${err.message}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('timed out')));
  });
}

/**
 * Find the app's own window.
 *
 * Electron always has a page target before the window loads anything, and it is
 * `about:blank`, so attaching to "the first page" reports a blank interface as
 * broken encryption. Only a target that is actually serving AirChat will do.
 */
const APP_URL = /^https?:\/\/(localhost|127\.0\.0\.1):\d+\//;

/**
 * Attach to the window that is really serving AirChat.
 *
 * A window exists before it has loaded anything, and its first renderer context
 * is the empty document - evaluating in that reports `about:blank`, no crypto,
 * and no preload bridge, which reads exactly like a broken app. So each
 * candidate is asked where it is before it is trusted, and the wait continues
 * until one answers with an AirChat address.
 */
async function attachToApp(timeoutMs, debugPort = DEBUG_PORT) {
  const deadline = Date.now() + timeoutMs;
  let saw = [];

  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await httpJson(`http://127.0.0.1:${debugPort}/json/list`);
    } catch (err) {
      await sleep(400);
      continue;
    }

    saw = targets.filter((target) => target.type === 'page').map((target) => target.url || '(no url)');

    for (const target of targets) {
      if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;

      const client = await connect(target.webSocketDebuggerUrl).catch(() => null);
      if (!client) continue;

      const href = await client.evaluate('location.href').catch(() => null);
      if (href && APP_URL.test(href)) return { client, target, href };

      client.close();
    }

    await sleep(400);
  }

  if (saw.length) console.log(`  (page targets seen: ${saw.join(', ')})`);
  return null;
}

/** A minimal DevTools-protocol client: one socket, one pending call at a time. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    let closed = false;

    socket.addEventListener('open', () => {
      resolve({
        /**
         * A plain DevTools command.
         *
         * Some things must not go through an evaluation: asking a page to reload
         * itself through Runtime.evaluate with awaitPromise and returnByValue
         * tears the target down instead (the reply is waited for across a
         * navigation that destroys the context), which looks exactly like the app
         * closing itself the moment the check reloads it.
         */
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;

          const answer = new Promise((res, rej) => pending.set(id, { res, rej, method }));
          socket.send(JSON.stringify({ id, method, params }));
          return answer;
        },

        async evaluate(expression) {
          // Asking a socket that is already gone would leave this promise hanging
          // for ever, and a check with nothing left to wait for exits silently in
          // the middle of its own report.
          if (closed) throw new Error('the app window is no longer there');

          const id = nextId;
          nextId += 1;

          const answer = new Promise((res, rej) => pending.set(id, { res, rej, method: 'Runtime.evaluate' }));

          socket.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true },
            })
          );

          return answer;
        },
        close() {
          try {
            socket.close();
          } catch (err) {
            // Nothing to do.
          }
        },
      });
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        return;
      }

      const waiting = pending.get(payload.id);
      if (!waiting) return;
      pending.delete(payload.id);

      if (payload.error) {
        waiting.rej(new Error(payload.error.message));
        return;
      }

      // A plain command (Page.reload, Page.enable) answers with its own result
      // object, which has no evaluation inside it.
      if (waiting.method !== 'Runtime.evaluate') {
        waiting.res(payload.result || null);
        return;
      }

      const result = payload.result && payload.result.result;
      if (!result) {
        waiting.rej(new Error('the app returned nothing'));
        return;
      }

      if (result.subtype === 'error') {
        waiting.rej(new Error(result.description || 'the app threw'));
        return;
      }

      // An object we asked for by value arrives as JSON in `value`.
      if (result.value !== undefined) waiting.res(result.value);
      else if (result.description) waiting.res(result.description);
      else waiting.res(null);
    });

    socket.addEventListener('error', () => reject(new Error('could not attach to the app')));

    // A window that goes away mid-call would otherwise leave the promise pending
    // for ever: no timers, no handles, and Node exits silently in the middle of
    // the report - which reads exactly like the check crashing.
    socket.addEventListener('close', () => {
      closed = true;
      for (const [, waiting] of pending) waiting.rej(new Error('the app window went away'));
      pending.clear();
    });
  });
}

/** The port the app is expected to listen on, read the way desktop/main.js reads it. */
function appPort() {
  const explicit = Number(process.env.AIRCHAT_PORT || 0);
  if (explicit > 0) return explicit;

  for (const file of [path.join(appHome().dir, 'config.json'), path.join(ROOT, 'config.json')]) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Number(parsed.port)) return Number(parsed.port);
    } catch (err) {
      // A broken config.json is the server's error to report, not this one's.
    }
  }

  return 4000;
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

async function main() {
  // Anything older than this run is by definition a leftover.
  const startedAt = Date.now();

  console.log('AirChat app check');

  let electron = null;
  let appLog = '';

  /** Always stop the app we started, however this run ends. */
  function stopApp() {
    if (!electron) return;
    try {
      electron.kill();
    } catch (err) {
      // Already gone.
    }
    electron = null;
  }

  process.on('exit', stopApp);
  process.on('SIGINT', () => {
    stopApp();
    process.exit(130);
  });

  if (!ATTACH) {
    // Attaching to a stray copy would test the wrong thing and report it as a
    // broken app, which is exactly what happened the first time this ran.
    const stray = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`).catch(() => null);
    if (stray) {
      fail(
        `something is already listening on the debug port ${DEBUG_PORT}`,
        'close that copy of AirChat, or run with --attach ' + DEBUG_PORT + ' to use it'
      );
      process.exit(1);
    }

    // The app adopts a server already listening instead of starting its own,
    // which is right for a second launch and wrong for this check: the window
    // would be a second window onto whatever copy was already running. That is
    // not hypothetical - an older installed build held the port and every result
    // described it rather than the code in this folder.
    const port = appPort();
    const occupant = await httpJson(`http://127.0.0.1:${port}/api/health`).catch(() => null);

    if (occupant) {
      fail(
        `an AirChat is already running on port ${port}`,
        'quit it first - otherwise these results describe that copy, not this folder'
      );
      process.exit(1);
    }

    const binary = require('electron');
    const electronPath = typeof binary === 'string' ? binary : binary.default;

    if (!fs.existsSync(electronPath)) {
      fail('Electron is not installed', `looked for ${electronPath} - run npm install`);
      process.exit(1);
    }

    heading('Starting the app');
    console.log(`  ${path.relative(ROOT, electronPath)}`);

    electron = spawn(electronPath, [ROOT, `--remote-debugging-port=${DEBUG_PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
    });

    electron.stdout.on('data', (chunk) => {
      appLog += chunk.toString();
      process.stdout.write(`  [app] ${chunk}`);
    });
    electron.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      // Chromium is noisy on some machines; only pass on real complaints.
      if (/error|failed|cannot|denied/i.test(text)) process.stdout.write(`  [app] ${text}\n`);
    });
  }

  const attached = await attachToApp(ATTACH ? 4000 : 30000);

  if (!attached) {
    fail('could not attach to the app window', `nothing serving AirChat on the debug port ${DEBUG_PORT}`);
    stopApp();
    process.exit(1);
  }

  let client = attached.client;
  await client.send('Page.enable').catch(() => null);

  try {
    /* ---- 1. the app knows it is the app ------------------------------ */

    heading('The app knows where it is');

    const identity = await client.evaluate(
      `({ isApp: !!(window.airchatApp && window.airchatApp.isApp), version: (window.airchatApp && window.airchatApp.version) || '', href: location.href, secure: window.isSecureContext, worker: !!(navigator.serviceWorker && navigator.serviceWorker.controller) })`
    );

    if (identity.isApp) pass(`desktop/preload.js reached the interface (AirChat ${identity.version})`);
    else fail('the interface does not know it is the app', 'window.airchatApp is missing');

    if (/\?app=desktop/.test(identity.href)) pass('the window loaded the app marker');
    else warn(`the app marker is missing from the address: ${identity.href}`);

    // (the service worker question is asked after the reload below, when the
    // app has had a load to act on it - see "the app does not cache itself")

    /* ---- 2. a secure context with real crypto ------------------------ */

    heading('Encryption, in the app');

    const cryptoState = await client.evaluate(
      `({ secure: window.isSecureContext, subtle: typeof (window.crypto && window.crypto.subtle), available: !!(window.AirChatCrypto && window.AirChatCrypto.isAvailable()) })`
    );

    if (cryptoState.secure && cryptoState.available) {
      pass('the interface is a secure context with WebCrypto available');
    } else {
      fail(
        'the app cannot encrypt',
        `isSecureContext=${cryptoState.secure}, subtle=${cryptoState.subtle}, available=${cryptoState.available}`
      );
    }

    if (!cryptoState.available) {
      fail('window.AirChatCrypto is not there, so nothing below can be tested');
    }

    const selfTest = await client.evaluate(
      `(window.AirChatCrypto ? window.AirChatCrypto.selfTest() : { ok: false, lines: [], error: 'AirChatCrypto did not load' })`
    );
    for (const line of (selfTest && selfTest.lines) || []) pass(line);
    if (!(selfTest && selfTest.ok)) {
      fail(`the encryption self-test failed: ${(selfTest && selfTest.error) || 'unknown'}`);
    }

    /* ---- 3. a locked message, end to end ----------------------------- */

    heading('A locked message, from the app to the disk and back');

    const roundTrip = await client.evaluate(`(async () => {
      if (!window.AirChatCrypto || !window.AirChatCrypto.isAvailable()) {
        return { stage: 'no-crypto' };
      }

      const api = (path, body) => fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

      const made = await api('/api/conversations', {
        name: 'App check', address: 'airchat:app-check', channel: 'sms', mirror: 'none',
      });
      if (!made.body || !made.body.conversation) return { stage: 'create', answer: made };

      const conversationId = made.body.conversation.id;
      const key = AirChatCrypto.newKey();
      const cipher = await AirChatCrypto.encrypt(key, conversationId, 'locked from the app');

      const sent = await api('/api/send', { conversationId, body: cipher });
      if (sent.status !== 200) return { stage: 'send', answer: sent };

      const state = await api('/api/state');
      const stored = (state.body.messages[conversationId] || []).find((m) => m.id === sent.body.message.id);
      const opened = await AirChatCrypto.decrypt(key, conversationId, stored.body);

      window.localStorage.setItem('airchat.keys', JSON.stringify({ [conversationId]: key }));

      return {
        stage: 'done',
        conversationId,
        cipher,
        storedBody: stored.body,
        opened,
        channel: stored.channels,
      };
    })()`);

    if (!roundTrip || roundTrip.stage !== 'done') {
      fail('a locked message could not be sent from the app', JSON.stringify(roundTrip));
    } else {
      if (roundTrip.storedBody.startsWith('airchat-enc-v1:')) pass('the server stored cipher, not text');
      else fail('the stored message is not cipher', roundTrip.storedBody.slice(0, 60));

      if (roundTrip.opened === 'locked from the app') pass('the other side can unlock it with the shared key');
      else fail('the message did not decrypt back', JSON.stringify(roundTrip.opened));

      /* ---- 4. does the plain text appear on disk? -------------------- */

      const home = appHome();
      const dbPath = path.join(home.dir, 'data', 'airchat.json');

      if (!fs.existsSync(dbPath)) {
        warn(`could not find the app's database to inspect (${dbPath})`);
      } else {
        const raw = fs.readFileSync(dbPath, 'utf8');
        if (raw.includes('locked from the app')) fail('the plain text is on disk in the app data folder');
        else pass(`the plain text is nowhere in ${path.relative(ROOT, dbPath) || dbPath}`);

        if (raw.includes(roundTrip.cipher.slice(0, 40))) pass('the cipher is what the app data folder holds');
      }

      if (fs.existsSync(path.join(home.dir, 'config.json'))) {
        pass(`the app keeps its own files outside the install folder (${home.dir})`);
      } else {
        warn(
          `no config.json in any of: ${home.candidates.join(', ')} - the app may still be writing next to its code`
        );
      }

      // The check leaves the app as it found it: the test chat goes away.
      await client.evaluate(
        `fetch('/api/conversations/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: ${JSON.stringify(roundTrip.conversationId)} }) }).then((r) => r.status)`
      );
    }

    /* ---- 5. keys survive a reload ------------------------------------ */

    // Reload only once the page has finished its own first load: asked to reload
    // while the initial navigation is still committing, the window can tear down
    // before it is ever really up, which reads as "the app closed itself".
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ready = await client.evaluate('document.readyState').catch(() => null);
      if (ready === 'complete') break;
      await sleep(250);
    }

    await client.send('Page.reload', {});
    await sleep(2500);

    const afterReload = await attachToApp(8000);
    if (!afterReload) {
      fail('the app window did not come back after a reload');
    } else {
      const client2 = afterReload.client;

      // The page was reloaded, so the connection from before it is spent. Every
      // section below has to talk to the window that exists now, not the one that
      // was there when the check started.
      const previous = client;
      client = client2;
      previous.close();

      try {
        const remembered = await client2.evaluate(
          `JSON.stringify(Object.keys(JSON.parse(window.localStorage.getItem('airchat.keys') || '{}')).length)`
        );
        if (Number(remembered) > 0) pass('chat keys are still there after a reload');
        else fail('the app forgot its chat keys on reload');

        // Asked now rather than at startup: the app removes any service worker
        // it finds, and a removal only takes full effect on the next load. An app
        // that caches its own files underneath itself would keep serving an old
        // interface after an update, which is the failure this guards against.
        // Reported, never repaired: this check exists to say whether the app
        // starts clean, and an unregister here would hide the one failure it is
        // looking for behind its own fix.
        const sw = await client2.evaluate(`(async () => {
          if (!navigator.serviceWorker) return { list: [], controller: 'none', controlled: false };
          const list = await navigator.serviceWorker.getRegistrations();
          return {
            list: list.map((r) => ({
              scope: r.scope,
              script: (r.active || r.installing || r.waiting || {}).scriptURL || r.scope,
              state: (r.active || r.installing || r.waiting || {}).state || 'unknown',
            })),
            controller: navigator.serviceWorker.controller
              ? navigator.serviceWorker.controller.scriptURL
              : 'none',
            controlled: !!navigator.serviceWorker.controller,
          };
        })()`);

        const entries = (sw && sw.list) || [];
        if (entries.length === 0 && !(sw && sw.controlled)) {
          pass('the app does not cache itself with a service worker');
        } else {
          fail(
            'a cached interface is still in front of the app',
            `${entries.map((r) => `${r.script} (${r.state})`).join(', ') || 'no registration'} | ` +
              `controlling this page: ${sw && sw.controller}`
          );
        }
      } finally {
        // Left open on purpose: the sections after this one use it, and the whole
        // check closes it once.
      }
    }

    /* ---- 6. notifications -------------------------------------------- */

    heading('Notifications');

    const permission = await client.evaluate('Notification.permission');
    if (permission === 'granted') {
      pass('notifications are permitted by the app');
    } else if (permission === 'denied') {
      fail('the app refuses notifications - the permission handler is missing');
    } else {
      warn(`notification permission is "${permission}" - the interface has not been granted it yet`);
    }

    // Actually raising one, because permission being granted and a notification
    // being showable are two different things, and only one of them is a promise.
    const shown = await client.evaluate(`(() => {
      try {
        const note = new Notification('AirChat check', { body: 'Notifications work in the app.', silent: true });
        note.close();
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    })()`);

    if (shown && shown.ok) pass('a notification can actually be shown');
    else fail('showing a notification threw', shown && shown.message);

    /* ---- 7. the public link ------------------------------------------ */

    heading('The public link');

    const readLink = () =>
      client
        .evaluate(
          `fetch('/api/state').then((r) => r.json()).then((s) => ({ publicUrl: s.server.publicUrl || '', expired: !!s.server.publicUrlExpired }))`
        )
        .catch((err) => ({ publicUrl: '', expired: false, error: err.message }));

    // A fresh cloudflared takes a while to get an address - it has to reach
    // Cloudflare, be given one, and write it - so give it longer than any one
    // stage would ever need rather than reporting whichever answer was there at
    // three seconds. Reporting "no link" because the check was impatient would
    // be a false alarm about a feature that works.
    const linkWaitStart = Date.now();
    let link = await readLink();
    for (let attempt = 0; attempt < 90 && !/^https:\/\//.test(link.publicUrl); attempt += 1) {
      await sleep(1000);
      link = await readLink();
    }
    const linkWait = Math.round((Date.now() - linkWaitStart) / 1000);

    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(link.publicUrl)) {
      const stored = readStoredLink();
      const ageMs = stored ? Date.now() - Number(stored.publicUrlAt) : Infinity;

      // An address left over from an earlier run answers perfectly well while its
      // cloudflared is still alive, which would make this check pass while testing
      // a tunnel that has nothing to do with the app that just started.
      const fromThisRun = stored && Number(stored.publicUrlAt) >= startedAt - 2000;

      if (stored && stored.publicUrl === link.publicUrl && fromThisRun) {
        pass(`the app opened a public link by itself after ${linkWait}s: ${link.publicUrl}`);
        pass("it is this launch's link, not a leftover from an earlier run");

        // A real GET, because that is what a friend's phone does: the link has
        // to come back with the interface itself, not just any response. Cloudflare
        // hands out the address a moment before it starts routing it, so the first
        // attempt can legitimately fail - retrying is what tells a slow tunnel
        // apart from a broken one.
        let answers = { status: 'not tried', body: '' };

        for (let attempt = 0; attempt < 22; attempt += 1) {
          answers = await fetch(`${link.publicUrl}/`).then(
            async (response) => ({ status: response.status, body: (await response.text()).slice(0, 400) }),
            (err) => ({
              // The cause is the part that says why: a name that does not resolve
              // and a connection that is refused look identical without it.
              status: `no answer (${err.message}${err.cause && err.cause.code ? `: ${err.cause.code}` : ''})`,
              body: '',
            })
          );

          if (answers.status === 200 && /<title>AirChat/i.test(answers.body)) break;
          await sleep(4000);
        }

        if (answers.status === 200 && /<title>AirChat/i.test(answers.body)) {
          pass('it answers from the internet with the interface (HTTP 200)');
        } else {
          fail('the public link did not serve the interface', `status: ${answers.status}`);
        }
      } else {
        fail(
          'the link the app is showing did not come from this launch',
          stored
            ? `shown: ${link.publicUrl} | on disk: ${stored.publicUrl} | age: ${Math.round(ageMs / 1000)}s`
            : 'no config.json found to compare against'
        );
      }
    } else if (link.expired) {
      warn('a previous public link has expired; a new one would be opened next launch');
    } else {
      // The app says why it could not open one ("not installed", "Cloudflare is
      // busy"), so that reason is repeated rather than guessed at.
      const said = (appLog.match(/\[airchat\] no public link: (.+)/) || [])[1];
      warn(said ? `no public link: ${said.trim()}` : 'no public link - AirChat stays on this Wi-Fi');
    }
    /* ---- 8. opening it again ------------------------------------------ */

    heading('Opening it again');

    // The first thing anyone does when an app seems not to have opened is click
    // it again. That used to quit the second copy on the spot - and if the copy
    // holding the single-instance lock had no window to show, the double-click
    // did nothing at all. From the outside both are "AirChat closes itself".
    // Now the second copy opens a window onto the server that is already there.
    if (ATTACH) {
      warn('not tried: this check is attached to a copy that was already open');
    } else {
      const secondPort = DEBUG_PORT + 1;
      const modulePath = require('electron');
      const secondExe = typeof modulePath === 'string' ? modulePath : modulePath.default;

      const second = spawn(secondExe, [ROOT, `--remote-debugging-port=${secondPort}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: ROOT,
      });

      try {
        const secondWindow = await attachToApp(20000, secondPort);

        if (!secondWindow) {
          fail('opening AirChat a second time showed no window', 'the second copy exited without one');
        } else {
          try {
            const where = await secondWindow.client.evaluate('location.href');
            const isApp = await secondWindow.client.evaluate(
              '!!(window.airchatApp && window.airchatApp.isApp)'
            );

            pass('a second launch opens a window instead of closing');

            if (isApp) pass('that window is a real AirChat window, not a blank page');
            else fail('the second window loaded something that is not AirChat', where);

            // The port proves it is the running server it attached to, rather
            // than a second server of its own with a second copy of the chats.
            const where_port = (() => {
              try {
                return new URL(where).port || '80';
              } catch (err) {
                return '';
              }
            })();

            if (where_port === String(appPort())) {
              pass(`it opens the copy that is already running (port ${where_port})`);
            } else {
              warn(`it opened port ${where_port}, while the running copy is on ${appPort()}`);
            }
          } finally {
            secondWindow.client.close();
          }

          const stillThere = await client.evaluate('1 + 1').catch(() => null);
          if (stillThere === 2) pass('the copy that was already open is still running');
          else fail('the first copy went away when the second one opened');
        }
      } finally {
        try {
          second.kill();
        } catch (err) {
          // Already gone.
        }
      }
    }
  } finally {
    client.close();
  }

  heading('Result');

  if (failures === 0) {
    const suffix = warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : '';
    console.log(`  the app does everything the website did${suffix}`);
  } else {
    console.log(`  ${failures} problem${failures === 1 ? '' : 's'} found. Fix the \u2717 items above.`);
  }

  if (!KEEP_OPEN) {
    stopApp();
    // Give the window a moment to close before the shell returns.
    await sleep(600);
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nThe app check itself crashed: ${err.stack || err.message}`);
  process.exit(1);
});
