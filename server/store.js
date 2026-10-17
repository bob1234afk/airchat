'use strict';

/**
 * AirChat's data store.
 *
 * Everything lives in one JSON file (data/airchat.json by default). For a
 * personal messenger that is plenty, and it keeps the whole app backup-able by
 * copying a single file. Writes go through a temp file + rename so a crash
 * mid-save cannot truncate the database.
 *
 * Deliberately free of npm dependencies so `node server/index.js` just works.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AVATAR_COLORS = [
  '#7C5CFF',
  '#0A84FF',
  '#32D74B',
  '#FF9F0A',
  '#FF375F',
  '#5E5CE6',
  '#40C8E0',
  '#BF5AF2',
];

/** Ways a thread can be mirrored onto a network outside AirChat. */
const MIRRORS = ['none', 'imessage', 'sms', 'telegram'];

/** How many messages per thread we hand to the UI. */
const MAX_MESSAGES_PER_THREAD = 300;

/**
 * How much of a message body we keep.
 *
 * An end-to-end encrypted message is stored as cipher, which is longer than the
 * text it protects - roughly a third again, plus a header. A generous limit
 * here is what stops a long message being truncated into something that can no
 * longer be decrypted.
 */
const MAX_BODY_CHARS = 12000;

function uid(prefix) {
  const value = crypto.randomUUID();
  return prefix ? `${prefix}_${value}` : value;
}

