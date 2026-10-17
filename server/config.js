'use strict';

/**
 * Configuration loading.
 *
 * Precedence, lowest to highest:
 *   1. built-in defaults (below)
 *   2. config.json in the AirChat folder
 *   3. environment variables
 *
 * On first run AirChat writes a config.json so there is something obvious to
 * edit, and generates a share token that gets baked into friend invite links.
 *
 * Where that file lives depends on how AirChat was started. Run from a checkout,
 * it sits next to the code, which is what you want when the code is yours to
 * edit. Run as an installed app, the code lives somewhere the operating system
 * owns and replaces on every update - writing messages there would lose them on
 * the next update, so the desktop app points `AIRCHAT_HOME` at its own data
 * folder instead and everything user-owned goes there:
 *
 *   AIRCHAT_HOME/config.json       your settings and any channel passwords
 *   AIRCHAT_HOME/data/airchat.json your messages
 *
 * Only those two are moved. ROOT still means "the code", so the interface and
 * the tools are read from wherever the app was installed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

/**
 * Where the user's own files go: the folder the code lives in, unless the
 * desktop app (or anyone else) has said otherwise.
 */
const HOME = process.env.AIRCHAT_HOME
  ? path.resolve(process.env.AIRCHAT_HOME)
  : ROOT;

const CONFIG_PATH = path.join(HOME, 'config.json');
const DATA_DIR = path.join(HOME, 'data');
const DB_PATH = path.join(DATA_DIR, 'airchat.json');

/**
 * How old the last proof of life on a public link may be before it is dead.
 *
 * A free Cloudflare Quick Tunnel address is random per run and stops existing
 * the moment the process behind it does. tools/tunnel.js writes the address
 * with `publicUrlAt` (refreshed every 20 seconds while it runs) and clears it on
 * the way out; this is the backstop for when it was killed outright. A link
 * past this age would answer a friend with "server IP address could not be
 * found", so AirChat stops offering it and says why instead.
 *
 * A `publicUrl` typed in by hand has no stamp and is always trusted.
 */
const PUBLIC_URL_MAX_AGE_MS = 3 * 60 * 1000;

const DEFAULTS = {
  port: 4000,
  host: '0.0.0.0',
  openOnStart: true,
  /** Set this once you have a tunnel, e.g. "https://chat.example.com". */
  publicUrl: '',
  /** Empty means "generate one on first run". */
  token: '',
  me: { id: 'me', name: 'You', initials: 'Y', color: '#7C5CFF' },
  channels: {
    imessage: { adapter: 'mock' },
    sms: { adapter: 'mock' },
    telegram: { adapter: 'off' },
  },
  bluebubbles: { serverUrl: '', password: '' },
  twilio: { accountSid: '', authToken: '', fromNumber: '' },
  telegram: { botToken: '' },
  mock: { autoReply: true, latencyMs: 1200 },
  /**
   * Where friend codes live.
   *
   * A six-character code cannot carry an address, so a small directory turns it
   * back into "where is that app right now". Point this at your own deployment of
   * directory/ if you would rather run it yourself; the app works without it and
   * simply says codes are unavailable.
   */
  friendCodes: {
    directory: 'https://site-7f015d99cb0e43f98814f3a7512c55bb.freebuff.page',
    minutes: 720,
  },
  /** Shown in the UI; the real name is a TODO for you to fill in later. */
  appName: 'AirChat',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Merge `override` onto `base`, skipping keys that start with "_" (comments). */
function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (key.startsWith('_')) continue;
    if (value === undefined || value === null) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `config.json is not valid JSON (${err.message}).\n` +
        `Fix or delete ${CONFIG_PATH} and start AirChat again.`
    );
  }
}

