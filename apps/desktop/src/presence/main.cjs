'use strict';
// DAMAR Idle Presence + Notch — Windows desktop host (Electron). Port of the Owner prototype
// C/ui-prototypes/w5/main.js with the demo flag and fixed prototype loopback path removed: state and presence.* config come from the
// DAMAR Core through core-presence.cjs (requester credential, GET-only allowlist). The one mutation is an Owner
// decision on a pending permission from the notch (IPC 'permission-decision'), authenticated here in main with the
// owner credential; the renderer never sees a credential and can only name the currently pending request.
// Usage: electron src/presence [--session "<Core session dir>"] [--profile "<CLI profile dir>"]
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut, nativeImage, protocol, shell, session } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const files = require('./renderer-files.cjs');
const policy = require('./host-policy.cjs'), { windowOptions, uiResponse } = policy;
const { createCorePresence, watchCore, resolveSessionDirectory, DEFAULTS } = require('./core-presence.cjs');
const { project, statusLine, pendingPermission, activityRows } = require('./projection.cjs');

const SELFTEST = process.env.DAMAR_PRESENCE_SELFTEST === '1'; // hidden window, prints security probe, exits
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const BRAND_ICON_PATH = path.join(__dirname, 'renderer', 'damaricon-clean.png');
const DAMAR_CMD = path.join(__dirname, '..', '..', 'damar.cmd');

