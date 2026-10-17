'use strict';

/**
 * AirChat as a real desktop window (Windows and macOS).
 *
 * Electron is optional: the app runs perfectly well in a browser, and this file
 * exists so it can also feel like an app you own. It reuses the exact same
 * server, so there is no second implementation to keep in sync.
 *
 * Behaviour worth knowing:
 *   - If AirChat is already running on the port, this just opens a window onto
 *     it instead of failing with EADDRINUSE.
 *   - Links inside messages open in your normal browser, never in the app.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

// The window *is* the interface, so do not also pop open a browser tab.
process.env.AIRCHAT_NO_BROWSER = '1';

const ROOT = path.join(__dirname, '..');

let mainWindow = null;

/** Read the port straight out of config.json so both agree without starting up. */
function configuredPort() {
  const fromEnv = Number(process.env.AIRCHAT_PORT || process.env.PORT || 0);
  if (fromEnv) return fromEnv;

  try {
    const configPath = path.join(ROOT, 'config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && Number(parsed.port)) return Number(parsed.port);
    }
  } catch (err) {
    // A broken config.json gets a clear error from the server; use the default.
  }

  return 4000;
}

const PORT = configuredPort();
const BASE_URL = `http://localhost:${PORT}`;

function pingServer() {
  return new Promise((resolve) => {
    const request = http.get(`${BASE_URL}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });

    request.on('error', () => resolve(false));
    request.setTimeout(1200, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await pingServer()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

function startServer() {
  // The very same server the browser version uses, in this process.
  require(path.join(ROOT, 'server', 'index.js'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 430,
    minHeight: 540,
    backgroundColor: '#08090d',
    title: 'AirChat',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`${BASE_URL}/`);
}

async function boot() {
  const alreadyRunning = await pingServer();

  if (!alreadyRunning) {
    try {
      startServer();
    } catch (err) {
      dialog.showErrorBox('AirChat could not start', err.message);
      app.quit();
      return;
    }

    if (!(await waitForServer(8000))) {
      dialog.showErrorBox(
        'AirChat could not start',
        `Nothing answered on ${BASE_URL} after starting the server.\n\nTry running "node server/index.js" in a terminal to see the error.`
      );
      app.quit();
      return;
    }
  }

  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // AirChat draws its own UI, so the default menu bar adds nothing on Windows.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    boot();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
