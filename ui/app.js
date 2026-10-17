/* AirChat client.
 *
 * Plain browser JavaScript with no build step and no framework. The server
 * pushes the authoritative state over a WebSocket, and this file only ever
 * renders what it is told - which is why the same file works as the desktop app
 * window, a browser tab, and a phone opened from an invite link.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const CHANNEL_NAMES = {
    airchat: 'AirChat',
    imessage: 'iMessage',
    sms: 'SMS',
    telegram: 'Telegram',
    none: 'AirChat only',
  };

  const STATUS_NAMES = {
    sending: 'Sending…',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read',
    failed: 'Failed',
  };

  function sameDay(a, b) {
    return a.toDateString() === b.toDateString();
  }

  function dayLabel(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    if (sameDay(date, now)) return 'Today';

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'Yesterday';

    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function shortTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    if (sameDay(date, now)) {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'Yesterday';

    if (now.getTime() - timestamp < 7 * 86400000) {
      return date.toLocaleDateString([], { weekday: 'short' });
    }

    return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }

  /* ------------------------------------------------------------------ *
   * Session
   * ------------------------------------------------------------------ */

  /**
   * The installed desktop app, or a browser that reached AirChat through a link?
   *
   * Both load this same file, and a handful of things are only true in one of
   * them: a service worker caches the app's own files underneath it, a home
   * screen install prompt is nonsense for something already installed, and a
   * plain http:// browser page has to be handed over to the https link because
   * it has no crypto at all. The app is told by desktop/preload.js, which is the
   * only place that knows for certain; the query string is a fallback for a
   * window opened by hand.
   */
  const params = new URLSearchParams(window.location.search);
  const ownerToken = params.get('token') || '';
  const guestToken = params.get('guest') || '';

  const APP = Boolean(window.airchatApp && window.airchatApp.isApp) || params.get('app') === 'desktop';
  const APP_VERSION = (window.airchatApp && window.airchatApp.version) || '';
  // Usually decided by the invite in the URL, but the server is authoritative -
  // see applyState, where a remembered cookie can also make us a guest.
  let isGuest = Boolean(guestToken);

  function authQuery() {
    if (guestToken) return `guest=${encodeURIComponent(guestToken)}`;
    if (ownerToken) return `token=${encodeURIComponent(ownerToken)}`;
    return '';
  }

  const AUTH_KEY = 'airchat.auth';
  const UPLIFT_KEY = 'airchat.secure-redirect';

  /**
   * Remember the invite so an installed home-screen icon keeps working. A
   * shortcut often reopens "/" with no query string at all, which would
   * otherwise drop your friend at "you need an invite link" every time.
   */
  function rememberAuth() {
    if (!ownerToken && !guestToken) return;
    try {
      window.localStorage.setItem(AUTH_KEY, authQuery());
    } catch (err) {
      // Private browsing can refuse storage; the URL still works for this visit.
    }
  }

  function restoreAuth() {
    if (ownerToken || guestToken) return false;

    try {
      const stored = window.localStorage.getItem(AUTH_KEY);
      if (!stored) return false;
      window.location.replace(`/?${stored}`);
      return true;
    } catch (err) {
      return false;
    }
  }

  let state = null;
  let activeId = null;
  let socket = null;
  let reconnectAttempts = 0;
  let lastTypingSent = 0;
  let peerTypingTimer = null;
  let bannerTimer = null;

  /* ------------------------------------------------------------------ *
   * End-to-end encryption
   *
   * The rule, in one sentence: a chat is encrypted when this device holds a key
   * for it, and a key is made when the chat is created as AirChat-only, or the
   * first time its invite window is opened - so the key can travel inside the
   * invite link, in the part of the address after "#", which a browser never
   * sends to any server.
   *
   * The other half of that rule: a chat with no key yet is NOT encrypted, and
   * the header must say so in words that name the fix ("Not encrypted yet -
   * Lock it") rather than leaving someone staring at a padlock-less line with
   * nothing to do about it.
   *
   * So the server (this computer), the data file on its disk, and everything in
   * between only ever hold the locked version of a message. The plain text
   * exists only in the two browsers.
   *
   * Chats that are mirrored to iMessage, SMS or Telegram cannot be encrypted:
   * the text has to be readable to be handed to a phone network. The UI says so
   * on the chat header, in the invite window, and in Settings.
   * ------------------------------------------------------------------ */

  const Crypto = window.AirChatCrypto || null;

  // Kept here too, so a body can be recognised as cipher even in the (should not
  // happen) case that crypto.js did not load - printing cipher at a person would
  // be worse than saying nothing at all.
  const ENCRYPTED_PREFIX = (Crypto && Crypto.PREFIX) || 'airchat-enc-v1:';

  function looksEncrypted(body) {
    if (Crypto) return Crypto.looksEncrypted(body);
    return typeof body === 'string' && body.startsWith(ENCRYPTED_PREFIX);
  }

  const KEYS_STORE = 'airchat.keys';
  const KEYS = new Map(); // conversationId -> key
  let keysLoaded = false;
  let pendingKey = ''; // a key from a link we could not place yet
  let saidEncrypted = false; // the one-time banner for someone opening an invite

  const decrypted = new Map(); // message id -> plain text
  const unreadable = new Set(); // message id -> could not be opened with our key
  const fingerprints = new Map(); // key -> six-character code
  let decryptFrame = 0;

  function loadKeys() {
    if (keysLoaded) return;
    keysLoaded = true;

    try {
      const raw = window.localStorage.getItem(KEYS_STORE);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return;

      for (const id of Object.keys(parsed)) {
        if (typeof parsed[id] === 'string' && parsed[id]) KEYS.set(id, parsed[id]);
      }
    } catch (err) {
      // Private browsing can refuse storage. Keys made during this visit still work.
    }
  }

  function persistKeys() {
    try {
      window.localStorage.setItem(KEYS_STORE, JSON.stringify(Object.fromEntries(KEYS)));
    } catch (err) {
      console.warn('AirChat could not save the chat keys in this browser:', err.message);
    }
  }

  function keyFor(conversationId) {
    loadKeys();
    return KEYS.get(conversationId) || '';
  }

  function rememberKey(conversationId, key) {
    if (!conversationId || !key) return;
    loadKeys();
    if (KEYS.get(conversationId) === key) return;

    KEYS.set(conversationId, key);
    persistKeys();

    // Anything that would not open under the old (or missing) key gets another go.
    decrypted.clear();
    unreadable.clear();
  }

  /** The key for this chat, creating one the first time the chat is shared. */
  function ensureKey(conversationId) {
    const existing = keyFor(conversationId);
    if (existing) return existing;
    if (!Crypto || !Crypto.isAvailable()) return '';

    const key = Crypto.newKey();
    rememberKey(conversationId, key);
    return key;
  }

  function isEncryptedChat(conversationId) {
    return Boolean(keyFor(conversationId));
  }

  /**
   * Pick up a chat key from the part of an invite link after "#".
   *
   * A browser never sends that part of a URL to a server - not in the request,
   * not in the Referer header - which is what lets two people share a key while
   * the server and everything in front of it never learn it.
   */
  function captureKeyFromLink() {
    const hash = String(window.location.hash || '').replace(/^#/, '');
    if (!hash || hash.indexOf('k=') === -1) return false;

    const fields = new URLSearchParams(hash);
    const key = fields.get('k') || '';
    const conversationId = fields.get('c') || '';
    if (!key) return false;

    if (conversationId) rememberKey(conversationId, key);
    else pendingKey = key; // a guest link: placed on their one chat once it is known

    // Now that it is saved, the key does not need to sit in the address bar,
    // where it would turn up in screenshots, history and shared tabs.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (err) {
      // Harmless: the key is stored either way.
    }

    return true;
  }

  function lockGlyph() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '10');
    svg.setAttribute('height', '10');
    svg.setAttribute('aria-hidden', 'true');

    const shackle = document.createElementNS(NS, 'path');
    shackle.setAttribute('d', 'M8 10.6V8.4a4 4 0 018 0v2.2');
    shackle.setAttribute('fill', 'none');
    shackle.setAttribute('stroke', 'currentColor');
    shackle.setAttribute('stroke-width', '2.3');
    shackle.setAttribute('stroke-linecap', 'round');

    const body = document.createElementNS(NS, 'rect');
    body.setAttribute('x', '5.2');
    body.setAttribute('y', '10.4');
    body.setAttribute('width', '13.6');
    body.setAttribute('height', '9.2');
    body.setAttribute('rx', '2.6');
    body.setAttribute('fill', 'currentColor');

    svg.appendChild(shackle);
    svg.appendChild(body);
    return svg;
  }

  /** The small padlock chip that marks an encrypted message. */
  function lockChip() {
    const chip = el('span', 'chip chip-lock');
    chip.title = 'End-to-end encrypted: only you and the other person can read this.';
    chip.appendChild(lockGlyph());
    chip.appendChild(el('span', null, 'Encrypted'));
    return chip;
  }

  /**
   * Unlock one message.
   *
   * Resolves to the plain text, or null when this device cannot read it (no key
   * here yet, or it was written with a different key).
   */
  function decryptMessage(message) {
    if (!looksEncrypted(message.body)) return Promise.resolve(message.body);
    if (decrypted.has(message.id)) return Promise.resolve(decrypted.get(message.id));
    if (unreadable.has(message.id)) return Promise.resolve(null);

    const key = keyFor(message.conversationId);
    if (!key) return Promise.resolve(null);

    return Crypto.decrypt(key, message.conversationId, message.body)
      .then((text) => {
        decrypted.set(message.id, text);
        scheduleDecryptRender();
        return text;
      })
      .catch(() => {
        unreadable.add(message.id);
        scheduleDecryptRender();
        return null;
      });
  }

  /**
   * Draw again once a batch of messages has been unlocked.
   *
   * Safe against looping: a message that has been opened, or definitively
   * cannot be, is never decoded a second time.
   */
  function scheduleDecryptRender() {
    // Nothing to draw (yet): a key can be read out of an invite link before the
    // first state has arrived, and rendering before that has nothing to show.
    if (!state || decryptFrame) return;

    decryptFrame = window.requestAnimationFrame(() => {
      decryptFrame = 0;

      if (activeId) {
        const conversation = findConversation(activeId);
        if (conversation) renderChatHeader(conversation);
        renderMessages({});
      }
      renderThreads();
    });
  }

  /** What a bubble should show, plus whether it is encrypted and readable. */
  function messageText(message) {
    if (!looksEncrypted(message.body)) {
      return { text: message.body || '', encrypted: false, readable: true };
    }

    if (decrypted.has(message.id)) {
      return { text: decrypted.get(message.id), encrypted: true, readable: true };
    }
    if (unreadable.has(message.id)) {
      return { text: 'This message could not be opened on this device.', encrypted: true, readable: false };
    }

    if (!keyFor(message.conversationId)) {
      return {
        text: 'Encrypted. Use the friend code for this chat on this device to read it.',
        encrypted: true,
        readable: false,
      };
    }

    // Start the decode; the render is repeated when it lands.
    decryptMessage(message);
    return { text: 'Unlocking…', encrypted: true, readable: false };
  }

  /** The newest message in a chat, for the sidebar. Null when unreadable here. */
  function previewBody(preview) {
    if (!looksEncrypted(preview.body)) return preview.body;
    if (decrypted.has(preview.id)) return decrypted.get(preview.id);
    if (unreadable.has(preview.id)) return null;

    decryptMessage(preview);
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Network
   * ------------------------------------------------------------------ */

  async function api(path, options) {
    const opts = options || {};
    const query = authQuery();
    const url = query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;

    const response = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(
        (payload && payload.error) || `Request failed with status ${response.status}.`
      );
      error.status = response.status;
      throw error;
    }

    return payload;
  }

  function connect() {
    const query = authQuery();
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}/ws${query ? `?${query}` : ''}`;

    let next;
    try {
      next = new WebSocket(url);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    socket = next;

    next.addEventListener('open', () => {
      reconnectAttempts = 0;
      banner(null);
    });

    next.addEventListener('message', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      handleEvent(payload);
    });

    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      scheduleReconnect();
    });

    // A failed connection always fires "close" too, which handles retrying.
    next.addEventListener('error', () => {});
  }

  function scheduleReconnect() {
    reconnectAttempts = Math.min(reconnectAttempts + 1, 8);
    const delay = Math.min(600 * Math.pow(1.7, reconnectAttempts - 1), 8000);

    if (reconnectAttempts > 1) banner('Lost the connection to AirChat. Reconnecting…');

    setTimeout(() => {
      if (!socket) connect();
    }, delay);
  }

  function handleEvent(event) {
    if (!event || !event.type || !state) return;

    if (event.type === 'state') {
      applyState(event.state);
      return;
    }

    if (event.type === 'message') {
      const message = event.message;
      const thread = state.messages[message.conversationId] || (state.messages[message.conversationId] = []);

      if (!thread.some((existing) => existing.id === message.id)) {
        thread.push(message);
      }

      upsertConversation(event.conversation);

      const looking =
        message.conversationId === activeId && document.visibilityState === 'visible';

      if (looking) {
        renderMessages({ animateId: message.id });
        if (!isMine(message)) markRead(message.conversationId);
      } else if (!isMine(message)) {
        alertIncoming(message);
      }

      renderThreads();
      return;
    }

    if (event.type === 'status') {
      const thread = state.messages[event.conversationId] || [];
      const message = thread.find((entry) => entry.id === event.messageId);
      if (!message) return;

      message.status = event.status;
      if (event.error) message.error = event.error;
      else delete message.error;

      if (event.conversationId === activeId) renderMessages({});
      renderThreads();
      return;
    }

    if (event.type === 'conversation') {
      upsertConversation(event.conversation);
      renderThreads();
      if (event.conversation && event.conversation.id === activeId) renderChat();
      return;
    }

    if (event.type === 'conversation-removed') {
      state.conversations = (state.conversations || []).filter(
        (conversation) => conversation.id !== event.conversationId
      );
      delete state.messages[event.conversationId];

      if (activeId === event.conversationId) {
        activeId = null;
        showList();
      }
      renderThreads();
      renderChat();
      return;
    }

    if (event.type === 'typing') {
      if (event.conversationId !== activeId) return;
      showPeerTyping(Boolean(event.typing));
      return;
    }

    if (event.type === 'reload') {
      refetch();
    }
  }

  async function refetch() {
    try {
      applyState(await api('/api/state'));
    } catch (err) {
      banner(`Could not refresh: ${err.message}`);
    }
  }

  /* ------------------------------------------------------------------ *
   * State plumbing
   * ------------------------------------------------------------------ */

  function applyState(next) {
    if (!next) return;

    // A plain http:// address gives a browser no crypto at all, so this page
    // cannot lock a message and cannot unlock the ones it receives. When the
    // server has an https address that works, go there instead of showing the
    // person an error they cannot act on.
    if (upliftToSecureAddress(next)) return;

    state = next;
    state.messages = state.messages || {};
    state.conversations = state.conversations || [];
    state.contacts = state.contacts || [];
    state.bridges = state.bridges || [];

    // The server decides the role. That matters when an installed app reopens at
    // "/" with no invite in the URL, only a cookie from when the link was first
    // opened: without this the guest would be shown the owner's sidebar.
    isGuest = next.view === 'guest';
    applyGuestChrome();

    for (const conversation of state.conversations) {
      if (!state.messages[conversation.id]) state.messages[conversation.id] = [];
    }

    // A guest link carries the key without naming the chat, because a guest only
    // ever has one. An owner's link always names it - see openInvite.
    if (pendingKey && isGuest && state.conversations.length) {
      rememberKey(state.conversations[0].id, pendingKey);
      pendingKey = '';
    }

    // Say it out loud, once, to someone who has just opened an invite link:
    // this is the moment they are deciding whether they trust the thing.
    if (isGuest && !saidEncrypted && state.conversations.length) {
      saidEncrypted = true;
      const conversationId = state.conversations[0].id;

      if (isEncryptedChat(conversationId)) {
        const who = state.peer && state.peer.name ? state.peer.name : 'the other person';
        banner(`This chat is end-to-end encrypted: only you and ${who} can read it.`);
      } else if ((state.messages[conversationId] || []).some((m) => looksEncrypted(m.body))) {
        // The chat is locked but no key came with this visit - which is what
        // happens if the link was copied without the "#" part on the end. Say
        // exactly what to do rather than leaving them staring at a padlock.
        banner(
          'This chat is end-to-end encrypted, but this device does not have the key yet. ' +
            'Ask for the code again and use it here.'
        );
      }
    }

    $('splash').classList.add('hidden');

    if (isGuest && !activeId && state.conversations.length) {
      activeId = state.conversations[0].id;
    }

    if (activeId && !findConversation(activeId)) activeId = null;

    renderMe();
    renderThreads();
    renderBridges();
    renderChat();

    if (activeId) markRead(activeId);
  }

  function findConversation(id) {
    return state.conversations.find((conversation) => conversation.id === id) || null;
  }

  function findContact(id) {
    return state.contacts.find((contact) => contact.id === id) || null;
  }

  function upsertConversation(conversation) {
    if (!conversation) return;
    const index = state.conversations.findIndex((entry) => entry.id === conversation.id);
    if (index === -1) state.conversations.push(conversation);
    else state.conversations[index] = conversation;
  }

  /** Which side of the thread is "me"? Guests sit on the other side. */
  function isMine(message) {
    return state.flip ? message.direction === 'in' : message.direction === 'out';
  }

  function bridgeFor(channel) {
    return state.bridges.find((bridge) => bridge.channel === channel) || null;
  }

  function bridgeHealth(channel) {
    const bridge = bridgeFor(channel);
    if (!bridge || bridge.adapter === 'off') return 'off';
    if (bridge.adapter === 'mock') return 'demo';
    return bridge.configured ? 'on' : 'off';
  }

  function bridgeSummary(channel) {
    const bridge = bridgeFor(channel);
    if (!bridge) return 'Not set up';
    if (bridge.adapter === 'mock') return 'Demo mode';
    if (!bridge.configured) return 'Not set up';
    return bridge.label;
  }

  /* ------------------------------------------------------------------ *
   * Sidebar
   * ------------------------------------------------------------------ */

  function makeAvatar(initials, color, extraClass) {
    const node = el('span', extraClass ? `avatar ${extraClass}` : 'avatar', initials || '?');
    node.style.background = color || '#7c5cff';
    return node;
  }

  function channelChip(channel, extraClass) {
    const chip = el('span', extraClass ? `chip ${extraClass}` : 'chip');
    chip.dataset.channel = channel;
    chip.appendChild(el('span', 'chip-dot'));
    chip.appendChild(el('span', null, CHANNEL_NAMES[channel] || channel));
    return chip;
  }

  function renderMe() {
    const me = state.me || { name: 'You', initials: 'Y', color: '#7c5cff' };
    const avatar = $('me-avatar');
    avatar.textContent = me.initials || '?';
    avatar.style.background = me.color || '#7c5cff';
    $('me-name').textContent = me.name || 'You';
    $('me-sub').textContent = isGuest
      ? 'Invited to one chat'
      : APP
        ? `AirChat app${APP_VERSION ? ` ${APP_VERSION}` : ''}`
        : `AirChat · port ${state.server.port}`;
  }

  function previewText(conversation) {
    const preview = conversation.preview;
    if (!preview || !preview.body) return 'No messages yet';

    // The sidebar shows the newest message, so an encrypted chat is opened here
    // too - otherwise the list would be a wall of cipher.
    const opened = previewBody(preview);
    if (opened === null) return '🔒 Encrypted message';

    const body = opened.replace(/\s+/g, ' ').trim();
    const clipped = body.length > 68 ? `${body.slice(0, 68)}…` : body;
    return preview.direction === 'out' ? `You: ${clipped}` : clipped;
  }

  function renderThreads() {
    // Runs on every state change, so it keeps the tab title honest too.
    updateTitle();

    const container = $('threads');
    container.textContent = '';

    const query = $('search').value.trim().toLowerCase();
    const sorted = state.conversations
      .slice()
      .sort((a, b) => b.lastActivity - a.lastActivity);

    const visible = query
      ? sorted.filter((conversation) => {
          const addresses = conversation.participants.flatMap((person) =>
            person.handles.map((handle) => handle.address)
          );
          const haystack = [conversation.title]
            .concat(conversation.participants.map((person) => person.name))
            .concat(addresses)
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : sorted;

    if (!visible.length) {
      const empty = el('div', 'threads-empty');
      empty.textContent = sorted.length
        ? 'No chats match that search.'
        : 'No chats yet. Use the + button to add a friend.';
      container.appendChild(empty);
      return;
    }

    for (const conversation of visible) {
      container.appendChild(threadRow(conversation));
    }
  }

  function threadRow(conversation) {
    const row = el('button', `thread${conversation.id === activeId ? ' active' : ''}${conversation.unread ? ' unread' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'listitem');
    row.addEventListener('click', () => openConversation(conversation.id));

    const person = conversation.participants[0];
    row.appendChild(
      makeAvatar(
        person ? person.initials : conversation.title.slice(0, 2).toUpperCase(),
        person ? person.color : '#7c5cff'
      )
    );

    const body = el('div', 'thread-body');

    const top = el('div', 'thread-top');
    top.appendChild(el('span', 'thread-name', conversation.title));
    top.appendChild(el('span', 'thread-time', shortTime(conversation.lastActivity)));
    body.appendChild(top);

    const bottom = el('div', 'thread-bottom');
    bottom.appendChild(el('span', 'thread-preview', previewText(conversation)));

    if (conversation.unread > 0) {
      bottom.appendChild(
        el('span', 'unread-dot', conversation.unread > 99 ? '99+' : String(conversation.unread))
      );
    } else {
      bottom.appendChild(
        channelChip(conversation.mirror === 'none' ? 'airchat' : conversation.mirror)
      );
    }

    body.appendChild(bottom);
    row.appendChild(body);
    return row;
  }

  function renderBridges() {
    const container = $('empty-bridges');
    container.textContent = '';

    for (const bridge of state.bridges) {
      const health = bridgeHealth(bridge.channel);
      const chip = channelChip(bridge.channel);
      chip.title = bridge.detail;
      if (health === 'demo') chip.classList.add('chip-sim');

      const label = el('span', null, `${bridge.label}${health === 'on' ? '' : health === 'demo' ? ' (demo)' : ' (off)'}`);
      chip.textContent = '';
      chip.appendChild(el('span', 'chip-dot'));
      chip.appendChild(label);
      container.appendChild(chip);
    }
  }

  /* ------------------------------------------------------------------ *
   * Chat pane
   * ------------------------------------------------------------------ */

  function openConversation(id) {
    activeId = id;
    $('app').dataset.view = 'chat';
    renderThreads();
    renderChat();
    markRead(id);
    $('input').focus();
  }

  function showList() {
    $('app').dataset.view = 'list';
  }

  function renderChat() {
    const conversation = findConversation(activeId);

    if (!conversation) {
      $('chat').classList.add('hidden');
      if (!isGuest) $('empty').classList.remove('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    $('chat').classList.remove('hidden');

    renderChatHeader(conversation);
    renderMirrorBar(conversation);
    renderMessages({ jump: true });
    updateComposerHint(conversation);
  }

  function renderChatHeader(conversation) {
    // A guest is talking to the AirChat owner, not to themselves.
    const subject = isGuest && state.peer ? state.peer : conversation.participants[0] || null;

    const avatar = $('chat-avatar');
    avatar.textContent = subject ? subject.initials : conversation.title.slice(0, 2).toUpperCase();
    avatar.style.background = (subject && subject.color) || '#7c5cff';

    $('chat-title').textContent = isGuest && state.peer ? state.peer.name : conversation.title;

    const sub = $('chat-sub');
    sub.textContent = '';

    // This line is the only place a phone has room for one fact, so it is spent
    // on the one that matters: whether the chat is protected.
    const locking = encryptionState(conversation);

    if (isGuest) {
      if (locking === 'encrypted') sub.appendChild(el('span', null, 'You are chatting over AirChat'));
      appendLockStatus(sub, conversation, locking);
      return;
    }

    const mirror = conversation.mirror || 'none';

    // "AirChat only" is already the highlighted choice in the "Send via" bar
    // right below, so this line does not spend itself repeating that: it is kept
    // for the padlock, or for the one line that says how to get one.
    if (locking === 'mirrored') {
      sub.appendChild(el('span', `status-dot ${bridgeHealth(mirror)}`));
      sub.appendChild(el('span', null, `Mirrored to ${bridgeSummary(mirror)}`));
    }

    appendLockStatus(sub, conversation, locking);
  }

  /**
   * What can honestly be said about locking for this chat, right now.
   *
   * There is more than one way for a chat to be unlocked, and they need
   * different words: a chat a phone network carries can never be locked, a page
   * on a plain http:// address is given no crypto to lock with, and a chat that
   * simply has no key yet can be locked with one tap. Saying "no encryption
   * here yet" for all three leaves the person with nothing to do about it.
   */
  function encryptionState(conversation) {
    if (keyFor(conversation.id)) return 'encrypted';
    if (conversation.mirror && conversation.mirror !== 'none') return 'mirrored';
    if (!Crypto || !Crypto.isAvailable()) return 'unavailable';
    return isGuest ? 'guest-no-key' : 'owner-no-key';
  }

  /**
   * Say in the chat header whether this chat is protected, and show the code
   * both sides should be reading out to each other.
   */
  function appendLockStatus(sub, conversation, state) {
    const locking = state || encryptionState(conversation);
    const key = keyFor(conversation.id);
    const lock = el('span', 'chat-sub-lock');

    if (locking !== 'encrypted' || !key) {
      lock.appendChild(lockOff(conversation, locking));
      sub.appendChild(lock);
      return;
    }

    lock.title =
      'Messages here are locked in the sender\u2019s browser and can only be opened where this chat\u2019s key is.';
    lock.appendChild(lockGlyph());
    lock.appendChild(el('span', null, 'End-to-end encrypted'));

    const known = fingerprints.get(key);
    if (known) {
      lock.appendChild(el('span', 'lock-code', known));
    } else if (Crypto && Crypto.isAvailable()) {
      Crypto.fingerprint(key)
        .then((code) => {
          fingerprints.set(key, code);
          // One redraw, and then the code is remembered, so this cannot loop.
          const current = findConversation(activeId);
          if (current && current.id === conversation.id) renderChatHeader(current);
        })
        .catch(() => {
          // No code to show. Everything else in the header is still true.
        });
    }

    sub.appendChild(lock);
  }

  /**
   * Why this chat is not locked - and, where the person can do something about
   * it, the fix is the label itself rather than a dead-end sentence.
   */
  function lockOff(conversation, locking) {
    if (locking === 'mirrored') {
      const off = el('span', 'lock-off', 'Not end-to-end encrypted');
      off.title = unencryptedReason(conversation);
      return off;
    }

    // Nothing in this browser can lock anything: a page that is not on https://
    // or localhost is not given a crypto engine at all. Say that, rather than
    // letting it look like a chat that simply has not been set up yet.
    if (locking === 'unavailable') {
      const off = el('span', 'lock-off', 'Cannot encrypt in this browser');
      off.title = unencryptedReason(conversation);
      return off;
    }

    // Only the owner can make a key, and only a link can carry it to the other
    // side, so asking for one is the guest's whole move.
    if (locking === 'guest-no-key') {
      const who = state.peer && state.peer.name ? state.peer.name : 'the other person';
      const off = el('span', 'lock-off', 'Ask for a new code');
      off.title = `Nothing sent here is locked yet. Ask ${who} for the code again and use it in this browser.`;
      return off;
    }

    // AirChat only, crypto available, no key yet. Opening the invite window is
    // the entire fix: it makes this chat's key and the link that carries it.
    const button = el('button', 'lock-off lock-off-action', 'Not encrypted yet \u00b7 Lock it');
    button.type = 'button';
    button.title = 'Make a key for this chat and get the link that carries it.';
    button.addEventListener('click', () => openInvite(conversation.id));
    return button;
  }

  function renderMirrorBar(conversation) {
    const bar = $('mirror-bar');
    bar.textContent = '';

    if (isGuest) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    bar.appendChild(el('span', 'mirror-label', 'Send via'));

    const options = [
      { channel: 'none', label: 'AirChat only' },
      { channel: 'imessage', label: 'iMessage' },
      { channel: 'sms', label: 'SMS' },
      { channel: 'telegram', label: 'Telegram' },
    ];

    const isGroup = Boolean(conversation.isGroup);
    const current = conversation.mirror || 'none';
    // An encrypted message has to be readable to reach a phone, so the two
    // cannot be combined. Refusing here is the honest option.
    const encrypted = isEncryptedChat(conversation.id);

    for (const option of options) {
      const active = current === option.channel;
      const blocked = (isGroup || encrypted) && option.channel !== 'none';

      const button = el('button', `mirror-opt${active ? ' on' : ''}`);
      button.type = 'button';
      button.appendChild(el('span', 'chip-dot'));
      button.appendChild(el('span', null, option.label));

      if (blocked) {
        button.disabled = true;
        button.title = isGroup
          ? 'Mirroring a group is not supported yet'
          : 'This chat is end-to-end encrypted, so it cannot be sent to a phone';
      } else if (option.channel !== 'none') {
        const bridge = bridgeFor(option.channel);
        if (bridge) button.title = bridge.detail;
        if (!active) button.addEventListener('click', () => setMirror(conversation.id, option.channel));
      } else if (!active) {
        button.addEventListener('click', () => setMirror(conversation.id, 'none'));
      }

      bar.appendChild(button);
    }

    if (isGroup) {
      bar.appendChild(el('span', 'mirror-note', 'Everyone in AirChat gets it · group mirroring soon'));
    } else if (encrypted) {
      bar.appendChild(el('span', 'mirror-note', 'Encrypted end to end · cannot be sent to a phone'));
    } else if (current !== 'none' && bridgeHealth(current) === 'demo') {
      bar.appendChild(el('span', 'mirror-note', 'Demo relay · nothing leaves this PC'));
    } else if (current !== 'none' && bridgeHealth(current) === 'off') {
      bar.appendChild(el('span', 'mirror-note', `${CHANNEL_NAMES[current]} is not set up yet`));
    }
  }

  function updateComposerHint(conversation) {
    const mirror = conversation.mirror || 'none';

    if (isEncryptedChat(conversation.id)) {
      $('input').placeholder = 'Message · end-to-end encrypted';
      return;
    }

    $('input').placeholder =
      isGuest || mirror === 'none' ? 'Message on AirChat' : `Message · also to ${CHANNEL_NAMES[mirror]}`;
  }

  function isNearBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 150;
  }

  function scrollToBottom(container, behavior) {
    window.requestAnimationFrame(() => {
      if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  function renderMessages(options) {
    const opts = options || {};
    const thread = state.messages[activeId] || [];
    const container = $('messages');

    const nearBottom = isNearBottom(container);
    container.textContent = '';

    if (!thread.length) {
      const empty = el('div', 'day-empty');
      empty.textContent = isGuest
        ? 'No messages here yet.'
        : 'No messages yet. Say something and it will go wherever this chat is pointed.';
      container.appendChild(empty);
      return;
    }

    let lastDay = '';
    let previous = null;

    for (const message of thread) {
      const day = new Date(message.createdAt).toDateString();
      if (day !== lastDay) {
        container.appendChild(el('div', 'date-sep', dayLabel(message.createdAt)));
        lastDay = day;
        previous = null;
      }

      container.appendChild(messageRow(message, previous, opts.animateId));
      previous = message;
    }

    if (opts.jump) scrollToBottom(container, 'auto');
    else if (nearBottom || opts.animateId) scrollToBottom(container, opts.animateId ? 'smooth' : 'auto');
  }

  function messageRow(message, previous, animateId) {
    const mine = isMine(message);
    const row = el('div', `msg${mine ? ' mine' : ''}`);

    const startsGroup =
      !previous ||
      previous.direction !== message.direction ||
      message.createdAt - previous.createdAt > 5 * 60000;
    if (startsGroup) row.classList.add('first-in-group');
    if (animateId && message.id === animateId) row.classList.add('appear');

    const conversation = findConversation(message.conversationId);
    if (!mine && conversation && conversation.isGroup) {
      const author = findContact(message.authorId);
      if (author) row.appendChild(el('div', 'msg-author', author.name));
    }

    // Work out what this bubble says. For an encrypted chat that is the locked
    // text being opened here, in the browser, as it is drawn.
    const shown = messageText(message);

    const bubble = el('div', 'bubble');
    if (message.status === 'failed') bubble.classList.add('failed');
    if (shown.encrypted && !shown.readable) bubble.classList.add('locked');
    bubble.textContent = shown.text;
    row.appendChild(bubble);

    const meta = el('div', 'msg-meta');
    meta.appendChild(el('span', null, shortTime(message.createdAt)));

    if (mine && message.status) {
      meta.appendChild(
        el('span', `status${message.status === 'read' ? ' status-read' : ''}${message.status === 'failed' ? ' status-failed' : ''}`, STATUS_NAMES[message.status] || message.status)
      );
    }

    // The whole point of AirChat: which network carried this one.
    const networks = (message.channels || []).filter((channel) => channel !== 'airchat');
    if (networks.length) {
      for (const network of networks) meta.appendChild(channelChip(network));
    } else {
      meta.appendChild(channelChip('airchat'));
    }

    if (shown.encrypted) meta.appendChild(lockChip());

    if (message.simulated) {
      // Never let a simulated delivery look like a real one.
      const sim = el('span', 'chip chip-sim');
      sim.appendChild(el('span', 'chip-dot'));
      sim.appendChild(el('span', null, 'Demo'));
      meta.appendChild(sim);
    }

    row.appendChild(meta);

    if (message.status === 'failed' && message.error) {
      row.appendChild(el('div', 'msg-error', message.error));
    }

    return row;
  }

  function showPeerTyping(typing) {
    const box = $('typing');

    if (peerTypingTimer) {
      clearTimeout(peerTypingTimer);
      peerTypingTimer = null;
    }

    if (!typing) {
      box.classList.add('hidden');
      return;
    }

    const conversation = findConversation(activeId);
    $('typing-text').textContent = `${conversation ? conversation.title : 'They'} is typing`;
    box.classList.remove('hidden');
    peerTypingTimer = setTimeout(() => box.classList.add('hidden'), 6000);
  }

  async function markRead(conversationId) {
    // A guest shares the owner's unread counter with them, so clearing it would
    // mark the owner's messages as read from the friend's phone. Guests get
    // notifications instead.
    if (isGuest) return;

    const conversation = findConversation(conversationId);
    if (!conversation || !conversation.unread) return;

    conversation.unread = 0;
    renderThreads();

    try {
      await api('/api/conversations/read', {
        method: 'POST',
        body: { conversationId },
      });
    } catch (err) {
      // Not worth interrupting anyone over: the next state push corrects it.
      console.warn('Could not mark the chat as read:', err.message);
    }
  }

  async function setMirror(conversationId, mirror) {
    if (mirror !== 'none' && isEncryptedChat(conversationId)) {
      banner(
        `This chat is end-to-end encrypted, so your messages cannot also be sent by ${CHANNEL_NAMES[mirror]}. ` +
          'A phone network has to be able to read what it carries.'
      );
      return;
    }

    try {
      const result = await api('/api/conversations/mirror', {
        method: 'POST',
        body: { conversationId, mirror },
      });

      upsertConversation(result.conversation);
      if (result.bridges) state.bridges = result.bridges;

      renderThreads();
      renderChat();
      renderBridges();

      banner(
        mirror === 'none'
          ? 'This chat now stays inside AirChat.'
          : `This chat now also sends over ${CHANNEL_NAMES[mirror]}.`
      );
    } catch (err) {
      banner(err.message);
    }
  }

  /* ------------------------------------------------------------------ *
   * Alerts
   * ------------------------------------------------------------------ */

  let audioContext = null;

  function notificationsSupported() {
    return typeof window.Notification === 'function';
  }

  function notificationPermission() {
    if (!notificationsSupported()) return 'unsupported';
    return window.Notification.permission;
  }

  function permissionLabel(permission) {
    if (permission === 'granted') return 'On';
    if (permission === 'denied') return 'Blocked in this browser';
    if (permission === 'unsupported') return 'Not supported here';
    return 'Off';
  }

  async function askForNotifications() {
    if (!notificationsSupported()) {
      throw new Error(
        'This browser cannot show notifications. On an iPhone, add AirChat to your home screen first, then try again.'
      );
    }

    const result = await window.Notification.requestPermission();
    if (result !== 'granted') {
      throw new Error('Notifications were not allowed. You can change that in your browser settings.');
    }

    await notify('AirChat is ready', 'New messages will show up here.');
  }

  /** Android browsers only show notifications that come from a service worker. */
  async function notify(title, body) {
    if (notificationPermission() !== 'granted') return;

    const options = {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'airchat-message',
      renotify: true,
    };

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(title, options);
        return;
      }
      new window.Notification(title, options);
    } catch (err) {
      // Never let a failed notification interfere with the message itself.
      console.warn('AirChat: could not show a notification:', err.message);
    }
  }

  /** A short two-note tone, synthesised so there is no audio file to ship. */
  function chime() {
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;

      if (!audioContext) audioContext = new Ctor();
      if (audioContext.state === 'suspended') audioContext.resume();

      const start = audioContext.currentTime;

      [880, 1318].forEach((frequency, index) => {
        const at = start + index * 0.09;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);

        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.22);
      });
    } catch (err) {
      console.warn('AirChat: could not play the alert tone:', err.message);
    }
  }

  /** One switch for both the tone and the notification. */
  async function alertIncoming(message) {
    if (notificationPermission() !== 'granted') return;

    const conversation = findConversation(message.conversationId);
    const text = await decryptMessage(message);
    const body = text === null ? 'New encrypted message' : text.replace(/\s+/g, ' ').slice(0, 140);

    notify(conversation ? conversation.title : 'AirChat', body);
    chime();
  }

  function updateTitle() {
    if (!state) return;

    // A guest is always inside their one conversation, so there is nothing to
    // badge - and their own sent messages land as "in" on the server.
    if (isGuest) {
      document.title = 'AirChat';
      return;
    }

    const unread = state.conversations.reduce(
      (total, conversation) => total + (conversation.unread || 0),
      0
    );

    document.title = unread ? `(${unread}) AirChat` : 'AirChat';
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // In the app there is nothing to install and nothing to cache: the interface
    // is on the same machine as the server, and a service worker sitting under an
    // app that is being replaced would keep serving the old interface. If an
    // earlier version registered one, take it back out.
    if (APP) {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch((err) => {
          // Not fatal: the interface still works, it just may be served from a
          // cache until the app is updated. Worth saying out loud, not worth
          // interrupting anyone over.
          console.warn('AirChat: could not remove a service worker:', err.message);
        });
      return;
    }

    // Service workers need a secure context: localhost, or an https:// tunnel.
    if (!window.isSecureContext) {
      console.info('AirChat: home-screen install and notifications need https (or localhost).');
      return;
    }

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('AirChat: service worker registration failed:', err.message);
      });
    };

    // The load event may already have fired, in which case waiting for it would
    // mean never registering at all.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }

  /* ------------------------------------------------------------------ *
   * Adding AirChat to a device
   * ------------------------------------------------------------------ */

  const INSTALL_DISMISSED_KEY = 'airchat.install.dismissed';
  let installPrompt = null;

  /** Already running from an icon rather than a browser tab? */
  function isInstalled() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      window.navigator.standalone === true
    );
  }

  function usesChromium() {
    return /Chrome|Chromium|Edg/.test(navigator.userAgent);
  }

  /** The exact few taps for the browser this person is actually holding. */
  function installSteps() {
    const ua = navigator.userAgent;
    const platform = navigator.platform || '';
    const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const ios = /iPad|iPhone|iPod/.test(ua) || touchMac;
    const android = /Android/.test(ua);

    if (ios) return 'Tap the Share button in Safari, then choose Add to Home Screen.';
    if (android && usesChromium()) return 'Open the \u22ee menu in Chrome, then choose Install app.';
    if (platform === 'MacIntel' && /Safari/.test(ua) && !usesChromium()) {
      return 'In Safari, open the File menu, then choose Add to Dock.';
    }
    if (usesChromium()) {
      return 'Click the monitor icon with the arrow in the address bar, then choose Install.';
    }
    return 'Open your browser menu and choose Install, or Add to Home Screen.';
  }

  function hideInstallCard() {
    $('install-card').classList.add('hidden');
  }

  function dismissInstallCard() {
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch (err) {
      // Private browsing can refuse storage; the card simply returns next time.
    }
    hideInstallCard();
  }

  function showInstallCard() {
    if (isInstalled()) return;

    const body = $('install-body');
    const steps = $('install-steps');
    const go = $('install-go');
    const browserIcon = $('install-browser-icon');

    if (installPrompt) {
      body.textContent =
        'Add AirChat to this device and it opens from its own icon, full screen, with notifications. Nothing to download, and no app store involved.';
      steps.classList.add('hidden');
      // Chrome and Edge keep their own install button in the address bar too.
      browserIcon.classList.toggle('hidden', !usesChromium());
      go.classList.remove('hidden');
    } else {
      body.textContent =
        'Add AirChat to this device and it opens from its own icon, full screen, with notifications.';
      steps.textContent = installSteps();
      steps.classList.remove('hidden');
      browserIcon.classList.add('hidden');
      go.classList.add('hidden');
    }

    $('install-card').classList.remove('hidden');
  }

  function maybeOfferInstall() {
    if (APP || isInstalled()) return;

    try {
      if (window.localStorage.getItem(INSTALL_DISMISSED_KEY)) return;
    } catch (err) {
      // No storage to remember a refusal in, and offering once is still kind.
    }

    showInstallCard();
  }

  // Chrome and Edge fire this once, and only while AirChat is installable. Keep
  // it so our own button can ask for the real install prompt.
  window.addEventListener('beforeinstallprompt', (event) => {
    if (APP) return;
    event.preventDefault();
    installPrompt = event;
    if (!$('install-card').classList.contains('hidden')) showInstallCard();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    hideInstallCard();
  });

  /* ------------------------------------------------------------------ *
   * Composer
   * ------------------------------------------------------------------ */

  function autoGrow() {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function broadcastTyping(active) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeId) return;

    if (active) {
      const now = Date.now();
      if (now - lastTypingSent < 2000) return;
      lastTypingSent = now;
    }

    socket.send(JSON.stringify({ type: 'typing', conversationId: activeId, typing: active }));
  }

  async function sendMessage() {
    const input = $('input');
    const body = input.value.trim();
    if (!body || !activeId) return;

    const conversationId = activeId;
    input.value = '';
    autoGrow();
    broadcastTyping(false);

    const button = $('send');
    button.disabled = true;

    try {
      // Locking the text happens here, in this browser, before anything leaves
      // it. For an encrypted chat the server never receives the plain text.
      const key = keyFor(conversationId);
      let outgoing = body;

      if (key) {
        if (!Crypto || !Crypto.isAvailable()) {
          // Nothing was sent: this address has no crypto, and sending the text
          // unlocked would quietly break the promise the lock makes. Say what to
          // do about it, because the person on the other end of a Wi-Fi link
          // has no way to guess.
          const reason = Crypto
            ? Crypto.unavailableReason()
            : 'Messages cannot be locked in this browser.';
          throw new Error(`${reason} Nothing was sent - ask for the https link and open that.`);
        }
        outgoing = await Crypto.encrypt(key, conversationId, body);
      }

      const result = await api('/api/send', { method: 'POST', body: { conversationId, body: outgoing } });

      // What comes back is the locked text that was stored. Remember what it
      // says right away, so the message does not blink through "Unlocking…".
      if (result && result.message && looksEncrypted(result.message.body)) {
        decrypted.set(result.message.id, body);
      }

      // With no socket (offline, or still connecting) apply the result locally.
      if ((!socket || socket.readyState !== WebSocket.OPEN) && result && result.message) {
        const thread = state.messages[conversationId] || (state.messages[conversationId] = []);
        if (!thread.some((entry) => entry.id === result.message.id)) {
          thread.push(result.message);
          if (conversationId === activeId) renderMessages({ animateId: result.message.id });
          renderThreads();
        }
      }
    } catch (err) {
      banner(err.message);
      // Give the text back rather than losing what they typed.
      input.value = body;
      autoGrow();
    } finally {
      button.disabled = false;
      if (activeId === conversationId) input.focus();
    }
  }

  /* ------------------------------------------------------------------ *
   * Modals
   * ------------------------------------------------------------------ */

  function openModal(build) {
    const root = $('modal-root');
    const modal = $('modal');

    modal.textContent = '';
    root.classList.remove('hidden');

    const result = build(modal);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        modal.textContent = '';
        modal.appendChild(el('h3', null, 'Something went wrong'));
        modal.appendChild(el('p', 'modal-error', err.message));
      });
    }

    return modal;
  }

  function closeModal() {
    $('modal-root').classList.add('hidden');
    $('modal').textContent = '';
  }

  function field(labelText, type, placeholder, hint) {
    const wrapper = el('div', 'field');
    wrapper.appendChild(el('label', null, labelText));

    const input = document.createElement('input');
    input.type = type;
    input.placeholder = placeholder;
    wrapper.appendChild(input);

    if (hint) wrapper.appendChild(el('span', 'hint', hint));

    return { wrapper, input };
  }

  function choiceField(labelText, options, initial, hint, onChange) {
    const wrapper = el('div', 'field');
    wrapper.appendChild(el('label', null, labelText));

    const row = el('div', 'choice-row');
    let selected = initial;
    const buttons = [];

    for (const option of options) {
      const button = el('button', `choice${option.value === selected ? ' on' : ''}`);
      button.type = 'button';
      button.appendChild(el('span', null, option.label));
      if (option.hint) button.title = option.hint;

      button.addEventListener('click', () => {
        selected = option.value;
        for (const other of buttons) other.classList.toggle('on', other === button);
        if (onChange) onChange(selected);
      });

      buttons.push(button);
      row.appendChild(button);
    }

    wrapper.appendChild(row);
    if (hint) wrapper.appendChild(el('span', 'hint', hint));

    return { wrapper, value: () => selected };
  }

  function modalActions(modal, { primaryLabel, onPrimary, danger }) {
    const actions = el('div', 'modal-actions');
    const error = el('p', 'modal-error');

    const cancel = el('button', 'btn btn-quiet', 'Close');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);

    const primary = el('button', `btn ${danger ? 'btn-danger' : 'btn-primary'}`, primaryLabel);
    primary.type = 'button';
    primary.addEventListener('click', async () => {
      error.textContent = '';
      primary.disabled = true;
      try {
        await onPrimary();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        primary.disabled = false;
      }
    });

    actions.appendChild(cancel);
    actions.appendChild(primary);
    modal.appendChild(error);
    modal.appendChild(actions);

    return { error, primary };
  }

  async function copyInto(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      flash(button, 'Copied');
      return;
    } catch (err) {
      // The clipboard API needs a secure context; a plain http:// LAN address
      // is not one, so fall back to selecting the text for a manual copy.
    }

    const input = button.parentElement.querySelector('input');
    if (input) {
      input.select();
      input.setSelectionRange(0, input.value.length);
      try {
        if (document.execCommand('copy')) {
          flash(button, 'Copied');
          return;
        }
      } catch (err) {
        // Fall through to the manual instruction.
      }
    }

    flash(button, 'Select + copy');
  }

  function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => {
      button.textContent = original;
    }, 1700);
  }

  function linkBox(value, copyLabel) {
    const box = el('div', 'link-box');
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = value;
    input.spellcheck = false;

    const copy = el('button', 'btn btn-quiet', copyLabel || 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => copyInto(value, copy));

    box.appendChild(input);
    box.appendChild(copy);
    return box;
  }

  /**
   * The six characters, big enough to read out loud.
   *
   * It keeps a real input element so the copy button still has something to
   * select when the clipboard API is unavailable - which is every non-secure
   * context, including a plain Wi-Fi address.
   */
  function codeBox(value) {
    const box = el('div', 'code-box');

    const input = document.createElement('input');
    input.readOnly = true;
    input.value = value;
    input.spellcheck = false;
    input.className = 'code-input';
    input.setAttribute('aria-label', 'Friend code');

    const copy = el('button', 'btn btn-quiet', 'Copy code');
    copy.type = 'button';
    copy.addEventListener('click', () => copyInto(value, copy));

    box.appendChild(input);
    box.appendChild(copy);
    return box;
  }

  /**
   * Ask an address whether anything is there.
   *
   * A cross-origin request in "no-cors" mode cannot read the answer, and does
   * not need to: the only question is whether anything answered at all. A link
   * whose tunnel is gone fails before that, at DNS, and that failure is visible
   * here. Better a button that checks than a sentence that guesses.
   */
  async function linkAnswers(url) {
    try {
      await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      return true;
    } catch (err) {
      return false;
    }
  }

  function metaRow(keyText, valueNode) {
    const row = el('div', 'meta-row');

    const key = el('span', 'meta-key');
    if (typeof keyText === 'string') key.textContent = keyText;
    else key.appendChild(keyText);
    row.appendChild(key);

    const value = el('span', 'meta-val');
    if (typeof valueNode === 'string') value.textContent = valueNode;
    else value.appendChild(valueNode);

    row.appendChild(value);
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Modal: new chat
   * ------------------------------------------------------------------ */

  function openNewChat() {
    openModal((modal) => {
      modal.appendChild(el('h3', null, 'New chat'));
      modal.appendChild(
        el('p', 'modal-sub', 'Add someone by phone number or email. Where you point the chat is where your messages actually land.')
      );

      const nameField = field('Name', 'text', 'Maya', 'What you want to call them.');
      const addressField = field(
        'Phone or email',
        'text',
        '+1 415 555 0142',
        'Only needed for iMessage or SMS, so the text can reach their phone.'
      );
      modal.appendChild(nameField.wrapper);
      modal.appendChild(addressField.wrapper);

      // Say out loud whether the chosen channel can actually reach a phone, so
      // entering a phone number can never make a demo delivery look real.
      const reachNote = el('span', 'hint reach-note');

      const describeReach = (value) => {
        if (value === 'none') {
          reachNote.textContent =
            'Stays inside AirChat, and every message is encrypted end to end. Your friend replies from the link you send them — free, and nothing for them to install.';
          return;
        }

        const health = bridgeHealth(value);
        if (health === 'on') {
          reachNote.textContent = `${CHANNEL_NAMES[value]} is live, so this chat also reaches their phone.`;
        } else if (health === 'demo') {
          reachNote.textContent = `${CHANNEL_NAMES[value]} is only a demo on this computer, so nothing actually reaches their phone — the chat stays inside AirChat.`;
        } else {
          reachNote.textContent = `${CHANNEL_NAMES[value]} is not set up on this computer, so nothing actually reaches their phone — the chat stays inside AirChat.`;
        }
      };

      const via = choiceField(
        'Send over',
        [
          { value: 'imessage', label: 'iMessage', hint: 'Blue bubbles. Needs a Mac running BlueBubbles.' },
          { value: 'sms', label: 'SMS', hint: 'Reaches any phone. Twilio charges about a cent per text.' },
          { value: 'telegram', label: 'Telegram', hint: 'Free and unlimited. They need Telegram installed.' },
          { value: 'none', label: 'AirChat only', hint: 'No phone number needed at all.' },
        ],
        'sms',
        'You can change this per chat at any time.',
        describeReach
      );
      modal.appendChild(via.wrapper);
      modal.appendChild(reachNote);
      describeReach('sms');

      modalActions(modal, {
        primaryLabel: 'Start chat',
        onPrimary: async () => {
          const name = nameField.input.value.trim();
          const address = addressField.input.value.trim();
          const channel = via.value();

          if (channel !== 'none' && !address) {
            throw new Error(
              `${CHANNEL_NAMES[channel]} needs a phone number or email address. Choose "AirChat only" if you would rather not give one.`
            );
          }

          const result = await api('/api/conversations', {
            method: 'POST',
            body: {
              name,
              // An AirChat-only friend has no real address; give them a stable id.
              address: address || `airchat:${(name || 'friend').toLowerCase().replace(/\s+/g, '-')}`,
              channel: channel === 'none' ? 'sms' : channel,
              mirror: channel,
            },
          });

          closeModal();
          await refetch();

          // An AirChat-only chat is the one that can be encrypted, so give it a
          // key now - from the first message, not only when it is shared.
          if (channel === 'none' && result && result.conversation) {
            ensureKey(result.conversation.id);
          }

          if (result && result.conversation) openConversation(result.conversation.id);
        },
      });

      nameField.input.focus();
    });
  }

  /* ------------------------------------------------------------------ *
   * Modal: invite this chat
   * ------------------------------------------------------------------ */

  /**
   * Modal: add a friend to this chat.
   *
   * A code rather than a link. Six characters are easy to say out loud or paste
   * into a message, and the page they are typed into turns them back into where
   * this copy of AirChat is right now - so the friend never has to be sent an
   * address that changes every time the app starts.
   */
  function openInvite(conversationId) {
    const conversation = findConversation(conversationId);
    if (!conversation) return;

    openModal(async (modal) => {
      modal.appendChild(el('h3', null, `Add a friend to ${conversation.title}`));
      modal.appendChild(
        el(
          'p',
          'modal-sub',
          'Send them this code. They open the AirChat page and type it — nothing to install, no account.'
        )
      );

      const loading = el('span', 'hint', 'Making a code…');
      modal.appendChild(loading);

      // A chat that a phone network also carries cannot be encrypted, so it never
      // gets a key: that is what keeps the promise the chat header makes.
      const mirrored = Boolean(conversation.mirror && conversation.mirror !== 'none');
      const hadKey = Boolean(keyFor(conversationId));
      const key = mirrored ? '' : ensureKey(conversationId);
      // A key that did not exist a moment ago cannot be in anybody else's hands,
      // so the other side will not be able to read what is sent from now on until
      // they use this exact code.
      const brandNewKey = Boolean(key) && !hadKey;

      if (key && activeId) {
        const current = findConversation(activeId);
        if (current) renderChatHeader(current);
        renderMessages({});
      }

      const withKey = (url) =>
        key ? `${url}#k=${encodeURIComponent(key)}&c=${encodeURIComponent(conversationId)}` : url;

      const answer = await api('/api/conversations/invite', {
        method: 'POST',
        body: { conversationId, key },
      });

      const made = answer.code || {
        ok: false,
        reason: 'unavailable',
        detail: 'This copy of AirChat could not reach the friend code service.',
        page: '',
      };

      loading.remove();

      if (key) {
        openInvitePrivacy(modal, key);

        if (brandNewKey) {
          const them = conversation.isGroup ? 'Everyone in this chat' : conversation.title;
          const fresh = el('div', 'encrypted-note encrypted-warn');
          fresh.appendChild(el('strong', null, 'Send this new code now. '));
          fresh.appendChild(
            el(
              'span',
              null,
              `${them} cannot read what you send until they use this exact code — an older one ` +
                'carries nothing to unlock with. Messages from before now stay as they were.'
            )
          );
          modal.appendChild(fresh);
        }
      } else {
        const note = el('div', 'encrypted-note encrypted-warn');
        note.appendChild(el('strong', null, 'This chat is not end-to-end encrypted. '));
        note.appendChild(el('span', null, unencryptedReason(conversation)));
        modal.appendChild(note);
      }

      if (made.ok) {
        modal.appendChild(codeBox(made.code));

        const when = made.expiresAt ? new Date(made.expiresAt).toLocaleString() : '';
        modal.appendChild(
          el(
            'span',
            'hint',
            `They type it at ${made.page}. It keeps working until ${when} — or until this copy of AirChat closes.`
          )
        );

        const test = el('button', 'btn btn-quiet', 'Check this code');
        test.type = 'button';
        test.style.width = '100%';
        test.addEventListener('click', async () => {
          test.disabled = true;
          test.textContent = 'Checking…';
          const alive = await linkAnswers(`${made.page}/c/${made.code}`);
          test.disabled = false;
          test.textContent = 'Check this code';

          banner(
            alive
              ? 'That code found your app, so it should work for them too.'
              : 'That code did not answer. AirChat has to stay open for a code to find it.'
          );
        });
        modal.appendChild(test);
      } else {
        // No code means nothing here can reach past this Wi-Fi. Say what is
        // missing and offer the one thing that still works, rather than a code
        // that would fail in their hands.
        const why = el('div', 'encrypted-note encrypted-warn');
        why.appendChild(el('strong', null, 'No code right now. '));
        why.appendChild(
          el(
            'span',
            null,
            made.reason === 'no public link'
              ? 'A code only works while AirChat has a public link, and this copy does not have one, ' +
                  'so a friend on another network could not reach you.'
              : `${made.detail} Check your internet connection, then open this window again.`
          )
        );
        modal.appendChild(why);

        if (answer.guestUrl) {
          modal.appendChild(el('div', 'section-label', 'Or send them this link'));
          modal.appendChild(linkBox(withKey(answer.guestUrl)));
          modal.appendChild(
            el('span', 'hint', 'It only works on your Wi-Fi unless AirChat has a public link.')
          );
        }
      }

      if (key) {
        modal.appendChild(
          el(
            'span',
            'hint',
            'The code is the key: whoever uses it can read this chat, so send it only to them. ' +
              'Anyone else gets nothing but unreadable text.'
          )
        );
      }

      // The code is the password, so there has to be a way to change the lock.
      // Cancelling is instant: the server forgets the invite, and the cookie a
      // friend's phone kept is checked against that list on every request.
      const stop = el('button', 'btn btn-danger', 'Stop sharing this chat');
      stop.type = 'button';
      stop.style.width = '100%';
      stop.addEventListener('click', async () => {
        try {
          const result = await api('/api/conversations/uninvite', {
            method: 'POST',
            body: { conversationId },
          });

          banner(
            result.revoked
              ? `That code no longer opens ${conversation.title}. They would need a new one.`
              : 'Nothing to cancel - this chat has no code yet.'
          );
          closeModal();
        } catch (err) {
          banner(err.message);
        }
      });
      modal.appendChild(stop);
      modal.appendChild(
        el(
          'span',
          'hint',
          'Cancels the code. They keep anything they have already seen; whatever you send ' +
            'from now on is closed to them. Invite again for a new code.'
        )
      );

      const list = el('div', 'meta-list');
      const reachable = made.ok
        ? 'Anywhere, over the internet - through their code'
        : 'Only while on your Wi-Fi';
      list.appendChild(metaRow('Reachable', reachable));
      list.appendChild(metaRow('Same PC', withKey(answer.localGuestUrl)));
      if (made.ok) list.appendChild(metaRow('Code', made.code));

      modal.appendChild(el('div', 'section-label', 'Details'));
      modal.appendChild(list);

      modalActions(modal, {
        primaryLabel: 'Done',
        onPrimary: async () => {
          closeModal();
        },
      });
    });
  }

  /** The "this chat is protected" panel in the invite window. */
  function openInvitePrivacy(modal, key) {
    modal.appendChild(el('div', 'section-label', 'Privacy'));

    const note = el('div', 'encrypted-note');
    note.appendChild(el('strong', null, 'End-to-end encrypted. '));
    note.appendChild(
      el(
        'span',
        null,
        'Every message in this chat is locked in your browser and unlocked in theirs. ' +
          'This computer only ever stores and forwards the locked version — you can open ' +
          'data/airchat.json and see for yourself that it is unreadable there.'
      )
    );
    modal.appendChild(note);

    const code = el('span', 'lock-code', '…');
    const list = el('div', 'meta-list');
    list.appendChild(metaRow('Safety code', code));
    list.appendChild(
      metaRow('Check it', 'It shows in the chat header on both phones. If they match, nobody is in the middle.')
    );
    modal.appendChild(list);

    if (Crypto && Crypto.isAvailable()) {
      Crypto.fingerprint(key)
        .then((value) => {
          code.textContent = value;
        })
        .catch(() => {
          code.textContent = 'not available';
        });
    }
  }

  /** Why a chat cannot be encrypted, in plain words. */
  function unencryptedReason(conversation) {
    const mirror = conversation.mirror || 'none';

    if (mirror !== 'none') {
      return (
        `This chat is also sent by ${CHANNEL_NAMES[mirror] || mirror}, and a phone network has to be ` +
        'able to read whatever it carries. Set the chat to "AirChat only" to lock it, then invite again.'
      );
    }

    if (!Crypto) return 'The encryption file (crypto.js) did not load in this browser.';
    if (!Crypto.isAvailable()) {
      // Without crypto a chat that has a key cannot be sent to or read at all, so
      // promising that "it still works" would be a lie.
      return `${Crypto.unavailableReason()} Open the https link to use this chat.`;
    }

    return 'This browser is not locking messages for this chat.';
  }

  /* ------------------------------------------------------------------ *
   * Modal: chat menu
   * ------------------------------------------------------------------ */

  function openChatMenu(conversationId) {
    const conversation = findConversation(conversationId);
    if (!conversation) return;

    openModal((modal) => {
      modal.appendChild(el('h3', null, conversation.title));
      modal.appendChild(
        el('p', 'modal-sub', conversation.isGroup ? 'Group chat' : 'Direct chat')
      );

      const nameField = field('Rename', 'text', conversation.title);
      nameField.input.value = conversation.title;
      modal.appendChild(nameField.wrapper);

      const list = el('div', 'meta-list');
      const people = conversation.participants
        .map((person) =>
          `${person.name}${person.handles.length ? ` · ${person.handles[0].address}` : ''}`
        )
        .join(', ');
      list.appendChild(metaRow('People', people || 'Nobody yet'));
      modal.appendChild(list);

      modalActions(modal, {
        primaryLabel: 'Save name',
        onPrimary: async () => {
          await api('/api/conversations/rename', {
            method: 'POST',
            body: { conversationId, title: nameField.input.value },
          });
          closeModal();
          await refetch();
        },
      });

      const deleteButton = el('button', 'btn btn-danger', 'Delete this chat');
      deleteButton.type = 'button';
      deleteButton.style.marginTop = '10px';
      deleteButton.style.width = '100%';
      deleteButton.addEventListener('click', async () => {
        if (!window.confirm('Delete this chat and its messages? This cannot be undone.')) return;

        try {
          await api('/api/conversations/delete', {
            method: 'POST',
            body: { conversationId },
          });
          closeModal();
          activeId = null;
          await refetch();
          showList();
          renderChat();
        } catch (err) {
          banner(err.message);
        }
      });
      modal.appendChild(deleteButton);
    });
  }

  /* ------------------------------------------------------------------ *
   * Modal: settings
   * ------------------------------------------------------------------ */

  function openSettings() {
    openModal((modal) => {
      modal.appendChild(el('h3', null, 'AirChat settings'));
      modal.appendChild(
        el('p', 'modal-sub', 'AirChat runs entirely on this computer. Messages only leave it through the channels you switch on below.')
      );

      // ---- You ----
      const nameField = field('Your name', 'text', 'Your name', 'Shown on everything you send.');
      if (state.me.name && state.me.name !== 'You') nameField.input.value = state.me.name;
      modal.appendChild(nameField.wrapper);

      const saveName = async () => {
        const name = nameField.input.value.trim();
        if (!name) return;
        await api('/api/me', { method: 'POST', body: { name } });
        await refetch();
        banner('Name saved.');
      };

      nameField.input.addEventListener('blur', () => {
        saveName().catch((err) => banner(err.message));
      });
      nameField.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveName().catch((err) => banner(err.message));
        }
      });

      // ---- Alerts ----
      modal.appendChild(el('div', 'section-label', 'Alerts'));

      const permission = notificationPermission();
      const alertList = el('div', 'meta-list');
      alertList.appendChild(metaRow('Notifications', permissionLabel(permission)));
      alertList.appendChild(
        metaRow(
          'On a phone',
          isGuest ? 'Add this page to your home screen' : 'Send a friend code, then add it to the home screen'
        )
      );
      modal.appendChild(alertList);

      if (permission === 'default') {
        const enable = el('button', 'btn btn-primary', 'Turn on notifications');
        enable.type = 'button';
        enable.style.width = '100%';
        enable.style.marginTop = '10px';
        enable.addEventListener('click', async () => {
          try {
            await askForNotifications();
            closeModal();
            banner('Notifications are on.');
          } catch (err) {
            banner(err.message);
          }
        });
        modal.appendChild(enable);
      }

      // ---- Delivery ----
      // ---- Privacy ----
      modal.appendChild(el('div', 'section-label', 'Privacy & encryption'));

      const privacy = el('div', 'encrypted-note');
      privacy.appendChild(el('strong', null, 'Chats that stay inside AirChat are locked end to end. '));
      privacy.appendChild(
        el(
          'span',
          null,
          'The text of a message is encrypted in this browser before it is sent, and only the ' +
            'person you are talking to can unlock it. This computer, the file it writes to disk, ' +
            'and everything the message travels through only ever see unreadable text.\n\n' +
            'Chats sent by iMessage, SMS or Telegram cannot be encrypted, because a phone network ' +
            'has to be able to read what it carries. AirChat marks each chat so you can tell which ' +
            'is which.\n\n' +
            'A chat made before AirChat could lock anything, or one nobody has been invited to ' +
            'since, has no key yet - so nothing in it is locked. Its header says "Not encrypted ' +
            'yet" and offers to lock it; the key then travels with the next code you send.\n\n' +
            'The key to a chat lives in the browsers that share it. Nobody — including whoever runs ' +
            'this computer — can read that chat without it, and if every device with the key is lost, ' +
            'the messages cannot be recovered either.'
        )
      );
      modal.appendChild(privacy);

      const checkButton = el('button', 'btn btn-quiet', 'Run a security check');
      checkButton.type = 'button';
      checkButton.style.width = '100%';

      const checkResult = el('div', 'check-result hidden');

      checkButton.addEventListener('click', async () => {
        checkButton.disabled = true;
        checkResult.classList.remove('hidden');
        checkResult.textContent = 'Checking…';

        const outcome =
          Crypto && typeof Crypto.selfTest === 'function'
            ? await Crypto.selfTest()
            : { ok: false, lines: [], error: 'The encryption file (crypto.js) did not load.' };

        const lines = outcome.lines.map((line) => `✓ ${line}`);
        if (outcome.error) lines.push(`✗ ${outcome.error}`);
        lines.push('');
        lines.push(
          outcome.ok
            ? 'All good: this browser really does lock messages, and refuses ones that were tampered with.'
            : 'Something above failed, so this browser is not protecting messages as it should.'
        );

        checkResult.textContent = lines.join('\n');
        checkButton.disabled = false;
      });

      modal.appendChild(checkButton);
      modal.appendChild(checkResult);

      // ---- Delivery channels ----
      modal.appendChild(el('div', 'section-label', 'Delivery channels'));
      const bridgeList = el('div', 'meta-list');

      for (const bridge of state.bridges) {
        const health = bridgeHealth(bridge.channel);
        const key = el('span', 'meta-key');
        key.appendChild(el('span', `status-dot ${health}`));
        key.appendChild(el('span', null, bridge.label));

        const value = el('span', null, bridge.detail);
        if (health === 'off') value.className = 'muted';

        bridgeList.appendChild(metaRow(key, value));
      }

      modal.appendChild(bridgeList);
      modal.appendChild(
        el(
          'span',
          'hint',
          'Change these in config.json next to the AirChat folder, then restart AirChat.'
        )
      );

      // ---- Install ----
      // Nothing to install into: this is the app.
      if (!APP && !isInstalled()) {
        modal.appendChild(el('div', 'section-label', 'Get AirChat as an app'));

        const installButton = el('button', 'btn btn-quiet', 'How to add it to this device');
        installButton.type = 'button';
        installButton.style.width = '100%';
        installButton.addEventListener('click', () => {
          closeModal();
          showInstallCard();
        });
        modal.appendChild(installButton);
      }

      // ---- This server ----
      modal.appendChild(el('div', 'section-label', 'This server'));
      const serverList = el('div', 'meta-list');
      serverList.appendChild(metaRow('On this PC', state.server.localUrl));
      serverList.appendChild(metaRow('Same Wi-Fi', state.server.lanUrl));
      serverList.appendChild(
        metaRow(
          'Public link',
          state.server.publicUrl
            ? state.server.publicUrl
            : state.server.publicUrlExpired
              ? 'Expired - start AirChat + Public Link for a new one'
              : 'None - friends can only join on your Wi-Fi'
        )
      );
      serverList.appendChild(metaRow('Version', `AirChat ${state.server.version}`));
      modal.appendChild(serverList);

      modal.appendChild(el('div', 'section-label', 'Your full-access link'));
      modal.appendChild(
        el('span', 'hint', 'Anyone with this link gets the whole app, so only send it to yourself.')
      );
      modal.appendChild(linkBox(state.server.inviteUrl));

      // ---- Sample data ----
      modal.appendChild(el('div', 'section-label', 'Sample chats'));
      const clear = el('button', 'btn btn-quiet', 'Remove sample chats');
      clear.type = 'button';
      clear.style.width = '100%';
      clear.addEventListener('click', async () => {
        try {
          await api('/api/samples/clear', { method: 'POST', body: {} });
          closeModal();
          await refetch();
          banner('Sample chats removed.');
        } catch (err) {
          banner(err.message);
        }
      });
      modal.appendChild(clear);

      modalActions(modal, {
        primaryLabel: 'Done',
        onPrimary: async () => {
          closeModal();
        },
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Banner
   * ------------------------------------------------------------------ */

  function banner(message) {
    const box = $('banner');

    if (!message) {
      box.classList.add('hidden');
      if (bannerTimer) clearTimeout(bannerTimer);
      return;
    }

    $('banner-text').textContent = message;
    box.classList.remove('hidden');

    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => box.classList.add('hidden'), 5200);
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function applyGuestChrome() {
    // Called twice: once at boot, guessing from the URL, and again once the
    // server has told us the real role. So it has to be able to put the owner's
    // sidebar back when the guess was wrong, or an owner who opened a guest
    // link would be left staring at a blank sidebar with no way back.
    if (!isGuest) {
      $('sidebar').classList.remove('hidden');
      $('invite-btn').classList.remove('hidden');
      $('chat-menu').classList.remove('hidden');
      return;
    }

    $('sidebar').classList.add('hidden');
    $('invite-btn').classList.add('hidden');
    $('chat-menu').classList.add('hidden');
    $('back').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('chat').classList.remove('hidden');
    $('app').dataset.view = 'chat';
  }

  function wire() {
    $('new-chat').addEventListener('click', openNewChat);
    $('open-settings').addEventListener('click', openSettings);
    $('search').addEventListener('input', renderThreads);
    $('back').addEventListener('click', showList);
    $('invite-btn').addEventListener('click', () => activeId && openInvite(activeId));
    $('chat-menu').addEventListener('click', () => activeId && openChatMenu(activeId));
    $('banner-close').addEventListener('click', () => banner(null));
    $('modal-backdrop').addEventListener('click', closeModal);

    $('install-close').addEventListener('click', dismissInstallCard);

    $('install-go').addEventListener('click', async () => {
      const prompt = installPrompt;
      if (!prompt) return;

      hideInstallCard();
      try {
        prompt.prompt();
        await prompt.userChoice;
      } catch (err) {
        // If the prompt is refused, the manual steps are still on screen.
      }
      installPrompt = null;
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('modal-root').classList.contains('hidden')) closeModal();
    });

    const input = $('input');

    input.addEventListener('input', () => {
      autoGrow();
      broadcastTyping(true);
    });

    input.addEventListener('blur', () => broadcastTyping(false));

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    $('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage();
    });

    // Coming back to the tab means the unread badge in the list is now stale.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && activeId) markRead(activeId);
    });
  }

  /**
   * A browser exposes no crypto at all unless the address is secure: https, or
   * localhost. So a friend who opens http://192.168.4.58:4000 gets a page that
   * can neither lock what it sends nor read what it receives - the dead end
   * behind "This browser cannot encrypt, because the page is not on a secure
   * address".
   *
   * The server knows whether it has an https address that works (the Cloudflare
   * tunnel), so hand the visitor over to it rather than leaving them with an
   * explanation and no way out. The invite and the "#k=" key ride along
   * untouched: the key sits in the part of the URL a browser never sends to a
   * server, so it survives the trip and the chat stays locked.
   */
  function upliftToSecureAddress(next) {
    // The app is not a browser on a LAN address; nothing here applies to it.
    if (APP) return false;
    if (window.isSecureContext) return false;

    const server = (next && next.server) || {};
    const base = String(server.publicUrl || '').replace(/\/+$/, '');

    if (!/^https:\/\//i.test(base)) return false; // nothing to go to
    if (server.publicUrlExpired) return false; // it would not resolve anyway
    if (base === window.location.origin) return false; // already there

    // One attempt per address: if https somehow had no crypto either, bouncing
    // between the two would trap the browser in a reload loop.
    try {
      if (window.sessionStorage.getItem(UPLIFT_KEY) === base) return false;
      window.sessionStorage.setItem(UPLIFT_KEY, base);
    } catch (err) {
      // Storage refused. The origin check above already stops the loop.
    }

    const splashText = document.querySelector('.splash-text');
    if (splashText) splashText.textContent = 'Opening the secure link…';

    window.location.replace(`${base}/${window.location.search}${window.location.hash}`);
    return true;
  }

  async function boot() {
    // Before anything else: an invite link may be carrying this chat's key.
    captureKeyFromLink();

    // A home-screen shortcut can reopen "/" with no invite parameters at all.
    rememberAuth();
    if (restoreAuth()) return;

    wire();
    applyGuestChrome();
    registerServiceWorker();

    try {
      applyState(await api('/api/state'));
      $('app').dataset.view = isGuest ? 'chat' : 'list';
      connect();
      maybeOfferInstall();
    } catch (err) {
      $('splash').classList.add('hidden');

      const heading = document.querySelector('.blocked-card h1');
      if (err.status === 401) {
        heading.textContent = 'You need an invite link';
        $('blocked-detail').textContent =
          "This AirChat runs on someone's own computer, and only their invite link opens it.";
      } else {
        heading.textContent = 'AirChat could not start';
        $('blocked-detail').textContent = err.message;
      }

      $('blocked').classList.remove('hidden');
    }
  }

  boot();
})();