function initialsFrom(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic colour so the same person always gets the same avatar. */
function colorFrom(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100003;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function minutesAgo(minutes) {
  return Date.now() - minutes * 60000;
}

function publicContact(contact) {
  return {
    id: contact.id,
    name: contact.name,
    initials: contact.initials,
    color: contact.color,
    handles: contact.handles,
    sample: Boolean(contact.sample),
  };
}

/**
 * A couple of sample threads so the app has something to show on first launch.
 * They are tagged `sample: true`, and can be wiped from Settings in one click.
 */
function buildSeedData(me) {
  const maya = {
    id: uid('ct'),
    name: 'Maya Rios',
    initials: 'MR',
    color: colorFrom('Maya Rios'),
    handles: [{ address: '+14155550142', channel: 'imessage' }],
    sample: true,
  };
  const devin = {
    id: uid('ct'),
    name: 'Devin Park',
    initials: 'DP',
    color: colorFrom('Devin Park'),
    handles: [{ address: '+14155550188', channel: 'sms' }],
    sample: true,
  };
  const priya = {
    id: uid('ct'),
    name: 'Priya Nair',
    initials: 'PN',
    color: colorFrom('Priya Nair'),
    handles: [{ address: 'priya@icloud.com', channel: 'imessage' }],
    sample: true,
  };

  const mayaThread = uid('cv');
  const devinThread = uid('cv');

  const message = (conversationId, direction, body, minutes, status, channels, authorId) => ({
    id: uid('m'),
    conversationId,
    direction,
    body,
    channels,
    status,
    createdAt: minutesAgo(minutes),
    authorId,
  });

  const messages = {};
  messages[mayaThread] = [
    message(mayaThread, 'in', 'yo did you finish the history outline', 58, 'read', ['imessage'], maya.id),
    message(mayaThread, 'out', 'mostly - the last section is still rough', 54, 'delivered', ['airchat', 'imessage'], me.id),
    message(mayaThread, 'in', "send it over, i'll clean it up", 52, 'read', ['imessage'], maya.id),
    message(mayaThread, 'out', 'just sent it', 50, 'delivered', ['airchat', 'imessage'], me.id),
    message(mayaThread, 'in', 'ok this is actually good', 12, 'read', ['imessage'], maya.id),
    message(mayaThread, 'in', 'one thing tho, page 3 is missing the thesis', 11, 'read', ['imessage'], maya.id),
  ];
  messages[devinThread] = [
    message(devinThread, 'out', 'we still on for saturday?', 180, 'delivered', ['airchat', 'sms'], me.id),
    message(devinThread, 'in', 'yeah, 2pm right?', 175, 'read', ['sms'], devin.id),
    message(devinThread, 'out', '2pm. bring the controller', 170, 'delivered', ['airchat', 'sms'], me.id),
  ];

  return {
    version: 1,
    me,
    guests: [],
    contacts: [maya, devin, priya],
    conversations: [
      {
        id: mayaThread,
        title: 'Maya Rios',
        participantIds: [maya.id],
        isGroup: false,
        mirror: 'imessage',
        lastActivity: minutesAgo(11),
        unread: 2,
        createdAt: minutesAgo(58),
      },
      {
        id: devinThread,
        title: 'Devin Park',
        participantIds: [devin.id],
        isGroup: false,
        mirror: 'sms',
        lastActivity: minutesAgo(170),
        unread: 0,
        createdAt: minutesAgo(185),
      },
    ],
    messages,
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  load(me) {
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && parsed.messages && Array.isArray(parsed.conversations) && Array.isArray(parsed.contacts)) {
          this.data = parsed;
          // Databases written by an earlier version may not have these fields yet.
          if (!Array.isArray(this.data.guests)) this.data.guests = [];
          if (!this.data.me || !this.data.me.id) this.data.me = me;
          return this.data;
        }
        console.warn('[store] database file was not shaped like an AirChat database; starting fresh');
      } catch (err) {
        // Never silently discard someone's message history.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(this.file, backup);
        } catch (copyErr) {
          console.error(`[store] could not back up the unreadable database: ${copyErr.message}`);
        }
        console.error(`[store] could not read the database (${err.message}). Backup written to ${backup}`);
      }
    }

    this.data = buildSeedData(me);
    this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get me() {
    return this.data.me;
  }

  get contacts() {
    return this.data.contacts;
  }

  get conversations() {
    return this.data.conversations;
  }

  messagesFor(conversationId) {
    return this.data.messages[conversationId] || [];
  }

  getConversation(conversationId) {
    return this.data.conversations.find((c) => c.id === conversationId) || null;
  }

  findContactByAddress(address) {
    const needle = String(address || '').trim().toLowerCase();
    if (!needle) return null;
    return (
      this.data.contacts.find((c) =>
        c.handles.some((handle) => String(handle.address).toLowerCase() === needle)
      ) || null
    );
  }

  setMe(patch) {
    const name = typeof patch.name === 'string' ? patch.name.trim() : '';
    if (name) {
      this.data.me.name = name.slice(0, 40);
      this.data.me.initials = initialsFrom(name);
    }
    if (typeof patch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color)) {
      this.data.me.color = patch.color;
    }
    this.save();
    return this.data.me;
  }

  addContact({ name, address, channel }) {
    const clean = String(address || '').trim();
    if (!clean) throw new Error('A phone number or email address is required.');

    const existing = this.findContactByAddress(clean);
    if (existing) {
      const alreadyKnown = existing.handles.some(
        (handle) =>
          String(handle.address).toLowerCase() === clean.toLowerCase() && handle.channel === channel
      );
      if (!alreadyKnown) {
        existing.handles.push({ address: clean, channel });
        this.save();
      }
      if (name && existing.name === existing.handles[0].address) {
        existing.name = String(name).trim();
        existing.initials = initialsFrom(existing.name);
      }
      return { contact: existing, created: false };
    }

    const displayName = String(name || '').trim() || clean;
    const contact = {
      id: uid('ct'),
      name: displayName,
      initials: initialsFrom(displayName),
      color: colorFrom(displayName),
      handles: [{ address: clean, channel }],
      sample: false,
    };
    this.data.contacts.push(contact);
    this.save();
    return { contact, created: true };
  }

  createConversation({ title, participantIds, mirror }) {
    const ids = [...new Set((participantIds || []).filter(Boolean))];
    const contact = ids.length ? this.data.contacts.find((c) => c.id === ids[0]) : null;
    const conversation = {
      id: uid('cv'),
      title: String(title || '').trim() || (contact ? contact.name : 'New chat'),
      participantIds: ids,
      isGroup: ids.length > 1,
      mirror: MIRRORS.includes(mirror) ? mirror : 'none',
      lastActivity: Date.now(),
      unread: 0,
      createdAt: Date.now(),
    };
    this.data.conversations.push(conversation);
    this.data.messages[conversation.id] = [];
    this.save();
    return conversation;
  }

  /** Reuse the existing 1:1 thread for a contact instead of making duplicates. */
  ensureDirectConversation(contactId, mirror) {
    const existing = this.data.conversations.find(
      (c) => !c.isGroup && c.participantIds.length === 1 && c.participantIds[0] === contactId
    );

    if (existing) {
      if (mirror && mirror !== 'none' && existing.mirror === 'none') {
        existing.mirror = MIRRORS.includes(mirror) ? mirror : 'none';
        this.save();
      }
      return existing;
    }

    const contact = this.data.contacts.find((c) => c.id === contactId);
    if (!contact) throw new Error('Unknown contact.');

    return this.createConversation({
      title: contact.name,
      participantIds: [contactId],
      mirror,
    });
  }

  addMessage(fields) {
    const conversation = this.getConversation(fields.conversationId);
    if (!conversation) throw new Error('Unknown conversation.');

    const direction = fields.direction === 'in' ? 'in' : 'out';
    const channels =
      Array.isArray(fields.channels) && fields.channels.length ? fields.channels : ['airchat'];

    const message = {
      id: fields.id || uid('m'),
      conversationId: conversation.id,
      direction,
      body: String(fields.body === undefined || fields.body === null ? '' : fields.body).slice(
        0,
        MAX_BODY_CHARS
      ),
      channels,
      status: fields.status || 'sent',
      createdAt: fields.createdAt || Date.now(),
      authorId: fields.authorId || (direction === 'in' ? null : this.data.me.id),
    };

    // The remote network's id for this message, so delivery/read receipts can
    // find their way back to it (BlueBubbles guids, Twilio sids).
    if (fields.externalId) message.externalId = String(fields.externalId);
    // Set by the demo relay so nothing ever looks like a real delivery.
    if (fields.simulated) message.simulated = true;

    if (!this.data.messages[conversation.id]) this.data.messages[conversation.id] = [];
    this.data.messages[conversation.id].push(message);

    conversation.lastActivity = message.createdAt;
    if (direction === 'in' && !fields.silent) conversation.unread += 1;

    this.save();
    return message;
  }

  setMessageStatus(conversationId, messageId, status, error) {
    const message = this.messagesFor(conversationId).find((m) => m.id === messageId);
    if (!message) return null;
    message.status = status;
    if (error) message.error = String(error).slice(0, 300);
    else if (status !== 'failed') delete message.error;
    this.save();
    return message;
  }

  setMessageExternalId(conversationId, messageId, externalId) {
    const message = this.messagesFor(conversationId).find((m) => m.id === messageId);
    if (!message || !externalId) return null;
    message.externalId = String(externalId);
    this.save();
    return message;
  }

  findMessageByExternalId(externalId) {
    if (!externalId) return null;
    const needle = String(externalId);
    for (const conversation of this.data.conversations) {
      const message = this.messagesFor(conversation.id).find((m) => m.externalId === needle);
      if (message) return { conversationId: conversation.id, message };
    }
    return null;
  }

  markRead(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation || conversation.unread === 0) return null;
    conversation.unread = 0;
    this.save();
    return conversation;
  }

  setMirror(conversationId, mirror) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return null;

    if (conversation.isGroup && mirror && mirror !== 'none') {
      throw new Error(
        'Mirroring a group to iMessage, SMS or Telegram is not supported yet. Everyone in AirChat still gets the message.'
      );
    }

    conversation.mirror = MIRRORS.includes(mirror) ? mirror : 'none';
    this.save();
    return conversation;
  }

  renameConversation(conversationId, title) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return null;
    const clean = String(title || '').trim();
    if (clean) conversation.title = clean.slice(0, 60);
    this.save();
    return conversation;
  }

  deleteConversation(conversationId) {
    const before = this.data.conversations.length;
    this.data.conversations = this.data.conversations.filter((c) => c.id !== conversationId);
    if (this.data.conversations.length === before) return false;
    delete this.data.messages[conversationId];
    this.data.guests = this.data.guests.filter((guest) => guest.conversationId !== conversationId);
    this.save();
    return true;
  }

  findGuest(token) {
    if (!token) return null;
    return this.data.guests.find((guest) => guest.token === String(token)) || null;
  }

  /**
   * Create (or reuse) the invite that lets one friend open their side of a
   * thread in a browser. Reusing keeps the link they were sent working.
   */
  createGuestToken(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error('Unknown conversation.');

    const existing = this.data.guests.find((guest) => guest.conversationId === conversationId);
    if (existing) return existing;

    const contact = this.data.contacts.find((c) => conversation.participantIds.includes(c.id));
    const guest = {
      token: crypto.randomBytes(18).toString('hex'),
      conversationId,
      name: String(contact ? contact.name : conversation.title).slice(0, 40),
      createdAt: Date.now(),
    };

    this.data.guests.push(guest);
    this.save();
    return guest;
  }

  revokeGuest(conversationId) {
    const before = this.data.guests.length;
    this.data.guests = this.data.guests.filter((guest) => guest.conversationId !== conversationId);
    if (this.data.guests.length === before) return false;
    this.save();
    return true;
  }

  /** Remove the bundled sample threads and contacts. */
  clearSamples() {
    const sampleIds = new Set(this.data.contacts.filter((c) => c.sample).map((c) => c.id));
    if (!sampleIds.size) return 0;

    let removed = 0;
    this.data.conversations = this.data.conversations.filter((conversation) => {
      const isSample = conversation.participantIds.some((id) => sampleIds.has(id));
      if (isSample) {
        delete this.data.messages[conversation.id];
        removed += 1;
      }
      return !isSample;
    });
    this.data.contacts = this.data.contacts.filter((c) => !c.sample);
    this.save();
    return removed;
  }

  /** One conversation, shaped exactly the way the UI expects it. */
  conversationSummary(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return null;

    const messages = this.messagesFor(conversation.id);
    const last = messages.length ? messages[messages.length - 1] : null;

    return {
      id: conversation.id,
      title: conversation.title,
      isGroup: conversation.isGroup,
      mirror: conversation.mirror,
      unread: conversation.unread,
      lastActivity: conversation.lastActivity,
      createdAt: conversation.createdAt,
      participants: conversation.participantIds
        .map((id) => this.data.contacts.find((c) => c.id === id))
        .filter(Boolean)
        .map(publicContact),
      // The id is here so the UI can decrypt the newest message for the list on
      // the left, and the conversation id travels with it so a message can only
      // ever be unlocked for the chat it was written in.
      preview: last
        ? {
            id: last.id,
            conversationId: conversation.id,
            body: last.body,
            direction: last.direction,
            createdAt: last.createdAt,
            channels: last.channels,
            status: last.status,
          }
        : null,
    };
  }

  snapshot() {
    const conversations = this.data.conversations
      .map((conversation) => this.conversationSummary(conversation.id))
      .filter(Boolean)
      .sort((a, b) => b.lastActivity - a.lastActivity);

    const messages = {};
    for (const conversation of this.data.conversations) {
      const thread = this.messagesFor(conversation.id);
      messages[conversation.id] = thread.slice(-MAX_MESSAGES_PER_THREAD);
    }

    return {
      me: this.data.me,
      contacts: this.data.contacts.map(publicContact),
      conversations,
      messages,
    };
  }
}

module.exports = { Store, MIRRORS, AVATAR_COLORS, initialsFrom, colorFrom, uid, publicContact };
