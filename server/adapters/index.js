'use strict';

/**
 * Adapter registry.
 *
 * An adapter is how one outbound channel actually reaches somebody. Every
 * adapter exposes the same surface so the router never needs to care which
 * network it is talking to:
 *
 *   id            short name, e.g. "twilio"
 *   label         human name shown in the UI
 *   channel       which mirror channel it serves
 *   configured()  true when it has everything it needs to send
 *   describe()    one sentence for the UI explaining its state
 *   send({ to, body, conversationId, messageId })
 *                 -> { ok, status, detail, externalId? }
 *   start?()      optional; begin listening for inbound messages
 *   stop?()       optional; stop listening
 *
 * `hooks` is how an adapter talks back to AirChat:
 *   hooks.status(conversationId, messageId, status)
 *   hooks.inbound({ address, body, channel, externalId, createdAt, name, simulated })
 *   hooks.log(message)
 */

const mock = require('./mock');
const bluebubbles = require('./bluebubbles');
const twilio = require('./twilio');
const telegram = require('./telegram');
const off = require('./off');

/** Channels that deliver outside AirChat and therefore need a real adapter. */
const MIRROR_CHANNELS = ['imessage', 'sms', 'telegram'];

const FACTORIES = { mock, bluebubbles, twilio, telegram };

function createAdapters({ config, hooks }) {
  const adapters = {};

  for (const channel of MIRROR_CHANNELS) {
    const slot = (config.channels && config.channels[channel]) || {};
    const name = String(slot.adapter || 'off');

    let factory = null;
    if (name !== 'off') {
      factory = FACTORIES[name] || null;
      if (!factory) {
        console.warn(
          `[adapters] unknown adapter "${name}" for the ${channel} channel; treating it as off`
        );
      }
    }

    adapters[channel] = (factory || off).create({ config, hooks, channel });
  }

  return adapters;
}

module.exports = {
  createAdapters,
  MIRROR_CHANNELS,
  FACTORIES,
  parseBlueBubblesWebhook: bluebubbles.parseWebhook,
  parseTwilioWebhook: twilio.parseWebhook,
};
