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
const https = require('https');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');

const { CONFIG_PATH } = require('./config');
const linkStatus = require('./link-status');

/** Comfortably shorter than the staleness window in server/config.js. */
const HEARTBEAT_MS = 20000;

/** A Quick Tunnel address: random label, fixed domain, always https. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** The file name cloudflared has on each platform. */
const BINARY_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

/**
 * Where AirChat keeps a cloudflared it fetched for itself.
 *
 * Next to config.json, which is the app's own data folder when the desktop app
 * runs it and the project folder when the server is started by hand. One rule,
 * so an update that replaces the program cannot take the tunnel with it.
 */
function localBinaryPath() {
  return path.join(path.dirname(CONFIG_PATH), BINARY_NAME);
}

/**
 * Prefer a cloudflared that came with AirChat over one on PATH.
 *
 * Installing the tunnel should be "download one file" for anyone who would
 * rather not use a package manager, so a cloudflared AirChat fetched itself - or
 * one dropped next to the project - wins over whatever happens to be installed.
 */
function findCloudflared(root) {
  for (const candidate of [localBinaryPath(), path.join(root, BINARY_NAME)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return BINARY_NAME;
}

/**
 * Ask a candidate whether it really is cloudflared.
 *
 * A truncated download is a file that exists and does nothing, so existence is
 * not enough. `--version` is the one question every cloudflared build answers
 * without a network connection, and its reply is what makes a fetched binary
 * trustworthy enough to run.
 */
function cloudflaredVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) return '';

    const said = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return /cloudflared version/i.test(said) ? said.split(/\r?\n/)[0].trim() : '';
  } catch (err) {
    return '';
  }
}

/** The official release asset for this machine, or '' when there is none. */
const RELEASE_ASSETS = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-arm64.exe',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
};

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/**
 * Fetch a file, following GitHub's redirect to its download host.
 *
 * GitHub answers a release download with a 302 to another host, so a plain GET
 * would save the redirect page instead of the program. Progress is reported as
 * it arrives because 55 MB with no sign of life looks like a hang.
 */
function download(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'AirChat' } }, (response) => {
      const status = response.statusCode || 0;

      if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).toString(), destination, onProgress, redirects + 1));
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`the download was refused (HTTP ${status})`));
        return;
      }

      const total = Number(response.headers['content-length']) || 0;
      const part = `${destination}.part`;
      const out = fs.createWriteStream(part);

      let received = 0;
      let lastReport = 0;

      response.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();

        if (onProgress && (now - lastReport > 300 || (total && received >= total))) {
          lastReport = now;
          onProgress({ received, total });
        }
      });

      response.on('error', reject);
      out.on('error', reject);

      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(part, destination);
            resolve(destination);
          } catch (err) {
            reject(err);
          }
        });
      });

      response.pipe(out);
    });

    request.on('error', reject);
    request.setTimeout(60000, () => request.destroy(new Error('the download timed out')));
  });
}

/**
 * Get a working cloudflared onto this machine, once.
 *
 * "AirChat works when you open it" cannot depend on somebody having read a
 * README and installed a tunnel first. So if there is no cloudflared anywhere,
 * AirChat downloads the official one - the same file the install page links to -
 * into its own folder and checks that it runs. It happens once, it is logged, and
 * the interface says it is happening.
 *
 * Resolves with `{ ok, binary }` or `{ ok: false, detail }`. It never throws: no
 * internet only means no public link today, not a broken app.
 */
