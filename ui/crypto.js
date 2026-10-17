/* AirChat's end-to-end encryption.
 *
 * The point of this file: the text of a message is turned into unreadable
 * cipher *inside your browser*, and is only turned back into text inside the
 * other person's browser. The AirChat server in between only ever holds the
 * cipher - so it cannot read your messages, and neither can anyone who copies
 * the data file, nor Cloudflare, nor anyone watching the network.
 *
 * How it works
 *   - one random 256-bit key per chat, created by the browser
 *   - AES-GCM, a fresh random 96-bit nonce for every single message
 *   - the chat id is authenticated as additional data, so a message cannot be
 *     lifted out of one chat and replayed into another
 *   - the key itself is shared in the part of an invite link after the "#",
 *     which browsers never send to a server (see app.js)
 *
 * Deliberately dependency-free: no build step, and the same file runs in a
 * browser tab, in an installed home-screen app, in the service worker and under
 * Node - which is how `npm run doctor` actually exercises it.
 */

(function (root) {
  'use strict';

  /** Marks a message body as AirChat ciphertext. */
  const PREFIX = 'airchat-enc-v1:';

  const KEY_BYTES = 32;
  const IV_BYTES = 12;
  const MAX_TEXT = 2000;

  const NO_CRYPTO =
    'This browser cannot encrypt, because the page is not on a secure address. ' +
    'End-to-end encryption needs https:// (the public AirChat link) or localhost.';

  /* ------------------------------------------------------------------ *
   * base64url, written out by hand
   *
   * atob/btoa are picky about characters and about padding, and this has to
   * behave identically in a browser and in Node. Twenty lines of table is
   * less to worry about than the difference.
   * ------------------------------------------------------------------ */

  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  const LOOKUP = (function () {
    const table = new Array(256).fill(-1);
    for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
    return table;
  })();

  function toBase64Url(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const hasB1 = i + 1 < bytes.length;
      const hasB2 = i + 2 < bytes.length;
      const b1 = hasB1 ? bytes[i + 1] : 0;
      const b2 = hasB2 ? bytes[i + 2] : 0;
      const triple = (b0 << 16) | (b1 << 8) | b2;

      out += ALPHABET[(triple >>> 18) & 63];
      out += ALPHABET[(triple >>> 12) & 63];
      if (hasB1) out += ALPHABET[(triple >>> 6) & 63];
      if (hasB2) out += ALPHABET[triple & 63];
    }
    return out;
  }

  function fromBase64Url(text) {
    const clean = String(text === undefined || text === null ? '' : text).replace(/=+$/, '');
    const out = [];
    let buffer = 0;
    let bits = 0;

    for (let i = 0; i < clean.length; i += 1) {
      const value = LOOKUP[clean.charCodeAt(i)];
      if (value === undefined || value === -1) {
        throw new Error('That is not valid AirChat key or message data.');
      }

      buffer = (buffer << 6) | value;
      bits += 6;

      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >>> bits) & 0xff);
        buffer &= (1 << bits) - 1;
      }
    }

    return new Uint8Array(out);
  }

  /* ------------------------------------------------------------------ *
   * Where the crypto comes from
   * ------------------------------------------------------------------ */

  /**
   * The platform's crypto, or null.
   *
   * A browser only exposes `subtle` on a secure address: https, or localhost.
   * On a plain http://192.168.x.x address this returns null on purpose, so the
   * UI can refuse to pretend a message is encrypted when it is not.
   */
  function provider() {
    const globalCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (globalCrypto && globalCrypto.subtle && globalCrypto.getRandomValues) return globalCrypto;

    // Node, which is how the doctor's self-test runs this exact file.
    if (typeof require === 'function') {
      try {
        const nodeCrypto = require('crypto');
        if (nodeCrypto && nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
          return nodeCrypto.webcrypto;
        }
      } catch (err) {
        // Not Node, or a locked-down Node. Report it as unavailable below.
      }
    }

    return null;
  }

  function isAvailable() {
    return Boolean(provider());
  }

  function unavailableReason() {
    return NO_CRYPTO;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    provider().getRandomValues(bytes);
    return bytes;
  }

  const importedKeys = new Map();

  async function importKey(keyText) {
    const platform = provider();
    if (!platform) throw new Error(NO_CRYPTO);

    const keyId = String(keyText || '');
    const already = importedKeys.get(keyId);
    if (already) return already;

    const raw = fromBase64Url(keyId);
    if (raw.length !== KEY_BYTES) {
      throw new Error('That chat key is the wrong length, so it cannot be used.');
    }

    const key = await platform.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    importedKeys.set(keyId, key);
    return key;
  }

  /** Ties a message to one chat, so it cannot be moved into another. */
  function additionalData(conversationId) {
    return new TextEncoder().encode(`airchat:${String(conversationId || '')}`);
  }

  /* ------------------------------------------------------------------ *
   * Keys
   * ------------------------------------------------------------------ */

  /** A brand new chat key, as text safe to put in a URL. */
  function newKey() {
    if (!provider()) throw new Error(NO_CRYPTO);
    return toBase64Url(randomBytes(KEY_BYTES));
  }

  /**
   * A short code both people can read out loud and compare.
   *
   * Both sides see the same six characters for the same chat, and nobody else
   * can produce that code without the key. If the two codes match, no one has
   * swapped a key in the middle.
   */
  const HUMAN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

  async function fingerprint(keyText) {
    const platform = provider();
    if (!platform) throw new Error(NO_CRYPTO);

    const digest = await platform.subtle.digest('SHA-256', fromBase64Url(keyText));
    const bytes = new Uint8Array(digest);

    let code = '';
    for (let i = 0; i < 6; i += 1) code += HUMAN_ALPHABET[bytes[i] % HUMAN_ALPHABET.length];
    return code;
  }

  /* ------------------------------------------------------------------ *
   * Messages
   * ------------------------------------------------------------------ */

  function looksEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  /**
   * Plain text in, cipher out.
   *
   * The returned value is what gets sent to the server and stored on disk, so
   * everything that reads it back must go through decrypt() below.
   */
  async function encrypt(keyText, conversationId, text) {
    const platform = provider();
    if (!platform) throw new Error(NO_CRYPTO);

    const message = String(text === undefined || text === null ? '' : text);
    if (!message) throw new Error('Nothing to encrypt.');
    if (message.length > MAX_TEXT) {
      throw new Error(`End-to-end encrypted messages can be up to ${MAX_TEXT} characters.`);
    }

    const key = await importKey(keyText);
    const iv = randomBytes(IV_BYTES);

    const cipher = await platform.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(conversationId) },
      key,
      new TextEncoder().encode(message)
    );

    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);

    return PREFIX + toBase64Url(combined);
  }

  /**
   * Cipher in, plain text out. Throws if the message was altered, belongs to a
   * different chat, or was written with a different key - which is exactly what
   * should happen.
   */
  async function decrypt(keyText, conversationId, payload) {
    const platform = provider();
    if (!platform) throw new Error(NO_CRYPTO);

    const body = String(payload === undefined || payload === null ? '' : payload);
    if (!looksEncrypted(body)) throw new Error('That message is not encrypted.');

    const combined = fromBase64Url(body.slice(PREFIX.length));
    if (combined.length <= IV_BYTES) throw new Error('That encrypted message is too short to be real.');

    const key = await importKey(keyText);
    const plain = await platform.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: combined.subarray(0, IV_BYTES),
        additionalData: additionalData(conversationId),
      },
      key,
      combined.subarray(IV_BYTES)
    );

    return new TextDecoder().decode(plain);
  }

  /* ------------------------------------------------------------------ *
   * Proof
   * ------------------------------------------------------------------ */

  /**
   * Prove, on this device, that encryption really works.
   *
   * This is the same function behind the "Run a security check" button in
   * Settings and the encryption section of `npm run doctor`, so the check you
   * can click is the check that gets tested.
   */
  async function selfTest() {
    const lines = [];

    if (!provider()) return { ok: false, lines, error: NO_CRYPTO };

    try {
      const key = newKey();
      const otherKey = newKey();
      const conversationId = `check-${Date.now()}`;
      const secret = `AirChat check ${toBase64Url(randomBytes(9))}`;

      const cipher = await encrypt(key, conversationId, secret);
      if (!looksEncrypted(cipher)) throw new Error('the locked text is not marked as encrypted');
      if (cipher.indexOf(secret) !== -1) {
        throw new Error('the original text is still readable inside the locked text');
      }
      lines.push('The text was locked before it was sent, and nothing readable is left.');

      if ((await decrypt(key, conversationId, cipher)) !== secret) {
        throw new Error('it did not unlock back to the same text');
      }
      lines.push('The other person can unlock it with the shared key.');

      // Flip a character in the middle. Everything after the first 16 base64
      // characters is real cipher, so this genuinely changes a byte.
      const middle = Math.floor(cipher.length / 2);
      const tampered = `${cipher.slice(0, middle)}${cipher[middle] === 'A' ? 'B' : 'A'}${cipher.slice(middle + 1)}`;

      async function refused(attempt) {
        try {
          await attempt();
        } catch (err) {
          return true;
        }
        return false;
      }

      if (!(await refused(() => decrypt(key, conversationId, tampered)))) {
        throw new Error('a message that had been altered still opened');
      }
      lines.push('A message that was changed on the way is refused.');

      if (!(await refused(() => decrypt(otherKey, conversationId, cipher)))) {
        throw new Error('the message opened with the wrong key');
      }
      lines.push('The wrong key cannot open the message.');

      if (!(await refused(() => decrypt(key, `${conversationId}x`, cipher)))) {
        throw new Error('the message opened in a chat it does not belong to');
      }
      lines.push('A message cannot be moved into another chat.');

      const code = await fingerprint(key);
      lines.push(`Both sides of a chat show the same six-character code (here: ${code}).`);

      return { ok: true, lines, error: null };
    } catch (err) {
      return { ok: false, lines, error: err.message };
    }
  }

  const api = {
    PREFIX,
    MAX_TEXT,
    isAvailable,
    unavailableReason,
    newKey,
    fingerprint,
    looksEncrypted,
    encrypt,
    decrypt,
    selfTest,
    toBase64Url,
    fromBase64Url,
  };

  root.AirChatCrypto = api;

  // Lets tools/doctor.js require() this file and test the real thing.
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
