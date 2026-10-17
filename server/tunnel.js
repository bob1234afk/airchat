'use strict';

/**
 * The free public link, as a module instead of a script.
 *
 * A friend opening an invite link is the whole point of AirChat, and that only
 * works when AirChat has a public https address. Cloudflare's Quick Tunnels give
 * one away with no account and no domain, which is why they are the default.
 *
 * This used to live inside tools/tunnel.js, which also starts the server - fine
 * from a terminal, useless from the desktop app, which already has a server and
 * just needs the address. Both now share this file, so there is one description
 * of what a live public link is:
 *
 *   - it exists only while the cloudflared process does
 *   - config.json records it with the time it was last known good (`publicUrlAt`)
 *   - that stamp is refreshed every 20 seconds, because server/config.js refuses
 *     to hand out a link older than PUBLIC_URL_MAX_AGE_MS
 *   - it is cleared on the way out, so nothing can hand a friend an address that
 *     no longer resolves
 *
 * The class never throws at you: `start()` resolves with either a URL or a
 * reason, because "no public link" is a normal state (no cloudflared installed)
 * and not an error the whole app should die of.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { CONFIG_PATH } = require('./config');

/** Comfortably shorter than the staleness window in server/config.js. */
const HEARTBEAT_MS = 20000;

/** A Quick Tunnel address: random label, fixed domain, always https. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Prefer a cloudflared dropped next to the project.
 *
 * Installing the tunnel should be "download one file" for anyone who would
 * rather not use a package manager, so a cloudflared in the AirChat folder wins
 * over whatever happens to be on PATH.
 */
function findCloudflared(root) {
  const local = path.join(root, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  return 'cloudflared';
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Record - or, with an empty base, clear - the public link in config.json.
 *
 * The file is re-read before writing rather than saving a snapshot from startup,
 * so a token the server minted meanwhile, or an edit made while running, is not
 * overwritten.
 */
function writePublicUrl(configPath, base) {
  const current = readJson(configPath) || {};
  const next = Object.assign({}, current, {
    publicUrl: base,
    publicUrlAt: base ? Date.now() : 0,
  });

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

class Tunnel extends EventEmitter {
  constructor(options) {
    super();

    const opts = options || {};

    this.root = opts.root || path.join(__dirname, '..');
    this.port = Number(opts.port) || 4000;
    this.configPath = opts.configPath || CONFIG_PATH;
    this.heartbeatMs = Number(opts.heartbeatMs) || HEARTBEAT_MS;
    this.autoUpdate = opts.autoUpdate !== false;

    // Overridable so the doctor can test this file without cloudflared, the
    // same way it tests the encryption with real messages.
    this.binary = opts.binary || findCloudflared(this.root);
    this.args = opts.args || null;

    this.child = null;
    this.liveUrl = null;
    this.stopping = false;
    this.output = '';
    this.heartbeat = null;
  }

  /** The address currently advertised, or '' when there is none. */
  get url() {
    return this.liveUrl || '';
  }

  get running() {
    return Boolean(this.child && !this.child.killed);
  }

  /**
   * Open the link.
   *
   * Resolves with `{ ok: true, url }` once cloudflared has printed an address, or
   * `{ ok: false, detail }` when it cannot - no cloudflared installed, nothing
   * printed, or it exited first. It never rejects and it never leaves the app
   * waiting: a missing tunnel must not stop AirChat from running.
   */
  start() {
    if (this.running) return Promise.resolve({ ok: true, url: this.liveUrl });

    this.stopping = false;
    this.output = '';

    const args = this.args || [
      'tunnel',
      '--url',
      `http://localhost:${this.port}`,
      ...(this.autoUpdate ? ['--no-autoupdate'] : []),
    ];

    return new Promise((resolve) => {
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        this.child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ ok: false, detail: err.message });
        return;
      }

      const onOutput = (chunk) => {
        const text = chunk.toString();
        this.output += text;
        this.emit('log', text);

        if (this.liveUrl) return;

        const match = this.output.match(URL_PATTERN);
        if (!match) return;

        const url = match[0].replace(/\/+$/, '');
        this.liveUrl = url;

        try {
          writePublicUrl(this.configPath, url);
        } catch (err) {
          // The link works even if it could not be recorded; the app falls back
          // to a Wi-Fi-only link, and the reason is reported rather than hidden.
          this.emit('log', `could not save the public link: ${err.message}\n`);
          finish({ ok: false, detail: `the link could not be saved: ${err.message}` });
          return;
        }

        this.startHeartbeat();
        this.emit('url', url);
        finish({ ok: true, url });
      };

      this.child.stdout.on('data', onOutput);
      this.child.stderr.on('data', onOutput);

      this.child.on('error', (err) => {
        finish({
          ok: false,
          detail:
            err.code === 'ENOENT'
              ? 'cloudflared is not installed, so AirChat stays on your Wi-Fi only.'
              : err.message,
        });
      });

      this.child.on('exit', (code) => {
        const wasLive = Boolean(this.liveUrl);
        this.child = null;
        this.liveUrl = null;
        this.stopHeartbeat();

        // The exit code alone says nothing useful ("exit 1" is everything from
        // "no internet" to "Cloudflare is busy, try again in a minute"). The last
        // thing cloudflared said is what a person can act on, so it goes in the
        // message instead of being buried in the log.
        const said = this.output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .pop();

        const reason = said ? ` - ${said.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '')}` : '';
        finish({ ok: false, detail: `cloudflared stopped (exit ${code})${reason}` });
        this.emit('exit', code, wasLive);
      });
    });
  }

  startHeartbeat() {
    if (this.heartbeat) return;

    this.heartbeat = setInterval(() => {
      if (!this.liveUrl) return;
      try {
        writePublicUrl(this.configPath, this.liveUrl);
      } catch (err) {
        this.emit('log', `could not refresh the public link stamp: ${err.message}\n`);
      }
    }, this.heartbeatMs);

    // A timer must never be the reason a process refuses to exit.
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Stop the tunnel and withdraw the address.
   *
   * Clearing config.json matters as much as killing the process: the saved
   * address outlives both, and a saved address that no longer resolves is
   * exactly the "my friend says the link does not work" failure.
   */
  stop() {
    this.stopping = true;
    this.stopHeartbeat();

    const hadUrl = Boolean(this.liveUrl);
    this.liveUrl = null;

    if (this.child) {
      try {
        this.child.kill();
      } catch (err) {
        // Already gone; there is nothing to clean up.
      }
      this.child = null;
    }

    if (hadUrl) {
      try {
        writePublicUrl(this.configPath, '');
        this.emit('cleared');
      } catch (err) {
        this.emit('log', `could not clear the public link: ${err.message}\n`);
      }
    }
  }
}

module.exports = {
  Tunnel,
  findCloudflared,
  writePublicUrl,
  readJson,
  URL_PATTERN,
  HEARTBEAT_MS,
};