async function provisionCloudflared(options) {
  const opts = options || {};
  const destination = opts.destination || localBinaryPath();
  const onProgress = opts.onProgress || null;

  if (fs.existsSync(destination)) {
    if (cloudflaredVersion(destination)) return { ok: true, binary: destination };

    // Half a download from a run that was interrupted. Replacing it is the only
    // useful thing to do with it.
    try {
      fs.unlinkSync(destination);
    } catch (err) {
      return { ok: false, detail: `the old cloudflared could not be replaced (${err.message})` };
    }
  }

  const asset = RELEASE_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) {
    return {
      ok: false,
      detail: `AirChat does not know where to get cloudflared for ${process.platform} ${process.arch}`,
    };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const archive = `${destination}.download`;

  try {
    await download(`${RELEASE_BASE}${asset}`, archive, onProgress);

    if (asset.endsWith('.tgz')) {
      // macOS ships its release as a tarball; `tar` is part of both macOS and
      // every Linux AirChat runs on.
      const extracted = spawnSync('tar', ['-xzf', archive, '-C', path.dirname(destination)], {
        encoding: 'utf8',
        timeout: 60000,
      });

      if (extracted.error || extracted.status !== 0) {
        throw new Error(`the download could not be unpacked (${extracted.error ? extracted.error.message : extracted.stderr})`);
      }
    } else {
      fs.renameSync(archive, destination);
    }

    try {
      fs.unlinkSync(archive);
    } catch (err) {
      // Already gone, or it was renamed into place.
    }

    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);

    const version = cloudflaredVersion(destination);
    if (!version) throw new Error('the downloaded file did not run as cloudflared');

    return { ok: true, binary: destination, version };
  } catch (err) {
    try {
      fs.unlinkSync(archive);
    } catch (ignored) {
      // Nothing to clean up.
    }

    return { ok: false, detail: err.message };
  }
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
    this.explicitBinary = Boolean(opts.binary);
    this.binary = opts.binary || findCloudflared(this.root);
    this.args = opts.args || null;

    // Fetching a cloudflared is allowed unless the caller says otherwise (a test
    // that is about the tunnel, not about the download, turns it off).
    this.provision = opts.provision !== false;
    this.provisionTried = false;
    this.provisionError = '';

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
  /**
   * Find - or fetch - a cloudflared to run.
   *
   * Runs at most one download per process: an app that re-downloaded 55 MB on
   * every retry would look busy while making whatever failed worse.
   */
  async ensureBinary() {
    if (this.explicitBinary) return;

    const found = findCloudflared(this.root);

    if (found !== BINARY_NAME) {
      if (cloudflaredVersion(found)) {
        this.binary = found;
        return;
      }

      // A file where a working one should be, and it is not one. Replacing it is
      // the only useful thing to do with it.
      await this.fetch(found);
      return;
    }

    if (cloudflaredVersion(BINARY_NAME)) {
      this.binary = BINARY_NAME;
      return;
    }

    await this.fetch(localBinaryPath());
  }

  async fetch(destination) {
    if (!this.provision || this.provisionTried) return;
    this.provisionTried = true;

    this.emit('provision', { phase: 'start' });

    const fetched = await provisionCloudflared({
      destination,
      onProgress: (progress) => this.emit('provision', Object.assign({ phase: 'progress' }, progress)),
    });

    if (fetched.ok) {
      this.binary = fetched.binary;
      this.emit('provision', { phase: 'done', version: fetched.version || '' });
      return;
    }

    this.provisionError = fetched.detail;
    this.emit('provision', { phase: 'failed', detail: fetched.detail });
  }

  async start() {
    if (this.running) return Promise.resolve({ ok: true, url: this.liveUrl });

    this.stopping = false;
    this.output = '';

    await this.ensureBinary();

    linkStatus.set({ state: linkStatus.STATE.STARTING });

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
        linkStatus.set({ state: linkStatus.STATE.READY, url });
        finish({ ok: true, url });
      };

      this.child.stdout.on('data', onOutput);
      this.child.stderr.on('data', onOutput);

      this.child.on('error', (err) => {
        const missing = err.code === 'ENOENT';

        // Three different truths, said difference: nothing was ever installed,
        // nothing is installed and the download failed (with the reason), and
        // nothing is installed and nothing was even tried.
        const detail = missing
          ? this.provision === false
            ? 'cloudflared is not installed'
            : this.provisionError
              ? `cloudflared is not installed (${this.provisionError})`
              : 'cloudflared is not installed, and AirChat could not download it'
          : err.message;

        // Missing is the one failure retrying cannot fix within this run, so it is
        // reported as such rather than as "trying again" for ever.
        linkStatus.set({ state: missing ? linkStatus.STATE.UNAVAILABLE : linkStatus.STATE.RETRYING, detail: `${detail}.` });
        finish({ ok: false, detail: `${detail}, so AirChat stays on your Wi-Fi only.`, permanent: missing });
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
        const detail = `the public link stopped (exit ${code})${reason}`;

        linkStatus.set({ state: linkStatus.STATE.RETRYING, detail });
        finish({ ok: false, detail });

        // While stopping, the exit is the plan rather than a failure: the caller
        // must not see a "link dropped" it has to react to.
        if (!this.stopping) this.emit('exit', code, wasLive);
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

    // A closed link is not a dropped one: nothing should try to reopen it.
    linkStatus.set({ state: linkStatus.STATE.IDLE });
  }
}

module.exports = {
  Tunnel,
  findCloudflared,
  provisionCloudflared,
  cloudflaredVersion,
  localBinaryPath,
  writePublicUrl,
  readJson,
  URL_PATTERN,
  HEARTBEAT_MS,
  BINARY_NAME,
};
