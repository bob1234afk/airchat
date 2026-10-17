'use strict';

/**
 * Friend codes: a six-character handle your app publishes, instead of a link.
 *
 * The code itself cannot carry your address - the address changes every launch -
 * so a small directory (directory/worker.js, deployed once) holds `code -> the
 * address your app is on right now`, and a friend types the code into a page that
 * asks the directory and forwards them to you.
 *
 * Everything here is allowed to fail. No internet, the directory down, or a
 * refused address simply means "no code right now", and the interface says so
 * instead of pretending a friend can be reached.
 */

const DEFAULT_MINUTES = 12 * 60;
const TIMEOUT_MS = 8000;

/** The alphabet the directory hands out, kept here for tidying what people type. */
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function looksLikeCode(value) {
  return CODE_PATTERN.test(normalizeCode(value));
}

async function callDirectory(directory, path, body, method = 'POST', timeoutMs = TIMEOUT_MS) {
  const base = String(directory || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, detail: 'no friend code directory is configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}${path}`, {
      method: body ? method : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const parsed = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        detail: (parsed && parsed.error) || `the directory answered ${response.status}`,
      };
    }

    return { ok: true, ...parsed };
  } catch (err) {
    const detail =
      err.name === 'AbortError'
        ? 'the friend code directory did not answer in time'
        : `the friend code directory could not be reached (${err.message})`;
    return { ok: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for a fresh code pointing at `url`.
 *
 * `url` is the full invite address, including the part after "#" that carries the
 * chat key - the directory forwards it untouched.
 */
async function requestCode({ directory, url, minutes = DEFAULT_MINUTES } = {}) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    return { ok: false, detail: 'a code only works with a public https link, which needs cloudflared' };
  }

  const result = await callDirectory(directory, '/api/codes', { url, minutes }, 'POST');

  if (!result.ok) return result;
  if (!looksLikeCode(result.code)) {
    return { ok: false, detail: 'the directory answered with something that is not a code' };
  }

  return {
    ok: true,
    code: normalizeCode(result.code),
    secret: String(result.secret || ''),
    expiresAt: Number(result.expiresAt) || Date.now() + minutes * 60 * 1000,
  };
}

/** Point an existing code at a new address, which happens when the app restarts. */
async function refreshCode({ directory, code, secret, url, minutes = DEFAULT_MINUTES } = {}) {
  const clean = normalizeCode(code);
  if (!looksLikeCode(clean) || !secret) return { ok: false, detail: 'no code to move' };

  // PUT, not POST: a refresh moves an existing code. Posting here would make a
  // brand new code and leave the friend's six characters pointing at an address
  // that no longer exists - which looks exactly like the code having stopped
  // working for no reason.
  return callDirectory(directory, '/api/codes', { code: clean, secret, url, minutes }, 'PUT');
}

/** The page a friend types the code into, with the code already filled in. */
function codePage(directory, code) {
  const base = String(directory || '').replace(/\/+$/, '');
  return `${base}/c/${normalizeCode(code)}`;
}

function codeHome(directory) {
  return String(directory || '').replace(/\/+$/, '');
}

module.exports = {
  DEFAULT_MINUTES,
  normalizeCode,
  looksLikeCode,
  requestCode,
  refreshCode,
  codePage,
  codeHome,
};
