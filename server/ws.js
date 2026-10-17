'use strict';

/**
 * A tiny, dependency-free WebSocket server (RFC 6455).
 *
 * AirChat ships with no npm dependencies on purpose: the whole point is that you
 * can clone it, run `node server/index.js`, and be talking to a friend a minute
 * later. This file is the only piece that would otherwise want a library.
 *
 * It handles the upgrade handshake, frame decoding (including fragmented and
 * masked client frames), control frames, and size limits. It deliberately does
 * not implement permessage-deflate, since nothing here sends large payloads.
 */

const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB per message is far more than we need.

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Encode one unmasked (server-to-client) frame. */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = body.length;
  let header;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, body]);
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.finished = false;
    this.fragmentOpcode = 0;
    this.fragments = [];
    this.handlers = { message: [], close: [] };

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._finish());
    socket.on('close', () => this._finish());
  }

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  _emit(event, ...args) {
    for (const handler of this.handlers[event] || []) {
      try {
        handler(...args);
      } catch (err) {
        // One throwing listener must not take down the socket or the hub.
        console.error(`[ws] listener for "${event}" threw:`, err);
      }
    }
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    try {
      for (;;) {
        const frame = this._readFrame();
        if (!frame) break;
        this._handleFrame(frame);
        if (this.closed) break;
      }
    } catch (err) {
      console.error('[ws] frame decode failed:', err.message);
      this.close(1002, 'protocol error');
    }
  }

  /** Returns a complete frame, or null when we need more bytes. */
  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const first = buf[0];
    const second = buf[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;

    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const wide = buf.readBigUInt64BE(offset);
      offset += 8;
      if (wide > BigInt(MAX_MESSAGE_BYTES)) {
        this.close(1009, 'message too big');
        return null;
      }
      length = Number(wide);
    }

    if (length > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too big');
      return null;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + length) return null;

    const payload = Buffer.allocUnsafe(length);
    buf.copy(payload, 0, offset, offset + length);
    if (mask) {
      for (let i = 0; i < length; i += 1) payload[i] ^= mask[i & 3];
    }

    // Copy out the remainder so we do not pin the whole chunk in memory.
    this.buffer = Buffer.from(buf.subarray(offset + length));
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OPCODE.CLOSE) {
      this.close(1000, '');
      return;
    }

    if (opcode === OPCODE.PING) {
      this._write(encodeFrame(OPCODE.PONG, payload));
      return;
    }

    if (opcode === OPCODE.PONG) return;

    if (opcode === OPCODE.CONTINUATION) {
      if (!this.fragmentOpcode) return;
      this.fragments.push(payload);
      if (!fin) return;

      const whole = Buffer.concat(this.fragments);
      const kind = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;

      if (kind === OPCODE.TEXT) this._emit('message', whole.toString('utf8'));
      return;
    }

    if (opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) return;

    if (fin) {
      if (opcode === OPCODE.TEXT) this._emit('message', payload.toString('utf8'));
      return;
    }

    this.fragmentOpcode = opcode;
    this.fragments = [payload];
  }

  _write(buf) {
    if (this.closed || !this.socket.writable) return;
    this.socket.write(buf);
  }

  /** Send a JSON-serialisable value as a text frame. */
  send(value) {
    this.sendRaw(typeof value === 'string' ? value : JSON.stringify(value));
  }

  sendRaw(text) {
    this._write(encodeFrame(OPCODE.TEXT, text));
  }

  /**
   * Feed bytes that arrived in the same packet as the upgrade request. A client
   * is entitled to start sending frames immediately, so those bytes must not be
   * thrown away with the HTTP request that carried them.
   */
  seed(bytes) {
    if (bytes && bytes.length) this._onData(bytes);
  }

  ping() {
    this._write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;

    if (this.socket.writable) {
      const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      if (reason) payload.write(reason, 2, 'utf8');
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload));
    }

    this.socket.end();
  }

  destroy() {
    this.closed = true;
    this.socket.destroy();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this._emit('close');
  }
}

/**
 * Complete the upgrade handshake and hand back a Connection.
 * Returns null (and writes a 400) when the request is not a valid WS upgrade.
 */
function handleUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];

  if (!key || String(version) !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n')
  );

  const connection = new Connection(socket);
  connection.seed(head);
  return connection;
}

module.exports = { handleUpgrade, encodeFrame, acceptKey, Connection, OPCODE, MAX_MESSAGE_BYTES };
