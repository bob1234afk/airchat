'use strict';

/**
 * AirChat's server.
 *
 * Everything AirChat does runs from this one process, on your own machine:
 *
 *   - serves the chat UI (ui/)
 *   - keeps the message store on disk (data/airchat.json)
 *   - pushes realtime updates to every connected browser over WebSocket
 *   - routes outbound messages to iMessage / SMS / Telegram through adapters
 *   - accepts inbound messages from those networks via webhooks or polling
 *
 * It has no npm dependencies, so `node server/index.js` is all it takes.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const { loadConfig, isPublicUrlStale, ROOT, CONFIG_PATH, DB_PATH } = require('./config');
const { Store, publicContact, MIRRORS } = require('./store');
const {
  createAdapters,
  MIRROR_CHANNELS,
  parseBlueBubblesWebhook,
  parseTwilioWebhook,
} = require('./adapters');
const { Router } = require('./router');
const ws = require('./ws');
const icons = require('./icons');

const UI_DIR = path.join(ROOT, 'ui');
const STATIC_PREFIX = UI_DIR + path.sep;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_STORED_MESSAGES = 300;

if (typeof fetch !== 'function') {
  console.error(
    '\nAirChat needs Node.js 18 or newer (this build found no global fetch).\n' +
      'Install the current LTS from https://nodejs.org and start AirChat again.\n'
  );
  process.exit(1);
}

const config = loadConfig();
const store = new Store(DB_PATH);
store.load(config.me);

/* ------------------------------------------------------------------ *
 * Realtime hub
 * ------------------------------------------------------------------ */

/** Every open WebSocket, owner or guest. */
const clients = new Set();

/** Which conversation an outgoing event belongs to. */
function eventConversationId(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.conversationId) return event.conversationId;
  if (event.message && event.message.conversationId) return event.message.conversationId;
  if (event.conversation && event.conversation.id) return event.conversation.id;
  return null;
}

/**
 * Owners see everything. A guest invite is scoped to exactly one thread, so a
 * guest must never be handed events from anyone else's conversations.
 */
function mayReceive(conn, event) {
  const identity = conn.identity;
  if (!identity || identity.role === 'owner') return true;
  if (event.type === 'reload' || event.type === 'bridge') return true;
  return eventConversationId(event) === identity.guest.conversationId;
}

const bus = {
  publish(event, options) {
    const opts = options || {};
    const payload = JSON.stringify(event);

    for (const conn of clients) {
      if (conn.closed || conn === opts.except) continue;
      if (!mayReceive(conn, event)) continue;

      try {
        conn.sendRaw(payload);
      } catch (err) {
        console.error('[bus] could not reach a connected client:', err.message);
      }
    }
  },
};

/* ------------------------------------------------------------------ *
 * Adapters and router
 * ------------------------------------------------------------------ */

let router = null;

const hooks = {
  status(conversationId, messageId, status) {
    store.setMessageStatus(conversationId, messageId, status);
    bus.publish({ type: 'status', conversationId, messageId, status });
  },
  inbound(payload) {
    if (router) router.receiveInbound(payload);
  },
  log(message) {
    console.log(message);
  },
};

const adapters = createAdapters({ config, hooks });
router = new Router({ store, config, adapters, bus });

