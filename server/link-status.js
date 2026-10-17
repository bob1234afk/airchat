'use strict';

/**
 * Whether AirChat can be reached from outside this computer - as one fact.
 *
 * Three different things need to agree on this: the app, which owns the tunnel;
 * the server, which builds invite links and friend codes out of it; and the
 * interface, which has to say something true in the Invite window. They all run
 * in one process, so a tiny shared record is enough, and it stops each of them
 * inventing its own half-answer ("no public link" when the truth is "still
 * starting" - which is the difference between a broken app and one that needs
 * three more seconds).
 *
 * The states are deliberately about *the person's situation*, not about
 * cloudflared:
 *
 *   idle        nothing has tried yet (a plain `node server/index.js`)
 *   starting    a tunnel is being opened right now
 *   ready       there is a public address, recorded in config.json
 *   retrying    it worked, or nearly did, and AirChat is trying again by itself
 *   unavailable it cannot work right now, and retrying will not help without a
 *               change (no cloudflared, no internet) - so the interface can say
 *               what is missing instead of offering a code that would fail
 */

const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  RETRYING: 'retrying',
  UNAVAILABLE: 'unavailable',
};

const current = {
  state: STATE.IDLE,
  url: '',
  detail: '',
  since: Date.now(),
};

/** Replace the record. Returns what was stored, so callers can log one thing. */
function set(next) {
  const value = next || {};

  current.state = Object.values(STATE).includes(value.state) ? value.state : STATE.IDLE;
  current.url = String(value.url || '');
  current.detail = String(value.detail || '');
  current.since = Number(value.since) || Date.now();

  return get();
}

/** A copy, so a caller poking at it cannot change the truth for everyone else. */
function get() {
  return { ...current };
}

/**
 * The short form for the interface's Details list.
 *
 * Written as a sentence a person can act on rather than a status code: "Anywhere
 * over the internet" is the promise a friend code keeps, and "Only your Wi-Fi" is
 * what is true when it cannot.
 */
function summary() {
  switch (current.state) {
    case STATE.READY:
      return 'Anywhere over the internet';
    case STATE.STARTING:
      return 'Setting it up now - a few seconds';
    case STATE.RETRYING:
      return 'Dropped; trying again by itself';
    case STATE.UNAVAILABLE:
      return current.detail || 'Only on your Wi-Fi right now';
    default:
      return 'Only on your Wi-Fi';
  }
}

module.exports = { STATE, set, get, summary };
