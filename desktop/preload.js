'use strict';

/**
 * What the interface is allowed to know about the app it is running in.
 *
 * AirChat is one interface serving two very different hosts: a browser someone
 * reached through an invite link, and the desktop app on the owner's own
 * machine. A few things are genuinely different and the interface has to know
 * which one it is on, because telling a person to "add AirChat to your home
 * screen" from inside the installed app is nonsense, and a service worker
 * caching the app's own files underneath it causes nothing but confusion.
 *
 * The bridge is deliberately one small frozen object with no functions: a flag,
 * a version and a platform. Nothing here can be used from a page that is not
 * our own, and nothing here can do anything. It is a fact, not a capability.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so this file runs in an
 * isolated world and the only thing that crosses into the page is the object
 * below.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Tell the app's log what the window is doing.
 *
 * A window that closes itself leaves no trace at all from this side - the main
 * process only sees "a close was requested" - so the one thing that can explain
 * it, the caller's stack, is sent to the log. It is also used to report a page
 * error, so a broken interface says so instead of going quiet.
 */
function note(message) {
  try {
    ipcRenderer.send('airchat:note', String(message).slice(0, 500));
  } catch (err) {
    // Reporting must never be the thing that fails.
  }
}

// Called before the page's own scripts run, so nothing can close the window
// without being named.
const originalClose = window.close.bind(window);
window.close = function airchatClose() {
  note(`window.close() called from ${new Error('why').stack.split('\n').slice(1, 4).join(' | ')}`);
  return originalClose();
};

window.addEventListener('error', (event) => {
  note(`page error: ${event.message} at ${event.filename}:${event.lineno}`);
});

window.addEventListener('unhandledrejection', (event) => {
  note(`unhandled rejection: ${(event.reason && event.reason.message) || event.reason}`);
});

/**
 * The version, handed down rather than read.
 *
 * This file runs in a sandboxed renderer, where `require` only reaches Electron
 * itself - `require('../package.json')` there silently fails and the version
 * comes out as 0.0.0. The main process can read the file, so it passes the value
 * in the window's own arguments instead (see createWindow).
 */
const version =
  (process.argv.find((argument) => argument.startsWith('--airchat-version=')) || '').split('=')[1] ||
  '0.0.0';

contextBridge.exposeInMainWorld(
  'airchatApp',
  Object.freeze({
    isApp: true,
    version,
    platform: process.platform,
    /**
     * The app is its own host: no service worker to register, no address-bar
     * install prompt, no plain-http browser to hand over to an https link.
     */
    browserOnlyFeatures: false,
  })
);
