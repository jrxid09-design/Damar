'use strict';
// DAMAR Idle Presence + Notch — Windows desktop host (Electron). Port of the Owner prototype
// C/ui-prototypes/w5/main.js with the demo flag and fixed prototype loopback path removed: state and presence.* config come from the
// DAMAR Core through core-presence.cjs (requester credential, GET-only allowlist). Mutations are Owner-authenticated
// here in main with the owner credential: a decision on a pending permission from the notch (IPC 'permission-decision')
// and the first-run onboarding writes (IPC 'damar-onboarding-*'); the renderer never sees a credential.
// Usage: electron src/presence [--session "<Core session dir>"] [--profile "<CLI profile dir>"]
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut, nativeImage, protocol, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { coreEndpoint } = require('../cli/core-endpoint.cjs');
const { spawn } = require('node:child_process');
const files = require('./renderer-files.cjs');
const policy = require('./host-policy.cjs'), { windowOptions, uiResponse } = policy;
const { createCorePresence, watchCore, resolveSessionDirectory, DEFAULTS } = require('./core-presence.cjs');
const { project, statusLine, pendingPermission, activityRows, projectWorkers } = require('./projection.cjs');

const SELFTEST = process.env.DAMAR_PRESENCE_SELFTEST === '1'; // hidden window, prints security probe, exits
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const BRAND_ICON_PATH = path.join(__dirname, 'renderer', 'damaricon-clean.png');
const DAMAR_CMD = path.join(__dirname, '..', '..', 'damar.cmd');
// Damar Notch 3D stage model (the Owner's final base character). The renderer cannot fetch
// (CSP connect-src 'none'; scheme registered with supportFetchAPI:false), so the bytes cross
// on this one fixed IPC channel, read once and cached. No path input from the renderer.
const NOTCH3D_MODEL_PATH = path.join(__dirname, 'renderer', 'argon-assets', 'visuals', 'notch-3d', 'damar-notch-base-3d.glb');
let notch3dModelCache = null;