/* ------------------------------------------------------------------ *
 * Small HTTP helpers
 * ------------------------------------------------------------------ */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('That request was too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('That request body was not valid JSON.');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The app icons are drawn on demand rather than committed as binaries, so they
 * always match the brand colours in the stylesheet. Safe to serve to anyone:
 * there is nothing private in a logo.
 */
function sendIcon(res, size) {
  if (!Number.isFinite(size) || size < 16 || size > icons.MAX_SIZE) {
    sendText(res, 404, 'Not found');
    return;
  }

  let png;
  try {
    png = icons.icon(size);
  } catch (err) {
    console.error('[airchat] could not render the app icon:', err.message);
    sendText(res, 500, 'Could not render that icon.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(png);
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, relativePath, cookies) {
  const target = path.join(UI_DIR, relativePath);

  // Refuse anything that escapes ui/, e.g. "../config.json".
  if (target !== UI_DIR && !target.startsWith(STATIC_PREFIX)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const type = STATIC_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    };
    // Node accepts an array here, so several invites can be remembered at once.
    if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * Who is asking?
 * ------------------------------------------------------------------ */

/**
 * Headers a tunnel (cloudflared, ngrok, ...) stamps onto requests on their way
 * to us. A tunnel runs *on this machine*, so its requests arrive from 127.0.0.1.
 */
const FORWARDED_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
];

/** Host names that can only mean "this computer". */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** The hostname part of the Host header, without the port or IPv6 brackets. */
function hostHeaderName(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(':')[0];
}

/**
 * True only for a direct connection from this computer.
 *
 * The address alone is not enough. A Cloudflare Quick Tunnel - the free public
 * link AirChat hands to friends - connects to us from 127.0.0.1, so trusting
 * the address would treat every visitor on the internet as the owner and drop
 * the per-chat scoping an invite link is supposed to enforce.
 *
 * Two independent signals say "this came from outside even though the socket is
 * local", so either one is enough to deny the free pass: a tunnel adds
 * forwarding headers, and it presents the public hostname rather than localhost.
 * A request that looks proxied must present the owner token or a guest invite,
 * exactly like any other remote visitor.
 */
function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  const local =
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.');
  if (!local) return false;

  for (const header of FORWARDED_HEADERS) {
    if (req.headers[header]) return false;
  }

  const host = hostHeaderName(req);
  if (host && !LOCAL_HOSTNAMES.includes(host)) return false;

  return true;
}

const OWNER_COOKIE = 'airchat_token';
const GUEST_COOKIE = 'airchat_guest';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Read one cookie without pulling in a dependency. */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return '';
}

/** Did this request arrive over https (through a tunnel), so cookies can be Secure? */
function requestIsHttps(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https' || Boolean(req.socket.encrypted);
}

/**
 * Cookies that remember an invite link.
 *
 * The link is opened once, but an app added to the Dock or a home screen reopens
 * at "/" with no query string at all. Safari copies cookies into such a web app
 * while it does *not* share localStorage with the browser (WebKit bug 181849),
 * so a cookie is what keeps a friend signed in after they install it.
 */
function authCookies(req, url) {
  const cookies = [];
  const secure = requestIsHttps(req) ? '; Secure' : '';

  const token = url.searchParams.get('token');
  if (token && config.token && token === config.token) {
    cookies.push(
      `${OWNER_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`
    );
  }

  const guestToken = url.searchParams.get('guest');
  if (guestToken && store.findGuest(guestToken)) {
    cookies.push(
      `${GUEST_COOKIE}=${encodeURIComponent(guestToken)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`
    );
  }

  return cookies;
}

/**
 * Who is asking?
 *
 * On this PC you are always the owner. From anywhere else you need either the
 * owner token or a guest invite link for one specific thread - presented either
 * in the URL (the link itself) or already remembered in a cookie from when the
 * link was first opened.
 */
function resolveIdentity(req, url) {
  if (isLoopback(req)) return { role: 'owner' };

  // An invite in the URL is explicit, so it wins over anything remembered from
  // an earlier visit. Otherwise opening a guest link on a machine that had also
  // opened the owner's full-access link would silently open as the owner -
  // handing the "one chat only" link the whole app.
  const urlToken = url.searchParams.get('token');
  if (urlToken && config.token && urlToken === config.token) return { role: 'owner' };

  const urlGuest = url.searchParams.get('guest');
  if (urlGuest) {
    const guest = store.findGuest(urlGuest);
    if (guest) return { role: 'guest', guest };
  }

  const cookieToken = readCookie(req, OWNER_COOKIE);
  if (config.token && cookieToken && cookieToken === config.token) return { role: 'owner' };

  const cookieGuest = readCookie(req, GUEST_COOKIE);
  if (cookieGuest) {
    const guest = store.findGuest(cookieGuest);
    if (guest) return { role: 'guest', guest };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Addresses and state
 * ------------------------------------------------------------------ */

function lanAddress() {
  const candidates = [];
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      const family = typeof info.family === 'string' ? info.family : String(info.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (info.internal) continue;
      candidates.push(info.address);
    }
  }

  // Ordinary home/office networks first, so a VPN adapter does not win.
  const preferred =
    candidates.find((address) => /^192\.168\./.test(address)) ||
    candidates.find((address) => /^10\./.test(address)) ||
    candidates.find((address) => /^(172\.(1[6-9]|2\d|3[01]))\./.test(address));

  return preferred || candidates[0] || '127.0.0.1';
}

function serverInfo(includeToken) {
  const base = (config.publicUrl || `http://${lanAddress()}:${config.port}`).replace(/\/+$/, '');
  return {
    name: 'AirChat',
    version: require('../package.json').version,
    port: config.port,
    localUrl: `http://localhost:${config.port}`,
    lanUrl: `http://${lanAddress()}:${config.port}`,
    publicUrl: config.publicUrl || '',
    // True when a saved link outlived its tunnel. The UI says so plainly rather
    // than printing an address that no longer resolves.
    publicUrlExpired: Boolean(config.publicUrlExpired),
    inviteUrl: `${base}/?token=${config.token}`,
    token: includeToken ? config.token : '',
    platform: process.platform,
    node: process.version,
  };
}

function fullState() {
  return Object.assign({ view: 'owner' }, store.snapshot(), {
    bridges: router.bridgeStatus(),
    server: serverInfo(true),
  });
}

function guestState(guest) {
  const conversation = store.getConversation(guest.conversationId);
  if (!conversation) return null;

  const contact = store.contacts.find((c) => conversation.participantIds.includes(c.id)) || null;
  const messages = {};
  messages[conversation.id] = store.messagesFor(conversation.id).slice(-MAX_STORED_MESSAGES);

  return {
    view: 'guest',
    // A guest sits on the other side of the thread, so their own messages flip.
    flip: true,
    guest: { name: guest.name, conversationId: guest.conversationId },
    peer: {
      id: store.me.id,
      name: store.me.name,
      initials: store.me.initials,
      color: store.me.color,
      handles: [],
    },
    me: contact
      ? publicContact(contact)
      : { id: 'guest', name: guest.name, initials: '?', color: '#7C5CFF', handles: [] },
    contacts: contact ? [publicContact(contact)] : [],
    conversations: [store.conversationSummary(conversation.id)].filter(Boolean),
    messages,
    bridges: router.bridgeStatus(),
    server: serverInfo(false),
  };
}

function inviteLinks(conversationId) {
  const guest = store.createGuestToken(conversationId);
  const base = (config.publicUrl || `http://${lanAddress()}:${config.port}`).replace(/\/+$/, '');
  return {
    guestToken: guest.token,
    guestUrl: `${base}/?guest=${guest.token}`,
    localGuestUrl: `http://localhost:${config.port}/?guest=${guest.token}`,
  };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/** Third-party senders must be able to reach webhooks without our token. */
async function handleWebhook(req, res, pathname, method) {
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'Webhooks only accept POST.' });
    return;
  }

  const raw = await readBody(req, MAX_BODY_BYTES);

  if (pathname === '/api/webhooks/bluebubbles') {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      // Some BlueBubbles installs post a bare message object with no envelope.
      payload = null;
    }

    if (!payload) {
      sendJson(res, 400, { error: 'Expected a JSON webhook body.' });
      return;
    }

    const parsed = parseBlueBubblesWebhook(payload);
    applyInbound(parsed, 'imessage');
    sendJson(res, 200, { received: Boolean(parsed) });
    return;
  }

  if (pathname === '/api/webhooks/twilio') {
    const fields = Object.fromEntries(new URLSearchParams(raw).entries());
    const parsed = parseTwilioWebhook(fields);
    applyInbound(parsed, 'sms');
    // Twilio wants a TwiML document; an empty <Response/> means "say nothing back".
    sendText(res, 200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'text/xml; charset=utf-8');
    return;
  }

  sendJson(res, 404, { error: 'No such webhook.' });
}

