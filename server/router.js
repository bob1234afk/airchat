'use strict';

/**
 * The channel router.
 *
 * This is the heart of AirChat's "one conversation, many networks" idea. Every
 * outbound message is delivered to AirChat always, and additionally mirrored to
 * whichever network the thread is set to (iMessage, SMS or Telegram).
 *
 * Inbound messages arrive the other way: an adapter picks them up (webhook or
 * polling), hands them to `receiveInbound`, and they land in the same thread as
 * everything else. So a thread is a single continuous conversation no matter how
 * many networks it has travelled over.
 */

const { MIRROR_CHANNELS } = require('./adapters');

const MAX_BODY_LENGTH = 4000;

/**
 * End-to-end encrypted messages arrive as cipher text, which is longer than the
 * text it protects, so they get more room. AirChat never looks inside one of
 * these - it only stores and forwards it.
 */
const MAX_CIPHER_LENGTH = 12000;
const CIPHER_PREFIX = 'airchat-enc-v1:';

class Router {
  constructor({ store, config, adapters, bus }) {
    this.store = store;
    this.config = config;
    this.adapters = adapters;
    this.bus = bus;
  }

  adapterFor(channel) {
    if (!MIRROR_CHANNELS.includes(channel)) return null;
    return this.adapters[channel] || null;
  }

  /** What each mirror channel can currently do. Drives the UI's status panel. */
  bridgeStatus() {
    return MIRROR_CHANNELS.map((channel) => {
      const adapter = this.adapters[channel];
      return {
        channel,
        adapter: adapter ? adapter.id : 'off',
        label: adapter ? adapter.label : 'Off',
        configured: adapter ? Boolean(adapter.configured()) : false,
        detail: adapter ? adapter.describe() : 'Not set up.',
      };
    });
  }

  /** Which address (phone number / Apple ID / chat id) to use for a network. */
  addressFor(conversation, channel) {
    const contact = this.store.contacts.find((c) => conversation.participantIds.includes(c.id));
    if (!contact || !contact.handles.length) return null;
    const exact = contact.handles.find((handle) => handle.channel === channel);
    return (exact || contact.handles[0]).address;
  }

  /** Queue an outbound message. Returns immediately; delivery continues in the background. */
  send({ conversationId, body }) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error('Unknown conversation.');
    if (conversation.participantIds.length === 0) throw new Error('Add someone to this chat first.');

    const text = String(body === undefined || body === null ? '' : body).trim();
    if (!text) throw new Error('Nothing to send.');

    // A message that is end-to-end encrypted is unreadable here by design, so it
    // is treated as opaque from this point on.
    const encrypted = text.startsWith(CIPHER_PREFIX);
    const limit = encrypted ? MAX_CIPHER_LENGTH : MAX_BODY_LENGTH;

    if (text.length > limit) {
      throw new Error(`That message is too long (${limit} characters max).`);
    }

    // Group mirroring is not supported yet; keep AirChat-only instead of failing.
    const mirror =
      !conversation.isGroup && conversation.mirror && conversation.mirror !== 'none'
        ? conversation.mirror
        : null;

    const message = this.store.addMessage({
      conversationId,
      direction: 'out',
      body: text,
      channels: mirror ? ['airchat', mirror] : ['airchat'],
      // Only claim "sending" when something actually has to happen remotely.
      status: mirror ? 'sending' : 'sent',
      authorId: this.store.me.id,
    });

    this.publishMessage(message);

    // Not reachable from the app, which refuses to point an encrypted chat at a
    // phone. Belt and braces: sending cipher to a phone network would be a
    // message nobody could ever read, so refuse and say so instead.
    if (mirror && encrypted) {
      this.fail(
        conversation.id,
        message.id,
        `This chat is end-to-end encrypted, so it was not sent by ${mirror}. A phone network has ` +
          'to be able to read whatever it carries. Set the chat to "AirChat only", or use a chat ' +
          'that is not encrypted to reach a phone.'
      );
      return message;
    }

    if (mirror) {
      this.deliver(conversation, message, mirror).catch((err) => {
        console.error('[router] unexpected delivery failure:', err);
        this.fail(conversation.id, message.id, err.message);
      });
    }

