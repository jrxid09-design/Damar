const { app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const { launchDamarCli } = require('./cli/launch-cli.cjs');
const { allowedNavigation, displayBounds, crashBudget } = require('./shell-policy.cjs');
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let savedBounds = null;
let isClosingConfirmed = false;
let cliFocusYielded = false;
let lastMouseIgnored = false;

const BRAND_ICON_PATH = path.join(__dirname, 'damaricon-clean.png');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const OFFLINE_PREVIEW = process.env.DAMAR_UI_OFFLINE_PREVIEW === '1';
const endpoint = require('../../src/r7r3/endpoint.cjs');
const RUNTIME_BASE_URL = process.env.DAMAR_UI_RUNTIME_URL || endpoint.origin;
const runtimeOrigin = new URL(RUNTIME_BASE_URL);
if (runtimeOrigin.origin !== endpoint.origin || runtimeOrigin.username || runtimeOrigin.password) {
  throw new Error('DAMAR desktop host only accepts the approved loopback endpoint '+endpoint.origin+'.');
}
let brandIcon = null;

function runtimeUrl(pathname) {
  const base = new URL(RUNTIME_BASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(base.hostname)) throw new Error('DAMAR_UI_RUNTIME_URL must be loopback.');
  if (!pathname.startsWith('/api/ui/')) throw new Error('Runtime route is not allowed.');
  return new URL(pathname, base).toString();
}

function runtimeError(error, status = 0, kind = null) {
  return { ok: false, error: { kind: kind || (status === 401 ? 'AUTH_FAILED' : status === 403 ? 'AUTH_FAILED' : status === 503 ? 'UNAVAILABLE' : status === 408 ? 'TIMEOUT' : 'UNKNOWN'), status, message: error } };
}

ipcMain.handle('damar-runtime-request', async (event, request) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return runtimeError('Runtime bridge unavailable.');
  const method = String(request?.method || 'GET').toUpperCase();
  const pathname = String(request?.path || '');
  const allowed = new Set([
    'GET /api/ui/approvals', 'GET /api/ui/missions', 'GET /api/ui/notifications',
    'GET /api/ui/presence/state', 'POST /api/ui/conversations/messages'
  ]);
  const conversationRead = method === 'GET' && /^\/api\/ui\/conversations\/dsc_[A-Za-z0-9_-]+$/.test(pathname);
  const notificationDismiss = method === 'POST' && /^\/api\/ui\/notifications\/[A-Za-z0-9_-]+\/dismiss$/.test(pathname);
  if (!allowed.has(`${method} ${pathname}`) && !conversationRead && !notificationDismiss) return runtimeError('Runtime operation is not allowed.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = { accept: 'application/json', 'x-request-id': `presence-${Date.now()}-${Math.random().toString(16).slice(2)}` };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (!OFFLINE_PREVIEW && process.env.DAMAR_TOKEN) headers.authorization = `Bearer ${process.env.DAMAR_TOKEN}`;
    const response = await fetch(runtimeUrl(pathname), { method, headers, body: request?.body === undefined ? undefined : JSON.stringify(request.body), signal: controller.signal });
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) return runtimeError(data?.error || data?.message || `HTTP ${response.status}`, response.status);
    return { ok: true, status: response.status, data };
  } catch (error) {
    return error?.name === 'AbortError' ? runtimeError('Runtime request timed out.', 408, 'TIMEOUT') : runtimeError('Runtime unavailable.', 0, 'UNAVAILABLE');
  } finally { clearTimeout(timer); }
});

ipcMain.handle('damar-navigate-surface', async (event, surface) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
   const allowed = { dashboard: '/cc2', mobile: '/mobile', presence: '/s/idle_presence?r9r2-demo=1' };
  if (!Object.prototype.hasOwnProperty.call(allowed, surface)) return false;
  const base = new URL(RUNTIME_BASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(base.hostname)) return false;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  await win.loadURL(new URL(allowed[surface], base).toString());
  return true;
});

