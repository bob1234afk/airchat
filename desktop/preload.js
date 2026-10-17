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

const { contextBridge } = require('electron');

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
