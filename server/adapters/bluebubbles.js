'use strict';

/**
 * BlueBubbles bridge - the only free way to send real blue-bubble iMessage.
 *
 * BlueBubbles is a small server that runs on a Mac signed into your Apple ID and
 * exposes a REST API plus webhooks. Point AirChat at it and iMessage threads here
 * go out as genuine iMessage.
 *
 * Requirements you cannot avoid: a Mac (real or macOS VM) that stays awake, with
 * the BlueBubbles server running and its API password set.
 *
 *   send   -> POST {serverUrl}/api/v1/message/text?password=...
 *   inbound-> BlueBubbles posts webhooks to {publicUrl}/api/webhooks/bluebubbles
 */

const PROVIDER = 'bluebubbles';

/** BlueBubbles addresses a 1:1 iMessage chat as "iMessage;-;<address>". */
function directChatGuid(address) {
  return `iMessage;-;${address}`;
}

function clip(text, max) {
  const limit = max || 200;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function create({ config, hooks, channel }) {
  const settings = config.bluebubbles || {};
  const serverUrl = String(settings.serverUrl || '').replace(/\/+$/, '');
  const password = String(settings.password || '');
  const configured = Boolean(serverUrl && password);

  return {
    id: PROVIDER,
    label: 'BlueBubbles (iMessage)',
    channel,

    configured: () => configured,

    describe: () =>
      configured
        ? `Relaying blue bubbles through ${serverUrl}.`
        : 'Needs BlueBubbles running on a Mac signed into your Apple ID (bluebubbles.serverUrl + bluebubbles.password in config.json).',

    async send({ to, body }) {
      if (!configured) {
        return {
          ok: false,
          status: 'failed',
          detail:
            'BlueBubbles is not configured. Add bluebubbles.serverUrl and bluebubbles.password to config.json.',
        };
      }

      if (!to) {
        return {
          ok: false,
          status: 'failed',
          detail: 'This contact has no phone number or Apple ID saved.',
        };
      }

      let url;
      try {
        url = new URL('/api/v1/message/text', serverUrl);
      } catch (err) {
        return {
          ok: false,
          status: 'failed',
          detail: `bluebubbles.serverUrl is not a valid URL: "${serverUrl}"`,
        };
      }
      url.searchParams.set('password', password);

      const payload = {
        chatGuid: directChatGuid(to),
        tempGuid: `airchat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        message: body,
        method: 'apple-script',
      };

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await response.text();

        if (!response.ok) {
          return {
            ok: false,
            status: 'failed',
            detail: `BlueBubbles returned ${response.status}: ${clip(text)}`,
          };
        }

        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          parsed = null;
        }

        const guid = parsed && parsed.data && parsed.data.guid ? parsed.data.guid : undefined;
        hooks.log(`[bluebubbles] delivered to ${to} (${guid || 'no guid returned'})`);

        return {
          ok: true,
          status: 'sent',
          detail: 'Handed to your Mac for iMessage delivery.',
          externalId: guid,
        };
      } catch (err) {
        return {
          ok: false,
          status: 'failed',
          detail: `Could not reach BlueBubbles at ${serverUrl}: ${err.message}`,
        };
      }
    },
  };
}

/** Translate a BlueBubbles webhook body into something AirChat understands. */
function parseWebhook(body) {
  if (!body || typeof body !== 'object') return null;

  const type = body.type;
  const data = body.data || {};

  if (type === 'new-message') {
    // Skip the echo of messages we just sent ourselves.
    if (data.isFromMe) return null;

    const address = data.handle && data.handle.address ? data.handle.address : null;
    const text = data.text || '';
    if (!address || !text) return null;

    return {
      kind: 'message',
      address,
      body: text,
      externalId: data.guid || null,
      createdAt: data.dateCreated || undefined,
      name: data.handle && data.handle.name ? data.handle.name : undefined,
    };
  }

  if (type === 'updated-message') {
    let status = null;
    if (data.error) status = 'failed';
    else if (data.dateRead || data.isRead) status = 'read';
    else if (data.dateDelivered || data.isDelivered) status = 'delivered';

    return {
      kind: 'status',
      externalId: data.guid || null,
      status,
      error: data.error ? String(data.error) : null,
    };
  }

  if (type === 'typing-indicator') {
    if (data.isFromMe) return null;
    const address = data.handle && data.handle.address ? data.handle.address : null;
    if (!address) return null;
    return { kind: 'typing', address, typing: data.typing !== false };
  }

  return null;
}

module.exports = { create, parseWebhook, directChatGuid };
