/**
 * AirChat friend codes.
 *
 * A code is how you add someone now: your app asks for one, you send those six
 * characters, and your friend types them here. This service does the one thing a
 * code cannot do by itself - turn it back into the address your app is reachable
 * at right now, which changes every time your app starts.
 *
 * It stores as little as it can:
 *
 *   code        six characters, no letters or digits that get misread
 *   url         the invite address, including the part after "#"
 *   secret      proves the app that made the code is the one changing it
 *   expires_at  a quick tunnel dies with the app, so codes do too
 *
 * Nothing about the conversation, the people, or the messages is here. This is a
 * forwarding table with an expiry, and the only thing it ever sends anyone is to
 * a Cloudflare quick tunnel (see ALLOWED_HOSTS).
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LENGTH = 6;
const DEFAULT_MINUTES = 12 * 60;
const MAX_MINUTES = 24 * 60;
const MAX_LIVE_CODES = 5000;

const ALLOWED_HOSTS = (globalThis.AIRCHAT_ALLOWED_HOSTS || '.trycloudflare.com')
  .split(',')
  .map((suffix) => suffix.trim().toLowerCase())
  .filter(Boolean);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      await ensureSchema(env);

      if (url.pathname === '/' && request.method === 'GET') return page(env);
      if (url.pathname === '/health') return json({ ok: true });

      if (url.pathname === '/api/codes' && request.method === 'POST') return register(request, env);
      if (url.pathname === '/api/codes' && request.method === 'PUT') return refresh(request, env);

      const codePath = url.pathname.match(/^\/c\/([A-Za-z0-9-]{1,12})$/);
      if (codePath && request.method === 'GET') return resolve(env, normalize(codePath[1]));

      return json({ error: 'Not found.' }, 404);
    } catch (err) {
      return json({ error: `The friend code service is not working: ${err.message}` }, 500);
    }
  },
};

/** Six characters that survive being read out loud or written down. */
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

function normalize(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Only ever send someone to a host this service is for.
 *
 * Without this, a code could point at anything on the internet, and a code is
 * something people trust enough to type without reading. The default is a
 * Cloudflare quick tunnel, which is the only kind of address the app hands out.
 */
function allowed(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix));
}

async function ensureSchema(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'
  ).run();
}

async function register(request, env) {
  const body = await request.json().catch(() => null);
  const target = String((body && body.url) || '');

  if (!allowed(target)) {
    return json({ error: 'That address is not one AirChat can send people to.' }, 400);
  }

  const minutes = Math.min(MAX_MINUTES, Math.max(1, Number((body && body.minutes) || DEFAULT_MINUTES)));
  const now = Date.now();
  const expiresAt = now + minutes * 60 * 1000;

  await env.DB.prepare('DELETE FROM codes WHERE expires_at < ?').bind(now).run();

  const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM codes').first();
  if (live && Number(live.n) >= MAX_LIVE_CODES) {
    return json({ error: 'The friend code service is full. Try again later.' }, 503);
  }

  const secret = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = newCode();
    const existing = await env.DB.prepare('SELECT code FROM codes WHERE code = ?').bind(code).first();
    if (existing) continue;

    await env.DB.prepare(
      'INSERT INTO codes (code, url, secret, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(code, target, secret, expiresAt, now)
      .run();

    return json({ code, secret, expiresAt, url: target }, 201);
  }

  return json({ error: 'Could not pick an unused code. Try again.' }, 503);
}

async function refresh(request, env) {
  const body = await request.json().catch(() => null);
  const code = normalize(body && body.code);
  const secret = String((body && body.secret) || '');
  const target = String((body && body.url) || '');

  if (!code || !secret) return json({ error: 'A code and its secret are required.' }, 400);
  if (target && !allowed(target)) return json({ error: 'That address is not one AirChat can send people to.' }, 400);

  const row = await env.DB.prepare('SELECT code, secret, url FROM codes WHERE code = ?').bind(code).first();
  if (!row) return json({ error: 'That code no longer exists.' }, 404);
  if (row.secret !== secret) return json({ error: 'That code belongs to another app.' }, 403);

  const minutes = Math.min(MAX_MINUTES, Math.max(1, Number((body && body.minutes) || DEFAULT_MINUTES)));
  const expiresAt = Date.now() + minutes * 60 * 1000;

  await env.DB.prepare('UPDATE codes SET url = ?, expires_at = ? WHERE code = ?')
    .bind(target || row.url, expiresAt, code)
    .run();

  return json({ code, expiresAt, url: target || row.url });
}

async function resolve(env, code) {
  if (!code) return page(env, { error: 'Type the code your friend sent you.' });

  const row = await env.DB.prepare('SELECT url, expires_at FROM codes WHERE code = ?').bind(code).first();

  if (!row) return page(env, { code, error: 'That code is not active. Ask your friend for a new one.' });
  if (Number(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM codes WHERE code = ?').bind(code).run();
    return page(env, { code, error: 'That code has expired. Ask your friend for a new one.' });
  }

  // The fragment is kept deliberately: it carries the chat key, and a browser
  // never sends it to a server, here or at the other end.
  return new Response(null, { status: 302, headers: { Location: row.url, 'Cache-Control': 'no-store' } });
}

function page(env, { code = '', error = '' } = {}) {
  const safeCode = code.replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const message = error
    ? `<p class="say bad">${escape(error)}</p>`
    : `<p class="say">Type the six characters your friend sent you.</p>`;

  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AirChat - add a friend</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #08090d; color: #e9ecf5;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: min(420px, 92vw); padding: 32px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .say { color: #9aa3b8; margin: 0 0 22px; font-size: 15px; }
  .bad { color: #ff8f8f; }
  form { display: flex; gap: 10px; }
  input { flex: 1; min-width: 0; padding: 16px 18px; font: 600 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.28em; text-transform: uppercase; text-align: center; color: #fff;
          background: #11131b; border: 1px solid #242838; border-radius: 12px; outline: none; }
  input:focus { border-color: #6c5ce7; box-shadow: 0 0 0 3px rgba(108,92,231,.22); }
  button { padding: 0 22px; font: 600 16px/1 inherit; color: #fff; background: #6c5ce7; border: 0;
           border-radius: 12px; cursor: pointer; }
  .where { margin-top: 22px; font-size: 13px; color: #6c7488; }
</style>
</head>
<body>
  <main>
    <h1>Add a friend</h1>
    ${message}
    <form method="get" action="/c/">
      <input name="code" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
             maxlength="12" placeholder="------" aria-label="Friend code" value="${escape(safeCode)}" autofocus>
      <button type="submit">Open</button>
    </form>
    <p class="where">A code only works while your friend's AirChat is running.</p>
  </main>
</body>
</html>`);
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