function applyInbound(parsed, fallbackChannel) {
  if (!parsed) return;

  if (parsed.kind === 'message') {
    router.receiveInbound({
      address: parsed.address,
      body: parsed.body,
      channel: fallbackChannel,
      externalId: parsed.externalId,
      createdAt: parsed.createdAt,
      name: parsed.name,
    });
    return;
  }

  if (parsed.kind === 'status') {
    router.ingestStatus(parsed);
    return;
  }

  if (parsed.kind === 'typing') {
    router.ingestTyping(parsed);
  }
}

function publishConversation(conversationId) {
  const conversation = store.conversationSummary(conversationId);
  if (conversation) bus.publish({ type: 'conversation', conversation });
}

async function handleApi(req, res, url, method, pathname) {
  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, app: 'AirChat', uptime: Math.round(process.uptime()) });
    return;
  }

  const identity = resolveIdentity(req, url);

  if (!identity) {
    sendJson(res, 401, {
      error:
        'AirChat needs a valid invite link. Ask the owner for the link that ends in ?token=... (or ?guest=... for one chat).',
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/state') {
    if (identity.role === 'guest') {
      const state = guestState(identity.guest);
      if (!state) {
        sendJson(res, 404, { error: 'That chat no longer exists.' });
        return;
      }
      sendJson(res, 200, state);
      return;
    }
    sendJson(res, 200, fullState());
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: `${method} is not supported on ${pathname}.` });
    return;
  }

  const body = await readJson(req);

  // ---- Routes a guest is allowed to use -------------------------------

  if (identity.role === 'guest') {
    if (pathname !== '/api/send') {
      sendJson(res, 403, { error: 'Invite links can only read and reply in their own chat.' });
      return;
    }

    const conversation = store.getConversation(identity.guest.conversationId);
    if (!conversation) {
      sendJson(res, 404, { error: 'That chat no longer exists.' });
      return;
    }

    const contact = store.contacts.find((c) => conversation.participantIds.includes(c.id));
    if (!contact || !contact.handles.length) {
      sendJson(res, 400, { error: 'This chat has nobody attached to it yet.' });
      return;
    }

    const message = router.receiveInbound({
      address: contact.handles[0].address,
      body: body.body,
      channel: 'airchat',
      name: identity.guest.name,
    });

    if (!message) {
      sendJson(res, 400, { error: 'Nothing to send.' });
      return;
    }

    sendJson(res, 200, { message });
    return;
  }

  // ---- Owner-only routes ---------------------------------------------

  switch (pathname) {
    case '/api/send': {
      try {
        const message = router.send({ conversationId: body.conversationId, body: body.body });
        sendJson(res, 200, { message });
      } catch (err) {
        // Everything router.send rejects is something the sender can fix.
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    case '/api/conversations': {
      const address = String(body.address || '').trim();
      const name = String(body.name || '').trim();
      const handleChannel = MIRROR_CHANNELS.includes(body.channel) ? body.channel : 'sms';
      const mirror = MIRRORS.includes(body.mirror) ? body.mirror : 'none';

      let contactId = body.contactId ? String(body.contactId) : null;

      if (!contactId) {
        if (!address) {
          sendJson(res, 400, { error: 'A phone number or email address is required.' });
          return;
        }
        const created = store.addContact({ name, address, channel: handleChannel });
        contactId = created.contact.id;
      }

      let conversation;
      try {
        conversation = store.ensureDirectConversation(contactId, mirror);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }

      publishConversation(conversation.id);
      sendJson(res, 200, { conversation: store.conversationSummary(conversation.id) });
      return;
    }

    case '/api/contacts': {
      const address = String(body.address || '').trim();
      if (!address) {
        sendJson(res, 400, { error: 'A phone number or email address is required.' });
        return;
      }

      const created = store.addContact({
        name: body.name,
        address,
        channel: MIRROR_CHANNELS.includes(body.channel) ? body.channel : 'sms',
      });
      bus.publish({ type: 'reload' });
      sendJson(res, 200, { contact: publicContact(created.contact), created: created.created });
      return;
    }

    case '/api/conversations/mirror': {
      let conversation;
      try {
        conversation = store.setMirror(String(body.conversationId || ''), body.mirror);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }

      if (!conversation) {
        sendJson(res, 404, { error: 'Unknown conversation.' });
        return;
      }
      publishConversation(conversation.id);
      sendJson(res, 200, {
        conversation: store.conversationSummary(conversation.id),
        bridges: router.bridgeStatus(),
      });
      return;
    }

    case '/api/conversations/read': {
      const conversation = store.markRead(String(body.conversationId || ''));
      if (conversation) publishConversation(conversation.id);
      sendJson(res, 200, { ok: true });
      return;
    }

    case '/api/conversations/rename': {
      const conversation = store.renameConversation(String(body.conversationId || ''), body.title);
      if (!conversation) {
        sendJson(res, 404, { error: 'Unknown conversation.' });
        return;
      }
      publishConversation(conversation.id);
      sendJson(res, 200, { conversation: store.conversationSummary(conversation.id) });
      return;
    }

    case '/api/conversations/delete': {
      const conversationId = String(body.conversationId || '');
      const removed = store.deleteConversation(conversationId);
      if (removed) bus.publish({ type: 'conversation-removed', conversationId });
      sendJson(res, 200, { removed });
      return;
    }

    case '/api/conversations/invite': {
      const conversationId = String(body.conversationId || '');
      if (!store.getConversation(conversationId)) {
        sendJson(res, 404, { error: 'Unknown conversation.' });
        return;
      }

      sendJson(res, 200, inviteLinks(conversationId));
      return;
    }

    case '/api/conversations/uninvite': {
      const revoked = store.revokeGuest(String(body.conversationId || ''));
      sendJson(res, 200, { revoked });
      return;
    }

    case '/api/me': {
      const me = store.setMe({ name: body.name, color: body.color });
      bus.publish({ type: 'reload' });
      sendJson(res, 200, { me });
      return;
    }

    case '/api/samples/clear': {
      const removed = store.clearSamples();
      bus.publish({ type: 'reload' });
      sendJson(res, 200, { removed });
      return;
    }

    case '/api/typing': {
      // Ephemeral, so it never touches the store.
      bus.publish({
        type: 'typing',
        conversationId: body.conversationId,
        typing: Boolean(body.typing),
        from: 'peer',
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    default:
      sendJson(res, 404, { error: 'No such endpoint.' });
  }
}

/* ------------------------------------------------------------------ *
 * Request entry point
 * ------------------------------------------------------------------ */

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    if (pathname.startsWith('/api/webhooks/')) {
      await handleWebhook(req, res, pathname, method);
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, url, method, pathname);
      return;
    }

    if (method !== 'GET') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    const iconMatch = /^\/icon-(\d{2,4})\.png$/.exec(pathname);
    if (iconMatch) {
      sendIcon(res, Number(iconMatch[1]));
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      // Served to everyone: without a valid link the UI shows an "ask for an
      // invite" screen instead, which is friendlier than a bare 401.
      //
      // If the link carried an invite, remember it in a cookie too. An app added
      // to the Dock or a home screen reopens at "/" with no query string, and
      // Safari keeps cookies in that web app but not localStorage - so this is
      // what stops a friend landing on "you need an invite link" every time.
      serveStatic(res, 'index.html', authCookies(req, url));
      return;
    }

    serveStatic(res, pathname.replace(/^\/+/, ''));
  } catch (err) {
    console.error('[airchat] request failed:', err);
    if (res.headersSent) res.end();
    else sendJson(res, 500, { error: err.message || 'Something went wrong.' });
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

/* ------------------------------------------------------------------ *
 * Realtime
 * ------------------------------------------------------------------ */

function onClientMessage(conn, text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'typing' && payload.conversationId) {
    bus.publish(
      {
        type: 'typing',
        conversationId: payload.conversationId,
        typing: Boolean(payload.typing),
        from: 'peer',
      },
      { except: conn }
    );
    return;
  }

  if (payload.type === 'ping') conn.send({ type: 'pong' });
}

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    socket.destroy();
    return;
  }

  if (!url.pathname.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  const identity = resolveIdentity(req, url);
  if (!identity) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const conn = ws.handleUpgrade(req, socket, head);
  if (!conn) return;

  conn.identity = identity;
  clients.add(conn);
  conn.on('close', () => clients.delete(conn));
  conn.on('message', (text) => onClientMessage(conn, text));

  // Hand over the full state on connect, so a fresh client never has to guess
  // whether it missed an event while it was still loading.
  if (identity.role === 'guest') {
    const state = guestState(identity.guest);
    if (state) conn.send({ type: 'state', state });
    else conn.close(1008, 'that chat no longer exists');
    return;
  }

  conn.send({ type: 'state', state: fullState() });
});

