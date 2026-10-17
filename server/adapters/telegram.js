'use strict';

/**
 * Telegram adapter.
 *
 * The free, unlimited, works-today route. Telegram has a proper open Bot API, so
 * unlike iMessage this needs no Apple hardware and no per-message fee. The
 * trade-off is that your friend has to install Telegram and message your bot
 * once - after that AirChat can reach them forever.
 *
 * AirChat *polls* for updates (`getUpdates`) instead of registering a webhook,
 * which means it works while hosted on a laptop with no public URL at all.
 */

const API_BASE = 'https://api.telegram.org';

function clip(text, max) {
  const limit = max || 200;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function create({ config, hooks, channel }) {
  const token = String((config.telegram && config.telegram.botToken) || '');
  const configured = Boolean(token);

  let offset = 0;
  let stopped = false;
  let running = false;

  const apiUrl = (method) => `${API_BASE}/bot${token}/${method}`;

  async function poll() {
    running = true;

    while (!stopped) {
      try {
        const response = await fetch(`${apiUrl('getUpdates')}?timeout=25&offset=${offset}`);

        if (!response.ok) {
          const text = await response.text();
          hooks.log(`[telegram] getUpdates returned ${response.status}: ${clip(text)}`);
          await sleep(5000);
          continue;
        }

        const payload = await response.json();

        for (const update of payload.result || []) {
          offset = update.update_id + 1;

          const message = update.message || update.edited_message;
          if (!message || !message.text) continue;

          const chatId = message.chat && message.chat.id;
          if (chatId === undefined || chatId === null) continue;

          const from = message.from || {};
          const name =
            [from.first_name, from.last_name].filter(Boolean).join(' ') ||
            from.username ||
            String(chatId);

          hooks.inbound({
            address: String(chatId),
            body: message.text,
            channel,
            externalId: String(message.message_id),
            name,
          });
        }
      } catch (err) {
        hooks.log(`[telegram] polling failed: ${err.message}`);
        await sleep(5000);
      }
    }

    running = false;
  }

  return {
    id: 'telegram',
    label: 'Telegram',
    channel,

    configured: () => configured,

    describe: () =>
      configured
        ? 'Free and unlimited. Your friend just has to message your bot once so AirChat learns their chat id.'
        : 'Needs a bot token from @BotFather (telegram.botToken in config.json).',

    async send({ to, body }) {
      if (!configured) {
        return {
          ok: false,
          status: 'failed',
          detail: 'Telegram is not configured. Add telegram.botToken to config.json.',
        };
      }

      if (!to) {
        return {
          ok: false,
          status: 'failed',
          detail: 'No Telegram chat id on file yet. Have your friend message your bot once.',
        };
      }

      try {
        const response = await fetch(apiUrl('sendMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: to, text: body, disable_web_page_preview: true }),
        });

        const text = await response.text();

        if (!response.ok) {
          return {
            ok: false,
            status: 'failed',
            detail: `Telegram returned ${response.status}: ${clip(text)}`,
          };
        }

        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          parsed = null;
        }

        const messageId =
          parsed && parsed.result && parsed.result.message_id
            ? String(parsed.result.message_id)
            : undefined;

        return { ok: true, status: 'sent', detail: 'Sent through Telegram.', externalId: messageId };
      } catch (err) {
        return { ok: false, status: 'failed', detail: `Could not reach Telegram: ${err.message}` };
      }
    },

    start() {
      if (!configured || stopped || running) return;
      poll();
    },

    stop() {
      stopped = true;
    },
  };
}

module.exports = { create };
