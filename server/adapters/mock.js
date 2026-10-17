'use strict';

/**
 * Demo relay.
 *
 * Stands in for iMessage or SMS so you can exercise the whole
 * send -> deliver -> reply loop without signing up for anything. Everything it
 * produces is flagged `simulated`, and the UI labels those messages as demos, so
 * a fake delivery can never be mistaken for a real one.
 */

const REPLIES = [
  'got it',
  'ok sounds good',
  'wait, really?',
  'yeah that works for me',
  'one sec, let me check',
  'ha, fair',
  'perfect',
  'on my way',
];

function create({ config, hooks, channel }) {
  const settings = config.mock || {};
  const latency = Math.max(0, Number(settings.latencyMs) || 1200);
  const autoReply = settings.autoReply !== false;
  let replyIndex = 0;

  return {
    id: 'mock',
    label: 'Demo relay',
    channel,

    configured: () => true,

    describe: () =>
      'Demo mode. Nothing leaves your PC, but sending, delivery receipts and replies behave like the real thing.',

    async send({ to, conversationId, messageId }) {
      if (!to) {
        return {
          ok: false,
          status: 'failed',
          detail: 'This contact has no phone number or email address saved yet.',
        };
      }

      setTimeout(() => {
        hooks.status(conversationId, messageId, 'delivered');
      }, latency);

      if (autoReply) {
        const reply = REPLIES[replyIndex % REPLIES.length];
        replyIndex += 1;
        setTimeout(
          () => {
            hooks.inbound({ address: to, body: reply, channel, simulated: true });
          },
          latency + 800 + Math.floor(Math.random() * 1400)
        );
      }

      return { ok: true, status: 'sent', detail: `Demo delivery to ${to}` };
    },
  };
}

module.exports = { create };