    return message;
  }

  async deliver(conversation, message, channel) {
    const adapter = this.adapterFor(channel);
    const to = this.addressFor(conversation, channel);

    if (!adapter || !adapter.configured()) {
      const detail = adapter ? adapter.describe() : `No adapter is set up for the ${channel} channel.`;
      this.fail(conversation.id, message.id, detail);
      return;
    }

    let result;
    try {
      result = await adapter.send({
        to,
        body: message.body,
        conversationId: conversation.id,
        messageId: message.id,
      });
    } catch (err) {
      result = { ok: false, status: 'failed', detail: err.message };
    }

    if (!result || result.ok === false) {
      this.fail(conversation.id, message.id, (result && result.detail) || 'Delivery failed.');
      return;
    }

    if (result.externalId) {
      this.store.setMessageExternalId(conversation.id, message.id, result.externalId);
    }

    const status = result.status || 'sent';
    this.store.setMessageStatus(conversation.id, message.id, status);
    this.bus.publish({
      type: 'status',
      conversationId: conversation.id,
      messageId: message.id,
      status,
      detail: result.detail,
    });
  }

  fail(conversationId, messageId, detail) {
    this.store.setMessageStatus(conversationId, messageId, 'failed', detail);
    this.bus.publish({
      type: 'status',
      conversationId,
      messageId,
      status: 'failed',
      error: detail,
    });
  }

  /** Called by adapters when somebody messages us on a mirrored network. */
  receiveInbound({ address, body, channel, externalId, createdAt, name, simulated }) {
    const text = String(body === undefined || body === null ? '' : body).trim();
    if (!text) return null;

    // Without an address there is nobody to attach the message to.
    if (!address) return null;

    let contact = this.store.findContactByAddress(address);
    if (!contact) {
      // A stranger messaged us. Add them so the thread has someone attached.
      const created = this.store.addContact({ name: name || address, address, channel });
      contact = created.contact;
    }

    const conversation = this.store.ensureDirectConversation(contact.id, channel);

    const message = this.store.addMessage({
      conversationId: conversation.id,
      direction: 'in',
      body: text,
      channels: [channel],
      status: 'delivered',
      authorId: contact.id,
      externalId,
      createdAt,
      simulated,
    });

    this.publishMessage(message);
    return message;
  }

  /** Delivery and read receipts coming back from a network. */
  ingestStatus({ externalId, status, error }) {
    if (!externalId || !status) return false;

    const found = this.store.findMessageByExternalId(externalId);
    if (!found) return false;

    this.store.setMessageStatus(found.conversationId, found.message.id, status, error);
    this.bus.publish({
      type: 'status',
      conversationId: found.conversationId,
      messageId: found.message.id,
      status,
      error: error || undefined,
    });
    return true;
  }

  /** Someone on iMessage is typing, so the AirChat thread can show it. */
  ingestTyping({ address, typing }) {
    if (!address) return;

    const contact = this.store.findContactByAddress(address);
    if (!contact) return;

    const conversation = this.store.conversations.find(
      (c) => !c.isGroup && c.participantIds.length === 1 && c.participantIds[0] === contact.id
    );
    if (!conversation) return;

    this.bus.publish({ type: 'typing', conversationId: conversation.id, typing: Boolean(typing) });
  }

  publishMessage(message) {
    this.bus.publish({
      type: 'message',
      message,
      conversation: this.store.conversationSummary(message.conversationId),
    });
  }

  startAdapters() {
    for (const channel of MIRROR_CHANNELS) {
      const adapter = this.adapters[channel];
      if (!adapter || typeof adapter.start !== 'function') continue;
      if (!adapter.configured()) continue;

      try {
        adapter.start();
        console.log(`[router] ${channel} adapter (${adapter.id}) started`);
      } catch (err) {
        console.error(`[router] could not start the ${channel} adapter: ${err.message}`);
      }
    }
  }

  stopAdapters() {
    for (const channel of MIRROR_CHANNELS) {
      const adapter = this.adapters[channel];
      if (!adapter || typeof adapter.stop !== 'function') continue;
      try {
        adapter.stop();
      } catch (err) {
        console.error(`[router] error stopping the ${channel} adapter: ${err.message}`);
      }
    }
  }
}

module.exports = { Router, MIRROR_CHANNELS, MAX_BODY_LENGTH };