function envOverrides() {
  const out = {};
  const pick = (name) => {
    const value = process.env[name];
    return value === undefined || value === '' ? undefined : value;
  };

  const port = pick('PORT') || pick('AIRCHAT_PORT');
  if (port) out.port = Number(port);

  const token = pick('AIRCHAT_TOKEN');
  if (token) out.token = token;

  const publicUrl = pick('AIRCHAT_PUBLIC_URL');
  if (publicUrl) out.publicUrl = publicUrl.replace(/\/+$/, '');

  if (pick('BLUEBUBBLES_URL') || pick('BLUEBUBBLES_PASSWORD')) {
    out.bluebubbles = {
      serverUrl: pick('BLUEBUBBLES_URL') || '',
      password: pick('BLUEBUBBLES_PASSWORD') || '',
    };
  }

  if (pick('TWILIO_ACCOUNT_SID') || pick('TWILIO_AUTH_TOKEN') || pick('TWILIO_FROM_NUMBER')) {
    out.twilio = {
      accountSid: pick('TWILIO_ACCOUNT_SID') || '',
      authToken: pick('TWILIO_AUTH_TOKEN') || '',
      fromNumber: pick('TWILIO_FROM_NUMBER') || '',
    };
  }

  if (pick('TELEGRAM_BOT_TOKEN')) {
    out.telegram = { botToken: pick('TELEGRAM_BOT_TOKEN') };
  }

  // Point friend codes at your own directory, or at a stub during a test.
  const codesUrl = pick('AIRCHAT_CODES_URL');
  if (codesUrl) out.friendCodes = { directory: codesUrl.replace(/\/+$/, '') };

  return out;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * True when a public link's proof-of-life stamp is too old to trust.
 *
 * One rule, used by the startup check and by the running server: two copies of
 * it would eventually disagree about when a link is dead, and the version that
 * guessed "alive" is the one that sends a friend to a DNS error.
 *
 * A missing stamp (0, or not a number) is not judged here - a link typed in by
 * hand has none, and index.js checks it by asking instead.
 */
function isPublicUrlStale(stamp, now) {
  const at = Number(stamp);
  if (!Number.isFinite(at) || at <= 0) return false;
  return (now || Date.now()) - at > PUBLIC_URL_MAX_AGE_MS;
}

/** Write a readable config.json so the user has a file to edit. */
function persistConfig(config) {
  const serialisable = {
    _comment:
      "AirChat's settings. Delete this file to go back to defaults. Restart the server after editing.",
    port: config.port,
    openOnStart: config.openOnStart,
    publicUrl: config.publicUrl,
    publicUrlAt: config.publicUrlAt || 0,
    me: config.me,
    token: config.token,
    _channels_comment:
      "adapter: 'mock' fakes delivery so you can try things free, 'off' disables the channel, 'bluebubbles'/'twilio'/'telegram' are real.",
    channels: config.channels,
    bluebubbles: config.bluebubbles,
    twilio: config.twilio,
    telegram: config.telegram,
    mock: config.mock,
  };

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(serialisable, null, 2)}\n`, 'utf8');
}

function loadConfig() {
  const fileConfig = readConfigFile();
  const merged = deepMerge(DEFAULTS, fileConfig);
  const config = deepMerge(merged, envOverrides());

  const existed = fs.existsSync(CONFIG_PATH);
  if (!config.token) {
    config.token = newToken();
  }

  // A stored public link that the tunnel stopped refreshing is an address that
  // no longer resolves. Drop it here, once, so no invite can be built on it.
  config.publicUrlExpired = false;
  const savedUrl = fileConfig && fileConfig.publicUrl;
  const stamp = Number(fileConfig && fileConfig.publicUrlAt);

  if (config.publicUrl && savedUrl === config.publicUrl && isPublicUrlStale(stamp)) {
    config.publicUrlExpired = true;
    config.publicUrl = '';
  }

  // A link with no stamp at all was stored before AirChat kept one, or typed in
  // by hand. It cannot be trusted on its word, so the server asks it once at
  // startup and drops it if nothing answers (see probePublicUrl in index.js).
  config.publicUrlUnverified = Boolean(
    config.publicUrl && !(Number.isFinite(stamp) && stamp > 0)
  );

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Only touch the user's file when we created it or had to mint a token.
  if (!existed || !(fileConfig && fileConfig.token)) persistConfig(config);

  return config;
}

module.exports = {
  loadConfig,
  deepMerge,
  isPublicUrlStale,
  PUBLIC_URL_MAX_AGE_MS,
  ROOT,
  HOME,
  CONFIG_PATH,
  DATA_DIR,
  DB_PATH,
  DEFAULTS,
};