const heartbeat = setInterval(() => {
  for (const conn of clients) {
    if (conn.closed || !conn.socket.writable) {
      conn.destroy();
      clients.delete(conn);
      continue;
    }
    conn.ping();
  }
}, 30000);
heartbeat.unref();

/* ------------------------------------------------------------------ *
 * Start up
 * ------------------------------------------------------------------ */

function openBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) console.log(`Could not open your browser automatically. Open this address: ${url}`);
  });
}

function describeBridges() {
  return router
    .bridgeStatus()
    .map((entry) => `${entry.channel}: ${entry.configured ? entry.label : 'not set up'}`)
    .join('   ');
}

function onListening() {
  const localUrl = `http://localhost:${config.port}`;

  watchPublicUrl();

  console.log('');
  console.log('  AirChat is running');
  console.log('');
  console.log(`  On this PC      ${localUrl}`);
  console.log(`  Same Wi-Fi      http://${lanAddress()}:${config.port}`);
  if (config.publicUrl) console.log(`  Public          ${config.publicUrl}`);
  if (config.publicUrlExpired) {
    console.log('  Public          the last public link expired - start AirChat with');
    console.log('                  "Start AirChat + Public Link.bat" and send the new link');
  }
  console.log(`  Sharing         ${serverInfo(true).inviteUrl}`);
  console.log('');
  console.log(`  Mirroring       ${describeBridges()}`);
  console.log('  Encryption      end to end in chats that stay inside AirChat');
  console.log('');
  console.log('  Add a friend in the app, then use "Invite" in a chat to get a link that');
  console.log('  opens it from their phone. Press Ctrl+C here to stop AirChat.');
  console.log('');

  router.startAdapters();

  if (config.openOnStart && !process.env.AIRCHAT_NO_BROWSER) {
    openBrowser(localUrl);
  }
}