protocol.registerSchemesAsPrivileged([{ scheme: files.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null, tray = null, savedBounds = null, isClosingConfirmed = false, cliFocusYielded = false, brandIcon = null;
let sessionDirectory = null, config = { source: 'defaults-not-loaded', ...DEFAULTS }, core = null, coreState = null, projection = project(null), lang = 'en';
let activityBaseline = null; // feed rows older than the first poll are history: not replayed as live ticker/emotes
const fromMain = event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
const pending = () => (projection.presence?.activity.pendingPermissions ? pendingPermission(coreState?.activity || []) : null);
const message = () => {
  const p = pending(), rows = activityRows((coreState?.activity || []).filter(a => activityBaseline !== null && a.seq >= activityBaseline), config.notificationPrivacy);
  return { config, view: { statusLine: statusLine(projection), status: projection.status, lifecycle: projection.presence?.lifecycle || null, lang,
    activity: { ...(projection.presence?.activity || {}), events: rows },
    // permissionId only; turnId stays in main (the renderer cannot target another turn).
    permission: p ? { permissionId: p.permissionId, tool: p.tool, file: p.file, added: p.added, removed: p.removed, allowable: p.allowable } : null } };
};
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('damar-presence', message()); };

const micAllowed = (wc, permission, mediaTypes) => policy.micAllowed({ voiceEnabled: config.voiceEnabled, permission, mediaTypes, ownWindow: !!win && wc === win.webContents });
function targetDisplay() {
  if (config.display !== 'primary') { const d = screen.getAllDisplays().find(x => String(x.id) === config.display); if (d) return d; }
  return screen.getPrimaryDisplay();
}
function fitToDisplay() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const { x, y, width, height } = targetDisplay().bounds;
  savedBounds = { x, y, width, height }; win.setBounds(savedBounds);
}

function bindCore() {
  const directory = resolveSessionDirectory({ session: arg('--session'), profile: arg('--profile') });
  if (!directory) return;
  try { core = createCorePresence({ sessionDirectory: directory }); sessionDirectory = directory; } catch { return; }
  watchCore(core, {
    onState: s => {
      coreState = s; projection = project(s, config);
      if (activityBaseline === null && s.reachable) activityBaseline = (s.activity || []).reduce((m, a) => Math.max(m, a.seq + 1), 0);
      push();
    },
    onSettings: s => { const moved = s.display !== config.display; config = s; projection = project(coreState, config); push(); if (moved) fitToDisplay(); },
    stateMs: 1000,
  });
  // UI language follows Core's shared cli.language (polled with the settings cadence; change-only push).
  const syncLang = () => core.language().then(l => { if (l !== lang) { lang = l; push(); } }).catch(() => {});
  syncLang(); setInterval(syncLang, 5000).unref?.();
}

ipcMain.handle('damar-runtime-request', (event, request) => (fromMain(event) ? uiResponse(request, projection) : { ok: false, error: { kind: 'NOT_ALLOWED', message: 'Runtime bridge unavailable.' } }));
ipcMain.handle('damar-presence-get', event => (fromMain(event) ? message() : null));
// Owner decision from the notch. Accepted only for the request Core currently reports as pending; Allow only where the
// notch shows the whole request (projection.pendingPermission.allowable). Core enforces Owner auth + first-wins.
ipcMain.handle('permission-decision', async (event, request) => {
  if (!fromMain(event) || !core) return { ok: false, error: 'NOT_ALLOWED' };
  const p = pending(), decision = String(request?.decision || '');
  if (!p || request?.permissionId !== p.permissionId) return { ok: false, error: 'PERMISSION_NOT_PENDING' };
  if (!['once', 'session', 'deny'].includes(decision) || (decision !== 'deny' && !p.allowable)) return { ok: false, error: 'DECISION_NOT_ALLOWED_FROM_NOTCH' };
  try { const r = await core.decide({ turnId: p.turnId, permissionId: p.permissionId, decision }); return { ok: r.ok, status: r.status, error: r.ok ? null : r.body?.error || 'HTTP_' + r.status }; }
  catch { return { ok: false, error: 'CORE_UNAVAILABLE' }; }
});
// Dashboard = DAMAR Control on the Core's own loopback origin (openControl: the `damar control` Owner launch URL).
ipcMain.handle('damar-navigate-surface', async (event, surface) => {
  if (!fromMain(event) || surface !== 'dashboard' || !core) return false;
  await openControl();
  return true;
});
ipcMain.handle('launch-damar-cli', async event => {
  if (!fromMain(event)) throw new Error('CLI launch unavailable.');
  if (process.platform !== 'win32' || /["\r\n]/.test(DAMAR_CMD)) throw new Error('DAMAR CLI launcher unavailable.');
  cliFocusYielded = true; win.setAlwaysOnTop(false); // let the terminal be seen (prototype main.js behaviour)
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "DAMAR CLI" "${DAMAR_CMD}"`], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
    child.once('error', e => { cliFocusYielded = false; win.setAlwaysOnTop(true, 'screen-saver'); reject(e); });
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return true;
});

// DAMAR Control (legacy CC2/UIX surfaces are retired by Core). Same Owner launch as `damar control`
// (src/control/launch.cjs controlUrl: credential only in the URL fragment); falls back to the bare /control/ page,
// which then asks for credentials. Called only on an explicit Owner click (gear, notch button, tray).
async function openControl() {
  if (!core) return false;
  let url;
  try { url = require('../control/launch.cjs').controlUrl(sessionDirectory); } catch { url = new URL('/control/', core.endpoint).toString(); }
  await shell.openExternal(url);
  return true;
}

function bringWindowToFront() {
  if (!win || win.isDestroyed() || SELFTEST) return;
  win.setIgnoreMouseEvents(false); win.setFocusable(true);
  if (win.isMinimized()) win.restore();
  if (savedBounds && !win.isMaximized()) win.setBounds(savedBounds);
  win.show(); win.focus(); win.moveTop(); win.setAlwaysOnTop(true, 'screen-saver');
}

function createWindow() {
  const { x, y, width, height } = targetDisplay().bounds;
  savedBounds = { x, y, width, height };
  win = new BrowserWindow(windowOptions({ bounds: savedBounds, icon: brandIcon, show: !SELFTEST }));
  win.setAlwaysOnTop(true, 'screen-saver');
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', e => e.preventDefault());
  wc.on('will-attach-webview', e => e.preventDefault());
  win.loadURL(files.ENTRY);
  wc.on('did-finish-load', () => { bringWindowToFront(); push(); if (SELFTEST) selfTest(); });
  screen.on('display-metrics-changed', fitToDisplay);
  win.on('restore', () => { bringWindowToFront(); wc.send('window-restored'); });
  win.on('focus', () => { if (cliFocusYielded) { cliFocusYielded = false; win.setAlwaysOnTop(true, 'screen-saver'); } });
  win.on('close', e => { if (!isClosingConfirmed && !SELFTEST) { e.preventDefault(); win.setIgnoreMouseEvents(false); wc.send('play-outro-before-close'); } });
}

async function selfTest() {
  const wc = win.webContents, prefs = wc.getLastWebPreferences?.() || {};
  const probe = await wc.executeJavaScript(`(async () => ({
    require: typeof require, process: typeof process, bridge: Object.keys(window.damarDesktop || {}).sort(),
    fetchBlocked: await fetch('http://127.0.0.1:1/').then(() => false, () => true),
    island: typeof window.__DAMAR_ISLAND__?.configure, notchState: window.__DAMAR_ISLAND__?.getState?.(),
    status: document.querySelector('#damarIsland .di-status')?.textContent || null,
    configSource: document.body.dataset.presenceConfigSource || null,
    deniedPost: await window.damarDesktop.runtimeRequest({ path: '/api/ui/conversations/messages', method: 'POST' })
  }))()`).catch(e => ({ error: String(e.message) }));
  // Real-renderer lifecycle scenario (shortened orb window, Owner morph 620 ms): orb -> morph -> compact, no timed
  // auto-hide, voice yields to orb and returns, pointer-leave hides and the orb stays hidden.
  const island = await wc.executeJavaScript(`(async () => {
    const I = window.__DAMAR_ISLAND__, sleep = ms => new Promise(r => setTimeout(r, ms)), t0 = performance.now(), log = [];
    addEventListener('damar-island-state', e => log.push([e.detail.from, e.detail.to, Math.round(performance.now() - t0)]));
    const orbOpacity = () => Number(getComputedStyle(document.getElementById('siriOrbDock')).opacity);
    // Event/condition waits instead of fixed sleeps (deterministic under load); the fixed sleeps that remain are
    // deliberate hold windows proving that nothing changes on its own (no timed auto-hide, voice holds the orb).
    const until = async (cond, ms) => { const end = performance.now() + ms; while (!cond()) { if (performance.now() > end) return false; await sleep(25); } return true; };
    const state = s => () => I.getState() === s;
    I.configure({ idleToNotchMs: 1000, morphMs: 620, notchEnabled: true });
    document.body.classList.add('siri-dock-active');
    await until(state('compact'), 8000); const afterMorph = I.getState();
    await sleep(3000); const afterWait = I.getState();
    I.voiceStart(); await until(state('orb'), 3000); const voiceState = I.getState(), voiceOrbOpacityTarget = document.body.dataset.islandNotch || null;
    await sleep(1500); const voiceHeld = I.getState();
    I.voiceEnd(); await until(state('compact'), 8000); const afterVoice = I.getState();
    I.fsm.pointerLeft(); await until(state('hidden'), 3000);
    // The orb must reach opacity 0 (CSS transition may be throttled under load) and then stay there.
    await until(() => orbOpacity() === 0, 5000); await sleep(700);
    const afterLeave = I.getState(), orbAfterLeave = orbOpacity();
    // A Mata Dewa watchlist alert peeks the hidden notch to compact and never expands it on its own.
    dispatchEvent(new CustomEvent('damar-presence-activity', { detail: { seq: 1e9, kind: 'alert', source: 'mata-dewa', label: 'Gate cam · watchlist match' } }));
    await until(state('compact'), 3000); await sleep(700); const alertPeek = I.getState();
    I.reveal(); await until(state('compact'), 3000); I.fsm.pointerEntered(); await until(state('expanded'), 3000);
    { const el = document.getElementById('damarIsland'); let last = -1; await until(() => { const h = Math.round(el.getBoundingClientRect().height); const stable = h === last && h >= 150; last = h; return stable; }, 5000); }
    const box = document.getElementById('damarIsland').getBoundingClientRect(), st = document.querySelector('#damarIsland .di-status').getBoundingClientRect(),
      ctl = document.querySelector('#damarIsland .di-controls').getBoundingClientRect();
    const expandedFit = { state: I.getState(), islandBottom: Math.round(box.bottom), statusBottom: Math.round(st.bottom), controlsBottom: Math.round(ctl.bottom), statusVisible: st.height > 0 && st.bottom <= box.bottom, controlsVisible: ctl.height > 0 && ctl.bottom <= box.bottom + 0.5 };
    I.fsm.pointerLeft(); I.fsm.pointerLeft();
    I.configure({ notchEnabled: false }); await until(state('orb'), 3000); const disabled = I.getState(); await sleep(1500); const disabledHeld = I.getState();
    await sleep(300);
    return { log, afterMorph, afterWait, voiceState, voiceOrbOpacityTarget, voiceHeld, afterVoice, afterLeave, orbAfterLeave, alertPeek, disabled, disabledHeld, expandedFit,
      motion: { reduced: window.__DAMAR_MOTION__?.reduced(), parked: window.__DAMAR_MOTION__?.parkedCount() },
      fonts: { cinzel: document.fonts.check('600 16px "Cinzel"'), decorative: document.fonts.check('700 16px "Cinzel Decorative"'), loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family) },
      greeting: document.getElementById('greetingTitle')?.textContent || null,
      lang: document.documentElement.lang, mic: document.getElementById('damarIsland').dataset.mic || null,
      workspaceLabel: (() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.nodeValue.trim(); if (/^(Main Workspace|Ruang Kerja Utama)$/i.test(t)) return t; } return null; })(),
      reducedMotionClass: document.documentElement.classList.contains('damar-reduced-motion'), settingsPopoverDisplay: getComputedStyle(document.getElementById('settingsPopover')).display };
  })()`).catch(e => ({ error: String(e.message) }));
  process.stdout.write('PRESENCE_SELFTEST ' + JSON.stringify({ webPreferences: { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity },
    window: { alwaysOnTop: win.isAlwaysOnTop() }, probe, island, projectionStatus: projection.status, configSource: config.source,
    mic: { audio: micAllowed(wc, 'media', ['audio']), video: micAllowed(wc, 'media', ['video']), audioVideo: micAllowed(wc, 'media', ['audio', 'video']), notifications: micAllowed(wc, 'notifications', []), voiceEnabled: config.voiceEnabled } }) + '\n');
  isClosingConfirmed = true; app.exit(0);
}

app.whenReady().then(() => {
  protocol.handle(files.SCHEME, request => {
    const r = files.resolve(request.url);
    return new Response(r.body || null, { status: r.status, headers: r.status === 200 ? { ...files.HEADERS, 'content-type': r.type } : files.HEADERS });
  });
  // Device permissions: none, except the microphone (audio only, never video) when the Owner opted in through Core
  // (presence.voiceEnabled = true, default false). The notch shows a mic indicator while it is on.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(micAllowed(wc, permission, details?.mediaTypes)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => micAllowed(wc, permission, details?.mediaType ? [details.mediaType] : ['audio']));
  try { const image = nativeImage.createFromPath(BRAND_ICON_PATH); if (!image.isEmpty()) brandIcon = image; } catch {}
  bindCore();
  createWindow();
  if (brandIcon && !SELFTEST) {
    try {
      tray = new Tray(brandIcon);
      tray.setToolTip('DAMAR Presence');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Buka Dashboard Damar (Alt+D)', click: () => bringWindowToFront() },
        { label: 'Open DAMAR Control', click: () => { openControl().catch(() => {}); } },
        { type: 'separator' },
        { label: 'Tutup Damar', click: () => { if (win) win.webContents.send('play-outro-before-close'); } },
      ]));
      tray.on('click', () => bringWindowToFront());
    } catch (err) { console.warn('DAMAR tray could not be initialized:', err.message); }
  }
  if (!SELFTEST) globalShortcut.register('Alt+D', () => {
    if (!win) return;
    if (win.isMinimized() || !win.isVisible()) bringWindowToFront(); else win.webContents.send('toggle-standby-orb');
  });
});

ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (!fromMain(event) || win.isMinimized()) return;
  try { if (ignore) win.setIgnoreMouseEvents(true, { forward: true }); else win.setIgnoreMouseEvents(false); } catch {}
});
ipcMain.on('set-standby-mode', (event, standby) => {
  if (!fromMain(event)) return;
  // Non-activating standby overlay: must not steal focus from the Owner's desktop (prototype main.js:209-215).
  try { win.setFocusable(!standby); } catch {}
  if (!standby) win.setIgnoreMouseEvents(false);
});
ipcMain.on('window-control', (event, action) => {
  if (!fromMain(event)) return;
  if (action === 'minimize') { win.setIgnoreMouseEvents(false); savedBounds = win.getBounds(); win.minimize(); }
  else if (action === 'maximize') { win.setIgnoreMouseEvents(false); if (savedBounds) win.setBounds(savedBounds); }
  else if (action === 'close') { win.setIgnoreMouseEvents(false); win.webContents.send('play-outro-before-close'); }
  else if (action === 'force-close') { isClosingConfirmed = true; app.quit(); }
});
app.on('web-contents-created', (_e, contents) => contents.on('will-navigate', e => e.preventDefault()));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