protocol.registerSchemesAsPrivileged([{ scheme: files.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null, tray = null, savedBounds = null, isClosingConfirmed = false, cliFocusYielded = false, brandIcon = null;
let sessionDirectory = null, config = { source: 'defaults-not-loaded', ...DEFAULTS }, core = null, coreState = null, projection = project(null), lang = 'en', watcher = null;
let activityBaseline = null; // feed rows older than the first poll are history: not replayed as live ticker/emotes
let permDetail = { id: null, detail: null }; // owner-credential command detail for the pending permission (renderer feed redacts it)
let histCache = { at: 0, rows: [] }; // approval history for the Authority surface (owner read, 10 s cache)
let workersCache = { at: 0, rows: [] }; // notch worker rows: Pandawa runs (snapshot) + gateway agents (owner read, 5 s cache)
const fromMain = event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
const pending = () => (projection.presence?.activity.pendingPermissions ? pendingPermission(coreState?.activity || []) : null);
const message = () => {
  const p = pending(), rows = activityRows((coreState?.activity || []).filter(a => activityBaseline !== null && a.seq >= activityBaseline), config.notificationPrivacy);
  return { config, view: { statusLine: statusLine(projection), status: projection.status, lifecycle: projection.presence?.lifecycle || null, lang,
    activity: { ...(projection.presence?.activity || {}), events: rows },
    sessionPills: projection.presence?.sessionPills || [], workers: workersCache.rows, media: projection.presence?.media || null, pcActivity: pcActivitySnapshot(),
    // permissionId only; turnId stays in main (the renderer cannot target another turn).
    permission: p ? { permissionId: p.permissionId, tool: p.tool, file: p.file, detail: p.detail || (permDetail.id === p.permissionId ? permDetail.detail : null), added: p.added, removed: p.removed, allowable: p.allowable } : null,
    approvalHistory: histCache.rows } };
};

// PC activity sense for the Notch behavior engine (Fase 2 v3): ONE fixed
// PowerShell probe (no caller input) - foreground process, window size,
// input idle time - categorized generically here. Failures report null and
// the character simply receives no PC signals.
const PC_PROBE = "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);public struct R{public int L;public int T;public int Rr;public int B;}[DllImport(\"user32.dll\")]public static extern bool GetLastInputInfo(ref L l);public struct L{public uint cb;public uint t;}}'; $h=[W]::GetForegroundWindow(); $fp=0; [W]::GetWindowThreadProcessId($h,[ref]$fp) | Out-Null; $pr=Get-Process -Id $fp -ErrorAction SilentlyContinue; $r=New-Object W+R; [W]::GetWindowRect($h,[ref]$r) | Out-Null; $li=New-Object W+L; $li.cb=[Runtime.InteropServices.Marshal]::SizeOf($li); [W]::GetLastInputInfo([ref]$li) | Out-Null; $idle=[Environment]::TickCount-$li.t; @{proc=$pr.ProcessName; w=$r.Rr-$r.L; h=$r.B-$r.T; idleMs=$idle} | ConvertTo-Json -Compress";
const PC_CATEGORIES = [[/code|devenv|idea|webstorm|pycharm|sublime|notepad\+\+/i, 'code'], [/photoshop|illustrator|figma|blender|premiere|afterfx|davinci|krita|gimp/i, 'design'], [/powershell|windowsterminal|cmd|putty|mobaxterm|regedit/i, 'engineering'], [/burp|ghidra|wireshark/i, 'security'], [/spotify|vlc|wmplayer|plex/i, 'media']];
let pcCache = { at: 0, value: null };
function pcActivitySnapshot() {
  const nowMs = Date.now();
  if (nowMs - pcCache.at >= 2000) {
    pcCache.at = nowMs;
    try {
      require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-Command', PC_PROBE], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        if (err) { pcCache.value = null; return; }
        try {
          const raw = JSON.parse(String(stdout).trim().split('\n').pop());
          const proc = String(raw.proc || '');
          const hit = PC_CATEGORIES.find(([re]) => re.test(proc));
          const disp = targetDisplay().bounds;
          pcCache.value = { category: hit ? hit[1] : 'other', idleMs: Math.max(0, Number(raw.idleMs) || 0), fullscreen: Math.abs((Number(raw.w) || 0) - disp.width) <= 2 && Math.abs((Number(raw.h) || 0) - disp.height) <= 2 };
        } catch { pcCache.value = null; }
      });
    } catch { pcCache.value = null; }
  }
  return pcCache.value;
}
const push = () => { if (win && !win.isDestroyed()) win.webContents.send('damar-presence', message()); };

const micAllowed = (wc, permission, mediaTypes) => policy.micAllowed({ voiceEnabled: config.voiceEnabled, permission, mediaTypes, ownWindow: !!win && wc === win.webContents });
function targetDisplay() {
  if (config.display !== 'primary') { const d = screen.getAllDisplays().find(x => String(x.id) === config.display); if (d) return d; }
  return screen.getPrimaryDisplay();
}
function fitToDisplay() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  // Work area, not full bounds (Owner 2026-11-27): bottom-anchored Presence elements (the standby orb)
  // must sit fully above the Windows taskbar, never cropped by it.
  const { x, y, width, height } = targetDisplay().workArea;
  savedBounds = { x, y, width, height }; win.setBounds(savedBounds);
}