/**
 * Does the saved public address actually lead back to this copy of AirChat?
 *
 * A free Quick Tunnel address is a random hostname that stops existing with the
 * process behind it, while `config.json` outlives both. Handing that stale link
 * to a friend is how AirChat comes to look broken: their browser reports
 * "server IP address could not be found". So the one case that cannot be judged
 * from a timestamp - a link with no proof-of-life stamp - is checked directly.
 *
 * Any HTTP answer counts as alive, including 401, 404 and 502: it proves the
 * hostname resolved and Cloudflare got to the other end. Only a DNS or
 * connection failure means the address is gone. The answer arrives before the
 * server starts listening, so a 502 from having no origin yet is still proof
 * that the tunnel itself exists.
 */
function probePublicUrl(url) {
  return new Promise((resolve) => {
    let settled = false;
    let request;

    // A hard deadline, because a hung DNS lookup is not covered by the socket
    // timeout. Nothing here may ever stop AirChat from starting: a stale link
    // is worth a few seconds, not a window that never comes up.
    const deadline = setTimeout(() => finish(false), 8000);
    if (typeof deadline.unref === 'function') deadline.unref();

    function finish(alive) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(alive);
    }

    try {
      // https.request on an http: URL throws, so pick by the address itself.
      const transport = /^http:/i.test(url) ? http : https;

      request = transport.request(url, { method: 'HEAD', timeout: 6000 }, (res) => {
        res.resume();
        finish(true);
      });
    } catch (err) {
      finish(false);
      return;
    }

    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', () => finish(false));
    request.end();
  });
}

