'use strict';

/** Placeholder for a channel the user has switched off in config.json. */

function create({ channel }) {
  return {
    id: 'off',
    label: 'Off',
    channel,
    configured: () => false,
    describe: () => `The ${channel} channel is switched off. Set channels.${channel}.adapter in config.json to turn it on.`,
    async send() {
      return { ok: false, status: 'failed', detail: `The ${channel} channel is switched off in config.json.` };
    },
  };
}

module.exports = { create };