function bindCore() {
  const directory = resolveSessionDirectory({ session: arg('--session'), profile: arg('--profile') });
  if (!directory) return;
  try { core = createCorePresence({ sessionDirectory: directory }); sessionDirectory = directory; } catch { return; }
  watcher = watchCore(core, {
    onState: s => {
      coreState = s; projection = project(s, config);
      if (activityBaseline === null && s.reachable) activityBaseline = (s.activity || []).reduce((m, a) => Math.max(m, a.seq + 1), 0);
      push();
      // Approval history (owner read, cached): the Authority surface's record.
      if (core && Date.now() - histCache.at > 10000) { histCache.at = Date.now(); core.approvalHistory().then(rows => { if (Array.isArray(rows)) { histCache.rows = rows; push(); } }).catch(() => {}); }
      // Notch worker rows (Coucou agent parity): Pandawa runs come from the
      // snapshot already in hand; gateway-connected agents need the owner
      // read, cached at 5 s like the approval history at 10 s.
      if (core && Date.now() - workersCache.at > 5000) { workersCache.at = Date.now(); core.gatewayView().then(gw => { workersCache.rows = projectWorkers(coreState?.runs || [], gw, config.notificationPrivacy); push(); }).catch(() => {}); }
      // Enrich the pending permission with its command detail (owner read).
      const p = pending();
      if (p && !p.detail && permDetail.id !== p.permissionId) {
        permDetail = { id: p.permissionId, detail: null };
        core.permissionDetail(p.permissionId).then(d => { if (d && permDetail.id === p.permissionId) { permDetail.detail = d; push(); } }).catch(() => {});
      } else if (!p && permDetail.id) permDetail = { id: null, detail: null };
    },
    onSettings: s => { const moved = s.display !== config.display; config = s; projection = project(coreState, config); push(); if (moved) fitToDisplay(); },
    stateMs: 1000,
  });
  // UI language follows Core's shared cli.language (polled with the settings cadence; change-only push).
  const syncLang = () => core.language().then(l => { if (l !== lang) { lang = l; push(); } }).catch(() => {});
  syncLang(); setInterval(syncLang, 5000).unref?.();
  // Control's "show Idle Presence" signal (POST /api/r9/presence/raise writes presence-raise.json into the
  // session directory): consume it and bring this window forward. A stale signal from before this process
  // started is dropped, not acted on.
  const raiseFile = path.join(directory, 'presence-raise.json');
  try { fs.unlinkSync(raiseFile); } catch {}
  try {
    fs.watch(directory, (eventType, name) => {
      if (name !== 'presence-raise.json') return;
      try { fs.unlinkSync(raiseFile); } catch { return; }
      bringWindowToFront();
    });
  } catch {}
}

// Host + Damar health for the Diagnostics portal (Owner 2026-11-28): real
// readings from this machine via node:os/fs, sampled lightly (one 500 ms CPU
// sample per request; the surface polls on a 60 s cadence, never a hot loop).
function cpuSample() { let idle = 0, total = 0; for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; } return { idle, total }; }
async function hostMetrics() {
  const a = cpuSample();
  await new Promise(r => setTimeout(r, 500));
  const b = cpuSample();
  const cpuLoadPct = b.total > a.total ? Math.max(0, Math.min(100, Math.round(100 - (100 * (b.idle - a.idle)) / (b.total - a.total)))) : 0;
  const totalMem = os.totalmem(), freeMem = os.freemem();
  let disk = null;
  try {
    const st = await fs.promises.statfs('C:\\');
    const totalGb = (st.blocks * st.bsize) / 1e9, freeGb = (st.bfree * st.bsize) / 1e9;
    disk = { usedPct: totalGb > 0 ? Math.round((100 * (totalGb - freeGb)) / totalGb) : 0, freeGb: Math.round(freeGb), totalGb: Math.round(totalGb) };
  } catch {}
  let corePort = null;
  try { corePort = new URL(coreEndpoint()).port || null; } catch {}
  let daemon = false;
  try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('http://127.0.0.1:3000/', { signal: ctl.signal }); clearTimeout(t); daemon = r.status > 0; } catch {}
  const upSec = Math.floor(os.uptime());
  const upText = Math.floor(upSec / 86400) + ' hari ' + Math.floor((upSec % 86400) / 3600) + ' jam ' + Math.floor((upSec % 3600) / 60) + ' menit';
  return {
    host: {
      hostname: os.hostname(),
      cpuLoadPct, cpuCores: os.cpus().length,
      ramUsedPct: totalMem > 0 ? Math.round((100 * (totalMem - freeMem)) / totalMem) : 0,
      ramUsedGb: Math.round(((totalMem - freeMem) / 1e9) * 10) / 10, ramTotalGb: Math.round((totalMem / 1e9) * 10) / 10,
      disk, uptimeText: upText, osText: (typeof os.version === 'function' ? os.version() : os.type()) + ' ' + os.arch(),
    },
    damar: { corePort, coreBound: !!core, daemon3000: daemon },
  };
}