function bringWindowToFront() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  if (win.isMinimized()) win.restore();
  if (savedBounds && !win.isMaximized()) win.setBounds(savedBounds);
  win.show();
  win.focus();
  win.moveTop();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  savedBounds = { x, y, width, height };

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    ...(brandIcon ? { icon: brandIcon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!allowedNavigation(url, runtimeOrigin.origin)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  const mayRecover = crashBudget();
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!win || win.isDestroyed() || isClosingConfirmed) return;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    if (mayRecover(details.reason)) win.webContents.reload();
    else console.error('DAMAR_RENDERER_RECOVERY_BLOCKED');
  });
   const initialUrl = new URL('/s/idle_presence?r9r2-demo=1', RUNTIME_BASE_URL);
   win.loadURL(initialUrl.toString());

   win.webContents.on('did-finish-load', () => {
     const area=screen.getPrimaryDisplay().workArea;
     savedBounds=displayBounds(area);
     win.setBounds(savedBounds);
     // Standby is non-activating. Deliberate Control navigation restores focus.
     if (['/cc2','/mobile'].includes(new URL(win.webContents.getURL()).pathname)) bringWindowToFront();
     else { win.setFocusable(false); win.showInactive(); }
   });

  const syncDisplay = () => {
    if (win && !win.isDestroyed() && !win.isMinimized()) {
        const display = screen.getPrimaryDisplay();
        const { x, y, width, height } = display.workArea;
       savedBounds = displayBounds({ x, y, width, height });
      win.setBounds(savedBounds);
    }
  };
  screen.on('display-metrics-changed', syncDisplay);
  screen.on('display-removed', syncDisplay);
  win.once('closed', () => {
    screen.removeListener('display-metrics-changed', syncDisplay);
    screen.removeListener('display-removed', syncDisplay);
    win = null;
  });

  win.on('restore', () => {
    bringWindowToFront();
    win.webContents.send('window-restored');
  });

  win.on('focus', () => {
    if (cliFocusYielded) {
      cliFocusYielded = false;
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  win.on('close', (e) => {
    if (!isClosingConfirmed) {
      e.preventDefault();
      win.setIgnoreMouseEvents(false);
      win.webContents.send('play-outro-before-close');
    }
  });
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  try {
    const image = nativeImage.createFromPath(BRAND_ICON_PATH);
    if (image.isEmpty()) throw new Error('Image is empty or unreadable');
    brandIcon = image;
  } catch (err) {
    console.warn('DAMAR icon could not be loaded; custom window/tray icons unavailable:', err.message);
  }
  createWindow();

  if (brandIcon) {
  try {
    tray = new Tray(brandIcon);
    tray.setToolTip('DAMAR Notch · Control');
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Tampilkan DAMAR Notch · Control (Alt+D)', click: () => bringWindowToFront() },
      { type: 'separator' },
      { label: 'Tutup Damar', click: () => { if (win) win.webContents.send('play-outro-before-close'); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => bringWindowToFront());
  } catch (err) {
    console.warn('DAMAR tray could not be initialized:', err.message);
  }
  }

  globalShortcut.register('Alt+D', () => {
    if (!win) return;
    if (new URL(win.webContents.getURL()).pathname !== '/s/idle_presence') {
      win.loadURL(new URL('/s/idle_presence',RUNTIME_BASE_URL).toString());
    } else if (win.isMinimized() || !win.isVisible()) {
      bringWindowToFront();
    } else {
      win.webContents.send('toggle-standby-orb');
    }
  });
});

ipcMain.handle('launch-damar-cli', async event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('CLI launch unavailable.');
  // Yield topmost ordering so the terminal can be seen; no dashboard surface changes.
  cliFocusYielded = true; win.setAlwaysOnTop(false);
  try { return await launchDamarCli(); }
  catch (error) {
    cliFocusYielded = false; win.setAlwaysOnTop(true, 'screen-saver');
    throw error;
  }
});

ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (!win || win.isDestroyed() || win.isMinimized() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  try {
    if (ignore) {
      win.setIgnoreMouseEvents(true, { forward: true });
      lastMouseIgnored = true;
    } else {
      win.setIgnoreMouseEvents(false);
      lastMouseIgnored = false;
    }
  } catch (e) {}
});

// Read-only DIP coordinates relative to this window, never arbitrary OS access.
ipcMain.handle('damar-cursor-point', event => {
  if (!win || win.isDestroyed() || win.isMinimized() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return null;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getContentBounds();
  const zoom = win.webContents.getZoomFactor();
  return { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom };
});

ipcMain.on('set-standby-mode', (event, standby) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  // A transparent, non-activating standby overlay must not steal focus from the
  // desktop. Deliberate pointer interaction is handled by the hit-test bridge.
  try { win.setFocusable(!Boolean(standby)); } catch {}
  if (!standby) win.setIgnoreMouseEvents(false);
});

ipcMain.on('window-control', (event, action) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  if (action === 'minimize') {
    win.setIgnoreMouseEvents(false);
    savedBounds = win.getBounds();
    win.minimize();
  } else if (action === 'maximize') {
    win.setIgnoreMouseEvents(false);
    if (savedBounds) win.setBounds(savedBounds);
  } else if (action === 'close') {
    win.setIgnoreMouseEvents(false);
    win.webContents.send('play-outro-before-close');
  } else if (action === 'force-close') {
    isClosingConfirmed = true;
    app.quit();
  }
});

app.on('second-instance', () => bringWindowToFront());
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Main-process diagnostics for the bounded desktop developer harness, never IPC.
module.exports = { getWindow: () => win, getMousePolicy: () => ({ ignored:lastMouseIgnored }) };