/**
 * Keep the public link honest while AirChat runs.
 *
 * tools/tunnel.js clears the address from config.json when its tunnel stops, and
 * stops refreshing the stamp if it is killed outright - but this process read
 * the address at startup and would otherwise keep handing it out for the rest
 * of the session, which is a link the friend cannot open.
 *
 * It also takes a link *up*. Normally the tunnel saves the address before it
 * starts this server, so the address is already here - but a server started
 * first (started by hand, or left running from before the tunnel) would then
 * hand out Wi-Fi links forever, which is a link that cannot encrypt anything on
 * the friend's phone. A newly saved address is adopted once it is there, so the
 * next Invite is the https one.
 */

/** Start handing out a public link that appeared while this server was running. */
function adopt(stored) {
  if (stored === config.publicUrl) return;

  config.publicUrl = stored;
  config.publicUrlExpired = false;

  console.log('');
  console.log(`  Public link   ${stored}`);
  console.log('  Invite links now use it - the https address is the one a friend can open.');

  // Browsers already open on this server redraw their Invite window.
  bus.publish({ type: 'reload' });
}

function watchPublicUrl() {
  const check = () => {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      return; // Mid-write, or the file is gone. The next tick will try again.
    }

    const stored = String(saved.publicUrl || '').replace(/\/+$/, '');

    // A fresh address the tunnel saved while AirChat was already running. Only
    // one with a live stamp is taken: adopting a dead address would swap a
    // Wi-Fi link that works for one that does not resolve.
    const stamp = Number(saved.publicUrlAt);
    if (
      /^https:\/\//i.test(stored) &&
      stored !== config.publicUrl &&
      Number.isFinite(stamp) &&
      stamp > 0 &&
      !isPublicUrlStale(stamp)
    ) {
      adopt(stored);
      return check();
    }

    if (!config.publicUrl) return;
    if (stored && !isPublicUrlStale(saved.publicUrlAt)) return;

    config.publicUrl = '';
    config.publicUrlExpired = true;

    console.log('');
    console.log('  The public link was withdrawn, so invite links now work only on your Wi-Fi.');
    console.log('  Start AirChat with "Start AirChat + Public Link.bat" for a new one.');

    bus.publish({ type: 'reload' });
  };

  // Cheap enough to poll: the file changes at most every 20 seconds.
  fs.watchFile(CONFIG_PATH, { interval: 2000 }, check);
  // A killed tunnel freezes the stamp without touching the file, so look again.
  setInterval(check, 20000).unref();
}

function startListening() {
  server.listen(config.port, config.host, onListening);
}

if (config.publicUrl && config.publicUrlUnverified) {
  probePublicUrl(`${config.publicUrl}/`).then((alive) => {
    if (!alive) {
      console.log('');
      console.log(`  The saved public link does not answer: ${config.publicUrl}`);
      console.log('  It is left over from an earlier run, so AirChat will not hand it out.');
      console.log('  Start AirChat with "Start AirChat + Public Link.bat" for a fresh one.');
      config.publicUrl = '';
      config.publicUrlExpired = true;
    }
    startListening();
  });
} else {
  startListening();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${config.port} is already in use - AirChat may already be running.\n` +
        'Close the other copy, or change "port" in config.json.\n'
    );
  } else {
    console.error(`\nAirChat could not start: ${err.message}\n`);
  }
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal} received - shutting AirChat down.`);
  clearInterval(heartbeat);
  router.stopAdapters();

  for (const conn of clients) conn.close(1001, 'server shutting down');

  server.close(() => process.exit(0));
  // Do not hang forever waiting for sockets to drain.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