ipcMain.handle('damar-runtime-request', async (event, request) => {
  if (!fromMain(event)) return { ok: false, error: { kind: 'NOT_ALLOWED', message: 'Runtime bridge unavailable.' } };
  const method = String(request?.method || 'GET').toUpperCase(), route = String(request?.path || '');
  if (method === 'GET' && route === '/api/ui/presence/extras') {
    if (!core) return { ok: false, error: { kind: 'UNAVAILABLE', status: 503, message: 'DAMAR Core tidak terjangkau.' } };
    try { const x = await core.extras(); return { ok: true, status: 200, data: { success: true, data: x } }; }
    catch { return { ok: false, error: { kind: 'UNAVAILABLE', status: 503, message: 'Data portal tidak terbaca.' } }; }
  }
  if (method === 'GET' && route === '/api/ui/presence/host') {
    try { const m = await hostMetrics(); return { ok: true, status: 200, data: { success: true, data: m } }; }
    catch { return { ok: false, error: { kind: 'UNAVAILABLE', status: 503, message: 'Metrik host tidak terbaca.' } }; }
  }
  // Conversation is brokered to Core's agent turns (core-presence.chat): the page's one conversation lives on
  // Presence's own attached Core session. Everything else stays on the read-only projection policy.
  if (method === 'POST' && route === '/api/ui/conversations/messages') {
    if (!core) return { ok: false, error: { kind: 'UNAVAILABLE', status: 503, message: 'DAMAR Core tidak terjangkau.' } };
    try {
      const r = await core.chat(String(request?.body?.text ?? ''), delta => {
        // Progressive reply: partial text is pushed on the presence channel;
        // the final answer still returns with this request (identical text).
        try { event.sender.send('damar-presence', { kind: 'chat-delta', text: delta }); } catch {}
      }, phase => {
        // Single turn-status statement: Core accepted the turn (Berpikir).
        try { event.sender.send('damar-presence', { kind: 'chat-phase', phase }); } catch {}
      }, (step, key) => {
        // Snippet lines: the turn's real actions/reasoning, streamed live.
        try { event.sender.send('damar-presence', { kind: 'chat-step', step, key }); } catch {}
      });
      if (!r.ok) {
        // Error containment: a failed turn answers inside the conversation
        // (Indonesian notice from core-presence) and never flips the surface
        // to UNAVAILABLE; only transport-level failures stay errors.
        if (typeof r.notice === 'string' && r.notice) return { ok: true, status: 200, data: { success: true, data: { answer: r.notice, sessionId: 'dsc_presence', turnFailed: true, failLines: Array.isArray(r.failLines) ? r.failLines : [] } } };
        return { ok: false, error: { kind: 'TURN_FAILED', status: r.status || 502, message: r.error || 'Conversation failed.' } };
      }
      return { ok: true, status: 200, data: { success: true, data: { answer: r.answer, sessionId: 'dsc_presence' } } };
    } catch (e) { return { ok: false, error: { kind: 'UNAVAILABLE', status: 503, message: 'DAMAR Core tidak terjangkau.' } }; }
  }
  if (method === 'GET' && /^\/api\/ui\/conversations\/[A-Za-z0-9_-]+$/.test(route)) {
    if (!core) return { ok: false, error: { kind: 'UNAVAILABLE', status: 503, message: 'DAMAR Core tidak terjangkau.' } };
    return { ok: true, status: 200, data: { success: true, data: { turns: core.conversationHistory() } } };
  }
  return uiResponse(request, projection);
});
ipcMain.handle('damar-presence-get', event => (fromMain(event) ? message() : null));
ipcMain.handle('damar-notch-model', event => {
  if (!fromMain(event)) return null;
  try { return notch3dModelCache || (notch3dModelCache = fs.readFileSync(NOTCH3D_MODEL_PATH)); } catch { return null; }
});
// Notch file drop (Coucou drop parity): the preload resolves the dropped
// files to real paths (webUtils); main validates each one (exists, regular
// file, size cap) and reads it, then Core's binding stores it as a task
// attachment (core-presence.dropFiles). The renderer never sends bytes and
// never names a destination.
ipcMain.handle('damar-drop-files', async (event, entries) => {
  if (!fromMain(event) || !core) return { ok: false, error: 'NOT_ALLOWED' };
  try {
    const list = [];
    for (const e of Array.isArray(entries) ? entries.slice(0, 5) : []) {
      const p = String(e?.path || '');
      if (!p || !path.isAbsolute(p)) continue;
      const st = fs.statSync(p);
      if (!st.isFile() || st.size <= 0 || st.size > 25 * 1024 * 1024) continue;
      list.push({ name: path.basename(p), dataBase64: fs.readFileSync(p).toString('base64') });
    }
    if (!list.length) return { ok: false, error: 'NO_VALID_FILES' };
    return core.dropFiles(list);
  } catch { return { ok: false, error: 'DROP_FAILED' }; }
});
ipcMain.handle('damar-media-control', async (event, request) => {
  if (!fromMain(event) || !core) return { ok: false };
  try { await core.mediaControl(String(request?.action || '')); return { ok: true }; } catch { return { ok: false }; }
});
// First-run onboarding (presence-onboarding.js). Save: Core composes the config update + completion flag;
// a 409 (already completed) is success-shaped here - the watcher push then closes the flow with fresh config.
ipcMain.handle('damar-onboarding-save', async (event, values) => {
  if (!fromMain(event) || !core) return { ok: false, error: 'NOT_ALLOWED' };
  try {
    const r = await core.saveOnboarding(values || {});
    if (r.ok || r.status === 409) { try { await watcher?.pollSettings(); } catch {} }
    return { ok: r.ok || r.status === 409, status: r.status, error: r.ok ? null : r.body?.error || 'HTTP_' + r.status, data: r.body?.data || null };
  } catch { return { ok: false, error: 'CORE_UNAVAILABLE' }; }
});
// Step 0 connect: the API key passes through main to Core's secret store only; the result never contains it.
ipcMain.handle('damar-onboarding-connect', async (event, request) => {
  if (!fromMain(event) || !core) return { ok: false, error: 'NOT_ALLOWED' };
  try { return await core.connectProvider({ baseUrl: String(request?.baseUrl || ''), apiKey: String(request?.apiKey || '') }); }
  catch (e) { return { ok: false, error: e?.message || 'CONNECT_FAILED' }; }
});
// Branch A interview turn: Core holds the system prompt and model; main forwards only the turns.
ipcMain.handle('damar-onboarding-chat', async (event, request) => {
  if (!fromMain(event) || !core) return { ok: false, error: 'NOT_ALLOWED' };
  try {
    const r = await core.onboardingChat(Array.isArray(request?.messages) ? request.messages : []);
    return { ok: r.ok, status: r.status, error: r.ok ? null : r.body?.error || 'HTTP_' + r.status, data: r.body?.data || null };
  } catch { return { ok: false, error: 'CORE_UNAVAILABLE' }; }
});
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
  const { x, y, width, height } = targetDisplay().workArea;
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

// Single instance: Presence is one surface with one Notch state machine. A
// second process renders a second, independent notch (Owner report
// 2026-11-28: an expanded notch plus a small collapsed one above it, each
// expandable). The launcher's own refusal only covers its path, so the app
// enforces it here. Selftest probes are exempt (headless, short-lived).
if (!SELFTEST) {
  if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
  app.on('second-instance', () => { bringWindowToFront(); });
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
