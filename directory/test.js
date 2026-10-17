/**
 * Tests for the friend-code service, without Cloudflare.
 *
 * The Worker only needs three things from D1 - prepare/bind/run/first - so a few
 * lines of SQL-in-JavaScript stand in for the database and the real behaviour is
 * exercised: codes that are made, refreshed, resolved, expired, stolen, and the
 * addresses the service refuses to forward to.
 */

import worker from './worker.js';

let failures = 0;

function pass(message) {
  console.log(`  \u2713 ${message}`);
}

function fail(message, detail) {
  failures += 1;
  console.log(`  \u2717 ${message}`);
  if (detail) console.log(`      ${detail}`);
}

function check(condition, message, detail) {
  if (condition) pass(message);
  else fail(message, detail);
}

/** Just enough D1 for the four statements this Worker runs. */
function fakeDb() {
  const rows = new Map();

  return {
    rows,
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) {
          args = values;
          return statement;
        },
        async run() {
          if (/^CREATE TABLE IF NOT EXISTS codes/.test(sql)) {
            return { success: true };
          }

          if (/^DELETE FROM codes WHERE expires_at/.test(sql)) {
            const now = args[0];
            for (const [code, row] of rows) if (row.expires_at < now) rows.delete(code);
            return { success: true };
          }

          if (/^DELETE FROM codes WHERE code = /.test(sql)) {
            rows.delete(args[0]);
            return { success: true };
          }

          if (/^INSERT INTO codes/.test(sql)) {
            const [code, url, secret, expiresAt, createdAt] = args;
            rows.set(code, { code, url, secret, expires_at: expiresAt, created_at: createdAt });
            return { success: true };
          }

          if (/^UPDATE codes SET url/.test(sql)) {
            const [url, expiresAt, code] = args;
            const row = rows.get(code);
            if (row) {
              row.url = url;
              row.expires_at = expiresAt;
            }
            return { success: true };
          }

          throw new Error(`unexpected statement: ${sql}`);
        },
        async first() {
          if (/COUNT\(\*\)/.test(sql)) return { n: rows.size };

          if (/SELECT code FROM codes WHERE code = /.test(sql)) {
            return rows.has(args[0]) ? { code: args[0] } : null;
          }

          if (/SELECT code, secret, url FROM codes WHERE code = /.test(sql)) {
            return rows.get(args[0]) || null;
          }

          if (/SELECT url, expires_at FROM codes WHERE code = /.test(sql)) {
            return rows.get(args[0]) || null;
          }

          throw new Error(`unexpected query: ${sql}`);
        },
      };
      return statement;
    },
  };
}

function env() {
  return { DB: fakeDb() };
}

const BASE = 'https://codes.example.com';

function post(path, body, method = 'POST') {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TUNNEL = 'https://three-words-here.trycloudflare.com/?guest=abc123#key=xyz';

async function main() {
  console.log('Friend codes');

  {
    const E = env();
    const response = await worker.fetch(post('/api/codes', { url: TUNNEL, minutes: 30 }), E);
    const body = await response.json();

    check(response.status === 201, 'a code can be made for a live invite address', JSON.stringify(body));
    check(/^[A-HJ-NP-Z2-9]{6}$/.test(body.code || ''), `the code is six readable characters (${body.code})`);
    check(typeof body.secret === 'string' && body.secret.length >= 32, 'the app is given a secret to prove itself');
    check(body.expiresAt > Date.now(), 'the code carries an expiry');

    const resolved = await worker.fetch(new Request(`${BASE}/c/${body.code.toLowerCase()}`), E);
    check(resolved.status === 302, 'the code redirects to the app');
    check(resolved.headers.get('location') === TUNNEL, 'the redirect keeps the invite and the key after #',
      resolved.headers.get('location'));

    const pageResponse = await worker.fetch(new Request(`${BASE}/`), E);
    const pageHtml = await pageResponse.text();
    check(pageResponse.status === 200 && /Friend code/.test(pageHtml), 'there is a page to type a code into');
  }

  {
    const E = env();
    const made = await (await worker.fetch(post('/api/codes', { url: TUNNEL }), E)).json();

    const good = await worker.fetch(
      post('/api/codes', { code: made.code, secret: made.secret, url: TUNNEL.replace('abc123', 'def456') }, 'PUT'),
      E
    );
    check(good.status === 200, 'the app that made a code can move it to a new address');

    const stolen = await worker.fetch(
      post('/api/codes', { code: made.code, secret: 'not-the-secret', url: TUNNEL }, 'PUT'),
      E
    );
    check(stolen.status === 403, 'another app cannot take a code over');

    const unknown = await worker.fetch(post('/api/codes', { code: 'ZZZZZZ', secret: 'x', url: TUNNEL }, 'PUT'), E);
    check(unknown.status === 404, 'refreshing a code that does not exist says so');
  }

  {
    const E = env();
    const made = await (await worker.fetch(post('/api/codes', { url: TUNNEL, minutes: 1 }), E)).json();

    // Reach into the row to age it instead of waiting a minute.
    E.DB.rows.get(made.code).expires_at = Date.now() - 1;

    const expired = await worker.fetch(new Request(`${BASE}/c/${made.code}`), E);
    const html = await expired.text();
    check(expired.status === 200 && /expired/i.test(html), 'an expired code explains itself instead of forwarding');

    const ghost = await worker.fetch(new Request(`${BASE}/c/ABCDEF`), E);
    check(ghost.status === 200 && /not active/i.test(await ghost.text()), 'an unknown code says it is not active');
  }

  {
    const E = env();
    const phishing = await worker.fetch(post('/api/codes', { url: 'https://example.com/steal' }), E);
    const body = await phishing.json();
    check(phishing.status === 400, 'a code cannot be pointed at any random site', JSON.stringify(body));

    const notAUrl = await worker.fetch(post('/api/codes', { url: 'javascript:alert(1)' }), E);
    check(notAUrl.status === 400, 'a code cannot be pointed at a script');
  }

  {
    const E = env();
    const first = await (await worker.fetch(post('/api/codes', { url: TUNNEL }), E)).json();
    const second = await (await worker.fetch(post('/api/codes', { url: TUNNEL }), E)).json();
    check(first.code !== second.code, 'two friends get two different codes');
  }

  console.log('');
  if (failures === 0) console.log('  the friend code service works');
  else console.log(`  ${failures} problem${failures === 1 ? '' : 's'} found`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
