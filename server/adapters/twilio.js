'use strict';

/**
 * Twilio SMS adapter.
 *
 * SMS is the one network that reaches *any* phone - including iPhones, where it
 * lands in the Messages app (green bubbles instead of blue). It is the cheapest
 * way to guarantee your friend actually receives a message.
 *
 * What you need: a Twilio account, a sending number, and (in the US) A2P 10DLC
 * registration for the number. See the README for the current cost picture.
 *
 *   send    -> POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
 *   inbound -> Twilio posts form-encoded webhooks to {publicUrl}/api/webhooks/twilio
 */

const PROVIDER = 'twilio';
const API_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

function clip(text, max) {
  const limit = max || 200;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function create({ config, hooks, channel }) {
  const settings = config.twilio || {};
  const accountSid = String(settings.accountSid || '');
  const authToken = String(settings.authToken || '');
  const fromNumber = String(settings.fromNumber || '');
  const configured = Boolean(accountSid && authToken && fromNumber);

  const publicUrl = String(config.publicUrl || '').replace(/\/+$/, '');
  const statusCallback = publicUrl ? `${publicUrl}/api/webhooks/twilio` : '';

  return {
    id: PROVIDER,
    label: 'Twilio SMS',
    channel,

    configured: () => configured,

    describe: () =>
      configured
        ? `Texting from ${fromNumber}.` +
          (statusCallback ? '' : ' Add publicUrl to config.json to get delivery receipts.')
        : 'Needs a Twilio account SID, auth token and sending number (twilio.* in config.json).',

    async send({ to, body }) {
      if (!configured) {
        return {
          ok: false,
          status: 'failed',
          detail:
            'Twilio is not configured. Fill in twilio.accountSid, twilio.authToken and twilio.fromNumber in config.json.',
        };
      }

      if (!to) {
        return { ok: false, status: 'failed', detail: 'This contact has no phone number saved.' };
      }

      const url = `${API_BASE}/${encodeURIComponent(accountSid)}/Messages.json`;
      const form = new URLSearchParams({ To: to, From: fromNumber, Body: body });
      if (statusCallback) form.set('StatusCallback', statusCallback);

      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });
        const text = await response.text();

        if (!response.ok) {
          return {
            ok: false,
            status: 'failed',
            detail: `Twilio returned ${response.status}: ${clip(text)}`,
          };
        }

        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          parsed = null;
        }

        const sid = parsed && parsed.sid ? parsed.sid : undefined;
        const accepted = parsed && parsed.status ? String(parsed.status) : 'queued';
        hooks.log(`[twilio] accepted message to ${to} (${accepted}, ${sid || 'no sid'})`);

        return {
          ok: true,
          status: accepted === 'delivered' ? 'delivered' : 'sent',
          detail: `Twilio accepted the message (${accepted}).`,
          externalId: sid,
        };
      } catch (err) {
        return { ok: false, status: 'failed', detail: `Could not reach Twilio: ${err.message}` };
      }
    },
  };
}

const STATUS_MAP = {
  accepted: 'sent',
  queued: 'sent',
  sending: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  undelivered: 'failed',
  canceled: 'failed',
};

/**
 * Twilio posts inbound messages and delivery receipts to the same URL, so we
 * tell them apart by which fields are present.
 */
function parseWebhook(fields) {
  if (!fields || typeof fields !== 'object') return null;

  const receipt = fields.MessageStatus || fields.SmsStatus;
  if (receipt) {
    const raw = String(receipt).toLowerCase();
    return {
      kind: 'status',
      externalId: fields.MessageSid || fields.SmsSid || null,
      status: STATUS_MAP[raw] || null,
      error: raw === 'failed' || raw === 'undelivered' ? `Twilio reported "${raw}".` : null,
    };
  }

  const from = fields.From || fields.from;
  const text = fields.Body || fields.body;
  if (!from || !text) return null;

  return {
    kind: 'message',
    address: from,
    body: text,
    externalId: fields.MessageSid || fields.SmsMessageSid || null,
  };
}

module.exports = { create, parseWebhook };
