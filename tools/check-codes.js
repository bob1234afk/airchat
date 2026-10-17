'use strict';

/**
 * Does the app hand out a friend code that really resolves to its own invite?
 *
 * Runs the real server against a stub directory on loopback, so the whole path -
 * invite route -> server/codes.js -> directory -> redirect - is exercised without
 * needing a tunnel, the internet, or any real people.
 *
 *   npm run check:codes
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_PORT = 4311;
const CODES_PORT = 4312;
const PUBLIC = 'https://probe-words-here.trycloudflare.com';
const TOKEN = 'test-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (err) {
            // not json
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Stands in for the deployed directory: hands out a code and remembers the address. */
function startStubDirectory() {
  const codes = new Map();
  let minted = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const reply = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'POST' && req.url === '/api/codes') {
        minted += 1;
        // Six characters from the same alphabet the real service uses.
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let n = minted;
        let code = '';
        while (code.length < 6) {
          code = alphabet[n % alphabet.length] + code;
          n = Math.floor(n / alphabet.length);
        }
        codes.set(code, parsed.url);
        reply(201, { code, secret: 'stub-secret', expiresAt: Date.now() + 600000, url: parsed.url });
        return;
      }

      if (req.method === 'PUT' || (req.method === 'POST' && req.url === '/api/codes/refresh')) {
        const row = codes.get(parsed.code);
        if (!row) return reply(404, { error: 'no such code' });
        if (parsed.secret !== 'stub-secret') return reply(403, { error: 'wrong secret' });
        codes.set(parsed.code, parsed.url || row);
        return reply(200, { code: parsed.code, expiresAt: Date.now() + 600000, url: parsed.url || row });
      }

      reply(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => server.listen(CODES_PORT, '127.0.0.1', () => resolve({ server, codes, minted: () => minted })));
}

async function main() {
  let failures = 0;
  const check = (condition, message, detail) => {
    if (condition) {
      console.log(`  \u2713 ${message}`);
    } else {
      failures += 1;
      console.log(`  \u2717 ${message}`);
      if (detail) console.log(`      ${detail}`);
    }
  };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-codes-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ port: APP_PORT, host: '127.0.0.1', token: TOKEN, openOnStart: false, publicUrl: PUBLIC, publicUrlAt: Date.now() })
  );

  const stub = await startStubDirectory();

  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      AIRCHAT_HOME: home,
      AIRCHAT_CODES_URL: `http://127.0.0.1:${CODES_PORT}`,
      AIRCHAT_PUBLIC_URL: PUBLIC,
      PORT: '',
      AIRCHAT_PORT: '',
      AIRCHAT_NO_BROWSER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });

  let log = '';
  app.stdout.on('data', (c) => (log += c));
  app.stderr.on('data', (c) => (log += c));

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      await sleep(250);
      up = await request(APP_PORT, 'GET', '/api/health', null, { 'x-airchat-token': TOKEN })
        .then((r) => r.status === 200)
        .catch(() => false);
    }
    check(up, 'the server started', log.slice(-400));
    if (!up) return;

    const owner = { 'x-airchat-token': TOKEN };

    const made = await request(APP_PORT, 'POST', '/api/conversations', {
      name: 'Code friend',
      address: 'airchat:code-friend',
      channel: 'sms',
      mirror: 'none',
    }, owner);

    check(made.status === 200 && made.json && made.json.conversation, 'a chat was made', made.text);
    const conversationId = made.json.conversation.id;

    const invited = await request(
      APP_PORT,
      'POST',
      '/api/conversations/invite',
      { conversationId, key: 'abc123key' },
      owner
    );

    const code = invited.json && invited.json.code;
    check(invited.status === 200 && code && code.ok === true, 'the invite answer contains a friend code',
      JSON.stringify(invited.json));
    if (!code || !code.ok) return;

    check(/^[A-HJ-NP-Z2-9]{6}$/.test(code.code), `the code is six readable characters (${code.code})`);
    check(code.page === `http://127.0.0.1:${CODES_PORT}`, 'it says where the friend types it', code.page);

    const stored = stub.codes.get(code.code);
    check(Boolean(stored), 'the directory was given the address', JSON.stringify([...stub.codes.keys()]));
    check(stored && stored.startsWith(`${PUBLIC}/?guest=`), 'the address is the public invite', stored);
    check(stored && stored.includes('#k=abc123key'), 'the chat key travels with it, so the friend can read the chat', stored);

    // Asking again must not mint a second code for the same chat: a friend who
    // already has the six characters should not find them dead.
    const again = await request(APP_PORT, 'POST', '/api/conversations/invite', { conversationId, key: 'abc123key' }, owner);
    check(again.json && again.json.code && again.json.code.code === code.code, 'asking again reuses the same code',
      JSON.stringify(again.json));
    check(stub.minted() === 1, 'only one code was minted for that chat', `minted=${stub.minted()}`);
  } finally {
    app.kill();
    stub.server.close();
    await sleep(400);
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log('');
  console.log(failures === 0 ? '  friend codes work end to end' : `  ${failures} problem(s) found`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
