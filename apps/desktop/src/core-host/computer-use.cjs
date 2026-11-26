'use strict';
// Core-owned Computer-Use broker for DAMAR and Pandawa (host bridge; no Core file edited).
// Real desktop control through src/core-host/desktop-broker.py (real Windows APIs) and a real
// Chromium-class browser over the DevTools protocol. The broker never runs agent code: the
// helpers are fixed Core-owned scripts driven by bounded JSON, spawned only after the Owner
// authorized the exact target (window or URL origin). Agent subprocesses stay inside the
// no-capability AppContainer (job-run.py) and get no desktop access from here.
//
// Safety invariants (each covered by a mutation-detecting test):
//   - serialized desktop control: all desktop operations across every session run one at a time;
//   - emergency stop: computer_use_stop halts the current chain and disables desktop control and
//     the automation browser for the rest of the host process (stop means stop; no re-arm);
//   - exact target scope: input dispatch re-verifies the foreground window inside the helper
//     process before any input is sent, and points must fall inside the target window rect;
//   - observed-result verification: every action is followed by re-observation and the result
//     reports what was verified, never what was hoped;
//   - truthful model capability: perception reports whether the ACTIVE provider can actually
//     accept images; without it the result says so and offers deterministic analysis only;
//   - no raw pixels and no clipboard contents ever leave the scratch directory or the helper.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawn } = require('node:child_process');

const HELPER = path.join(__dirname, 'desktop-broker.py');
const MAX_WINDOWS = 60, MAX_INK = 1296, HELPER_MS = 15000, BROWSER_WAIT_MS = 20000, ACTION_MS = 30000;
const CAPTURES = 12, MAX_TEXT = 4000;

const state = { python: null, scratch: null, browserExe: null, stopped: false, chain: Promise.resolve(), generation: 0, busy: null, activeAbort: null, log: [], browser: null, ws: null, wsId: 0, wsPending: new Map() };

function configureComputerUse({ python, scratch, browserExe = null } = {}) {
  state.python = python && path.isAbsolute(python) ? python : null;
  state.scratch = scratch || null;
  state.browserExe = browserExe || null;
  if (state.python && state.scratch) { try { fs.mkdirSync(state.scratch, { recursive: true }); } catch { state.python = null; state.scratch = null; } }
}

function browserAvailable() {
  if (state.browserExe) return state.browserExe;
  for (const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// One desktop operation at a time, across every session. The stop generation invalidates
// queued work the moment the Owner (or the agent) trips the emergency stop. Every run is
// logged with monotonic timestamps so serialization is observable (and testable), never
// assumed: intervals in state.log must never overlap.
function enqueue(signal, reason, fn) {
  if (state.stopped) return Promise.reject(Error('DESKTOP_STOPPED'));
  const generation = state.generation;
  const run = state.chain.then(() => {
    if (state.stopped || state.generation !== generation) throw Error('DESKTOP_STOPPED');
    if (signal?.aborted) throw Error('DESKTOP_CANCELLED');
    const entry = { reason, start: performance.now(), end: null };
    state.log.push(entry); if (state.log.length > 32) state.log.shift();
    state.busy = reason;
    const operation = new AbortController();
    const abort = () => operation.abort();
    state.activeAbort = operation;
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) operation.abort();
    return Promise.resolve().then(() => fn(operation.signal)).finally(() => {
      signal?.removeEventListener?.('abort', abort);
      if (state.activeAbort === operation) state.activeAbort = null;
      entry.end = performance.now(); if (state.busy === reason) state.busy = null;
    });
  });
  state.chain = run.catch(() => {});
  return run;
}

// Short-lived helper process: bounded JSON in, one JSON line out, killed on abort/timeout.
function runHelper(command, signal) {
  if (!state.python || !state.scratch) return Promise.reject(Error('DESKTOP_UNAVAILABLE'));
  if (signal?.aborted) return Promise.reject(Error('DESKTOP_CANCELLED'));
  return new Promise((resolve, reject) => {
    let out = '', done = false;
    const cooperative = command?.op === 'mouse' && ['drag', 'path'].includes(command.action);
    const cancelFlag = cooperative ? path.join(state.scratch, 'cancel-' + crypto.randomUUID()) : null;
    if (cancelFlag) command = { ...command, cancel_flag: cancelFlag };
    const child = spawn(state.python, ['-I', HELPER], { cwd: state.scratch, env: { SystemRoot: process.env.SystemRoot, TEMP: state.scratch, TMP: state.scratch }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); if (cancelFlag) try { fs.unlinkSync(cancelFlag); } catch {} fn(value); try { child.kill(); } catch {} };
    const timer = setTimeout(() => finish(() => reject(Error('DESKTOP_HELPER_TIMEOUT'))), HELPER_MS);
    const onAbort = () => {
      if (cooperative) { try { fs.writeFileSync(cancelFlag, 'cancel'); } catch {} }
      else finish(() => reject(Error('DESKTOP_CANCELLED')));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', d => { out = (out + d.toString('utf8')).slice(0, 1024 * 1024); });
    child.on('error', e => finish(() => reject(Error('DESKTOP_SPAWN_FAILED_' + (e.code || 'UNKNOWN')))));
    child.on('close', () => finish(() => {
      if (signal?.aborted) return reject(Error('DESKTOP_CANCELLED'));
      let line = null;
      for (const candidate of out.split('\n').reverse()) if (candidate.trim().startsWith('{')) { line = candidate.trim(); break; }
      if (!line) return reject(Error('DESKTOP_HELPER_NO_RESULT'));
      resolve(JSON.parse(line));
    }));
    child.stdin.end(JSON.stringify(command) + '\n');
  });
}

function windowFingerprint(win) {
  return crypto.createHash('sha256').update(`${win.title}\u0000${win.pid}`).digest('hex').slice(0, 24);
}

function findWindow(windows, { title, pid } = {}) {
  if (typeof title !== 'string' || !title) throw Error('WINDOW_TARGET_INVALID');
  const matches = windows.filter(w => w.title === title && (pid === undefined || pid === null || w.pid === pid));
  if (!matches.length) throw Error('WINDOW_NOT_FOUND');
  const [l, t, r, b] = matches[0].rect;
  if (r - l < 8 || b - t < 8) throw Error('WINDOW_TOO_SMALL');
  return matches[0];
}

function newCaptureDir() {
  const dir = path.join(state.scratch, 'cu-captures');
  fs.mkdirSync(dir, { recursive: true });
  // Keep the bounded set of captures; privacy-sensitive screen data never accumulates.
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  for (const old of entries.slice(0, Math.max(0, entries.length - CAPTURES))) try { fs.unlinkSync(path.join(dir, old)); } catch {}
  return dir;
}

function requirePoint(action, x, y, endX, endY, points) {
  if (['move', 'click', 'dblclick', 'right', 'wheel', 'setfield', 'paste'].includes(action) && (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)))
    throw Error('POINT_REQUIRED');
  if (action === 'drag' && (![x, y, endX, endY].every(Number.isSafeInteger))) throw Error('POINT_REQUIRED');
  if (action === 'path' && (!Array.isArray(points) || points.length < 2 || points.length > 128 ||
      points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isSafeInteger)))) throw Error('PATH_INVALID');
}

async function observe({ target = 'screen', title = null, pid = null, capture: wantCapture = true, region = null, maxDim = null } = {}, signal) {
  const __ow = Date.now();
  const windows = await runHelper({ op: 'windows', limit: MAX_WINDOWS }, signal);
  const __windowsMs = Date.now() - __ow;
  if (windows.ok !== true) throw Error('DESKTOP_HELPER_FAILED_' + (windows.error || 'UNKNOWN'));
  const list = windows.windows.slice(0, MAX_WINDOWS);
  const result = { windows: list.map(w => ({ title: w.title, pid: w.pid, rect: w.rect })) };
  const fg = await runHelper({ op: 'foreground' }, signal);
  result.foreground = fg.ok ? fg.foreground : null;
  result.phaseMs = { windows: __windowsMs, capture: 0 };
  if (wantCapture) {
    const win = target === 'window' ? findWindow(list, { title, pid }) : null;
    // Optional tight read-back: a window-relative region captured at native
    // resolution, so small values (a 2-digit dialog field) stay legible instead
    // of dissolving into a whole-window grid.
    let reg = null;
    if (win && region) {
      const [l, t, r, b] = win.rect, ww = r - l, wh = b - t;
      const w = Math.max(8, Math.min(Math.floor(region.w) || 8, ww));
      const h = Math.max(8, Math.min(Math.floor(region.h) || 8, wh));
      reg = [Math.max(0, Math.min(Math.floor(region.x) || 0, ww - w)),
        Math.max(0, Math.min(Math.floor(region.y) || 0, wh - h)), w, h];
    }
    const dir = newCaptureDir();
    const file = path.join(dir, crypto.randomUUID() + '.png');
    const __oc = Date.now();
    const shot = await runHelper({ op: 'capture', path: file, hwnd: win ? win.hwnd : null, region: reg,
      max_dim: Number.isSafeInteger(maxDim) && maxDim >= 64 ? maxDim : null }, signal);
    result.phaseMs.capture = Date.now() - __oc;
    if (shot.ok !== true) throw Error('DESKTOP_CAPTURE_FAILED_' + (shot.error || 'UNKNOWN'));
    result.capture = { path: file, sha256: shot.sha256, width: shot.width, height: shot.height, region: reg, scale: shot.scale || 1 };
    result.analysis = { ink: Array.isArray(shot.ink) ? shot.ink.slice(0, MAX_INK) : [], mean: shot.mean, width: shot.width, height: shot.height };
  }
  return result;
}

// Bring the authorized target to the front and keep re-verifying inside the helper process.
async function act({ title, pid, action, x = null, y = null, endX = null, endY = null, points = null, durationMs = 500,
  text = null, vk = null, modifiers = null, wheel = 1, horizontal = false,
  commit = 'enter', regionW = 280, regionH = 64 } = {}, signal) {
  requirePoint(action, x, y, endX, endY, points);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 5000) throw Error('DURATION_INVALID');
  const windows = await runHelper({ op: 'windows', limit: MAX_WINDOWS }, signal);
  if (windows.ok !== true) throw Error('DESKTOP_HELPER_FAILED_' + (windows.error || 'UNKNOWN'));
  const win = findWindow(windows.windows, { title, pid });
  const focused = await runHelper({ op: 'focus', hwnd: win.hwnd }, signal);
  if (focused.ok !== true || focused.foreground?.hwnd !== win.hwnd) {
    const error = Error('FOCUS_REFUSED');
    error.foreground = focused.foreground;
    error.focusEvidence = { target: { hwnd: win.hwnd, pid: win.pid }, helperError: focused.error || null,
      helperSucceeded: focused.ok === true, foreground: focused.foreground || null };
    throw error;
  }
  const readbackFile = action === 'setfield' ? path.join(newCaptureDir(), crypto.randomUUID() + '.png') : null;
  const dispatch = action === 'type' ? { op: 'type', text: String(text || ''), expect_hwnd: win.hwnd, expect_title: win.title }
    : action === 'setfield' ? { op: 'setfield', x, y, text: String(text || ''), commit, region_w: regionW, region_h: regionH,
        path: readbackFile, expect_hwnd: win.hwnd, expect_title: win.title }
    : action === 'paste' ? { op: 'paste', x, y, text: String(text || ''), expect_hwnd: win.hwnd, expect_title: win.title }
    : action === 'hotkey' ? { op: 'hotkey', vk, modifiers: modifiers || {}, expect_hwnd: win.hwnd, expect_title: win.title }
    : action === 'wheel' ? { op: 'mouse', action: 'wheel', x, y, delta: wheel, horizontal, expect_hwnd: win.hwnd, expect_title: win.title }
    : action === 'drag' ? { op: 'mouse', action: 'drag', x, y, end_x: endX, end_y: endY, expect_hwnd: win.hwnd, expect_title: win.title }
    : action === 'path' ? { op: 'mouse', action: 'path', x: points[0][0], y: points[0][1], points, duration_ms: durationMs, expect_hwnd: win.hwnd, expect_title: win.title }
    : { op: 'mouse', action, x, y, expect_hwnd: win.hwnd, expect_title: win.title };
  const sent = await runHelper(dispatch, signal);
  if (sent.ok !== true) { const e = Error(sent.error || 'DISPATCH_FAILED'); e.foreground = sent.foreground; throw e; }
  return { target: { title: win.title, pid: win.pid }, rect: win.rect, cursor: sent.cursor, foreground: sent.foreground,
    readback: sent.readback ? { path: readbackFile, width: sent.readback.width, height: sent.readback.height,
      mean: sent.readback.mean, region: sent.readback.region || null } : null };
}

async function compareRegion(before, after) {
  if (!before?.analysis || !after?.capture) return null;
  const a = before.analysis.ink, b = after.analysis.ink;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) diff++;
  return { changedCells: diff, total: a.length };
}

// ---- Real browser automation over the DevTools protocol (Core-owned Edge/Chrome child) ----

function wsSend(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== 1) return reject(Error('BROWSER_NOT_ATTACHED'));
    const id = ++state.wsId;
    const timer = setTimeout(() => { state.wsPending.delete(id); reject(Error('CDP_TIMEOUT')); }, ACTION_MS);
    state.wsPending.set(id, { resolve, reject, timer });
    state.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function attachBrowser(signal) {
  if (state.ws && state.ws.readyState === 1) return;
  const exe = browserAvailable();
  if (!exe) throw Error('BROWSER_UNAVAILABLE');
  const profile = path.join(state.scratch, 'cu-browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  try { fs.unlinkSync(portFile); } catch {}
  const child = spawn(exe, [`--remote-debugging-port=0`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions', '--window-size=1280,900', 'about:blank'],
    { shell: false, windowsHide: false, stdio: 'ignore', detached: false });
  state.browser = child;
  child.on('exit', () => { state.browser = null; try { state.ws?.close(); } catch {} state.ws = null; });
  const deadline = Date.now() + BROWSER_WAIT_MS;
  while (Date.now() < deadline && (!fs.existsSync(portFile) || child.pid === undefined)) await new Promise(r => setTimeout(r, 200));
  if (!fs.existsSync(portFile)) throw Error('BROWSER_DEVTOOLS_TIMEOUT');
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
  if (!port) throw Error('BROWSER_DEVTOOLS_INVALID');
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const page = list.find(t => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw Error('BROWSER_NO_PAGE_TARGET');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    state.ws = ws; state.wsId = 0; state.wsPending.clear();
    ws.onopen = resolve;
    ws.onerror = () => reject(Error('BROWSER_WS_FAILED'));
    ws.onmessage = event => {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
      if (data.id && state.wsPending.has(data.id)) {
        const { resolve: res, reject: rej, timer } = state.wsPending.get(data.id);
        state.wsPending.delete(data.id); clearTimeout(timer);
        data.error ? rej(Error('CDP_ERROR_' + (data.error.message || 'UNKNOWN').slice(0, 80))) : res(data.result);
      }
    };
    ws.onclose = () => { for (const [id, p] of state.wsPending) { clearTimeout(p.timer); p.reject(Error('BROWSER_WS_CLOSED')); } state.wsPending.clear(); state.ws = null; };
  });
  await wsSend('Page.enable');
  signal?.addEventListener?.('abort', () => { try { state.ws?.close(); } catch {} try { state.browser?.kill(); } catch {} }, { once: true });
}

function evaluate(expression) {
  return wsSend('Runtime.evaluate', { expression, returnByValue: true, timeout: 15000 }).then(r => r?.result?.value);
}

function pageState() {
  return evaluate(`JSON.stringify({title:document.title,url:location.href,text:(document.body?document.body.innerText:'').slice(0,${MAX_TEXT})})`)
    .then(s => { try { return JSON.parse(s); } catch { return null; } });
}

function originOf(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw Error('BROWSER_SCHEME_REFUSED');
  return u.origin;
}

async function browserNavigate(url, signal) {
  await attachBrowser(signal);
  await wsSend('Page.navigate', { url });
  const deadline = Date.now() + ACTION_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    if (signal?.aborted) throw Error('DESKTOP_CANCELLED');
    const ready = await evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
  }
  const page = await pageState();
  if (!page) throw Error('BROWSER_PAGE_STATE_FAILED');
  return page;
}

async function browserClick(selector, expect, signal) {
  await attachBrowser(signal);
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) return null;
    const r = el.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}); })()`);
  if (!box) throw Error('BROWSER_SELECTOR_NOT_FOUND');
  const { x, y } = JSON.parse(box);
  for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { clickCount: 1, button: 'left' }], ['mouseReleased', { clickCount: 1, button: 'left' }]]) {
    await wsSend('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }
  await new Promise(r => setTimeout(r, 400));
  return verifyBrowserExpect(expect);
}

async function browserType(selector, text, expect, signal) {
  await attachBrowser(signal);
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) return null;
    const r = el.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}); })()`);
  if (!box) throw Error('BROWSER_SELECTOR_NOT_FOUND');
  const { x, y } = JSON.parse(box);
  for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { clickCount: 1, button: 'left' }], ['mouseReleased', { clickCount: 1, button: 'left' }]]) {
    await wsSend('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }
  await wsSend('Input.insertText', { text: String(text || '').slice(0, 2000) });
  await new Promise(r => setTimeout(r, 250));
  return verifyBrowserExpect(expect);
}

// Observed-result verification for the browser: allowlisted predicates evaluated in the page.
async function verifyBrowserExpect(expect) {
  const page = await pageState();
  if (!page) throw Error('BROWSER_PAGE_STATE_FAILED');
  let verified = null;
  if (expect?.kind === 'text') verified = page.text.includes(String(expect.value).slice(0, 200));
  else if (expect?.kind === 'selector') verified = await evaluate(`!!document.querySelector(${JSON.stringify(String(expect.value).slice(0, 200))})`);
  else if (expect?.kind === 'url') verified = page.url.startsWith(String(expect.value).slice(0, 300));
  return { ...page, verified, expect: expect ? { kind: expect.kind, value: String(expect.value).slice(0, 200) } : null };
}

function closeBrowser() {
  try { state.ws?.close(); } catch {}
  try { state.browser?.kill(); } catch {}
  state.ws = null; state.browser = null;
}

function createComputerUseTools({ AITool, authority, broker, settings = null, visionCapable = null }) {
  const tool = (spec, flags) => { const t = new AITool(spec); t.meta = flags; if (flags.canonicalAuthority) t.canonicalAuthority = true; return t; };
  const out = value => JSON.stringify(value);
  const fail = error => out({ ok: false, error: String(error?.message || error).slice(0, 160),
    ...(error?.focusEvidence ? { focusEvidence: error.focusEvidence } : {}) });
  const ctxOf = execution => {
    const sessionId = execution?.ingress?.sessionId ?? execution?.exec?.sessionId ?? null;
    const ctx = sessionId ? broker.context(sessionId) : null;
    if (!ctx) throw Error('NO_ACTIVE_TURN');
    return ctx;
  };

  // Owner authorization identical to the workspace tools: real grants through Core's bridge.
  async function authorize(ctx, { op, scopeToken, card, parameters, driver, verify }) {
    if (state.stopped) return { ok: false, error: 'DESKTOP_STOPPED' };
    if (settings?.autonomy() === 'read-only' && op !== 'cu-observe') return { ok: false, error: 'READ_ONLY_PROFILE' };
    const scope = [scopeToken, 'root:' + crypto.createHash('sha256').update(String(ctx.root || '')).digest('hex').slice(0, 16)];
    let mode = null;
    const existing = await authority.evaluate(op, scope).catch(() => null);
    if (!existing?.allowed) {
      const answer = await ctx.requestPermission(card);
      if (answer !== 'once' && answer !== 'session') return { ok: false, error: 'DENIED_BY_OWNER' };
      mode = answer;
      await authority.grant({ op, scope, mode, sessionEndsAt: ctx.sessionEndsAt, summary: card.change });
    }
    const result = await authority.execute({ op, scope, parameters, driver, verify, invocation: 'inv-' + crypto.randomUUID() });
    if (mode === 'once') await authority.consume(op, scope).catch(() => {});
    return result;
  }

  const vision = () => { try { return visionCapable ? visionCapable() === true : false; } catch { return false; } };

  return [
    tool({ name: 'computer_use_stop', description: 'EMERGENCY STOP: immediately halt all Computer-Use desktop and browser control for the rest of this Core session (serialization queue drained, automation browser killed). No re-approval re-enables it.',
      parameters: { type: 'object', properties: {} },
       execute: async (args, execution) => { try {
         const ctx = ctxOf(execution);
         const pending = state.chain;
         state.generation++; state.stopped = true; state.activeAbort?.abort(); closeBrowser();
         await pending;
         ctx.emit({ type: 'tool', badge: 'STOP', target: 'computer-use emergency stop engaged' });
        return out({ ok: true, stopped: true, note: 'desktop control disabled until the Core host restarts' });
      } catch (e) { return fail(e); } } },
      { readOnly: true }),
    tool({ name: 'computer_use_observe', description: 'Observe the desktop: list windows, optionally capture the screen or one window, and report what the active model can actually perceive. Capture requires Owner authorization; analysis is deterministic, never raw pixels. For a window target, regionX/regionY/regionW/regionH capture a tight window-relative region at native resolution (use it to READ small values such as dialog fields), and maxDim downscales the delivered image for fast loops (the result reports the scale; window coordinates stay authoritative).',
      parameters: { type: 'object', properties: { target: { type: 'string', enum: ['screen', 'window'] }, title: { type: 'string' }, pid: { type: 'integer' }, capture: { type: 'boolean' },
        regionX: { type: 'integer' }, regionY: { type: 'integer' }, regionW: { type: 'integer' }, regionH: { type: 'integer' }, maxDim: { type: 'integer' } } },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        if (state.stopped) return out({ ok: false, error: 'DESKTOP_STOPPED' });
        const target = args?.target === 'window' ? 'window' : 'screen';
        const wantCapture = args?.capture !== false;
        const fingerprint = target === 'window'
          ? windowFingerprint({ title: String(args?.title || ''), pid: args?.pid ?? null })
          : 'screen:' + crypto.createHash('sha256').update(String(process.env.COMPUTERNAME || '')).digest('hex').slice(0, 12);
        let observed = null;
        const r = await authorize(ctx, { op: 'cu-observe', scopeToken: 'cu-observe:' + fingerprint,
          card: { tool: 'computer_use_observe', run: target === 'window' ? `capture window "${String(args?.title || '').slice(0, 60)}"` : 'capture the whole screen',
            change: 'observe the desktop for the current task', scope: target === 'window' ? 'exact window title+pid' : 'full screen (privacy-sensitive)',
            risk: 'A screen image is written to the private scratch directory; pixels are never sent to a model unless it can actually accept images' },
          parameters: { target, fingerprint },
          driver: async () => { observed = await enqueue(ctx.signal, 'observe', signal => observe({ target, title: args?.title, pid: args?.pid, capture: wantCapture,
            region: target === 'window' && Number.isSafeInteger(args?.regionW) && Number.isSafeInteger(args?.regionH)
              ? { x: args?.regionX || 0, y: args?.regionY || 0, w: args.regionW, h: args.regionH } : null,
            maxDim: Number.isSafeInteger(args?.maxDim) ? args.maxDim : null }, signal)); return { observed: true }; },
          verify: async () => ({ checks: [
            { name: 'helper answered', passed: !!observed && Array.isArray(observed.windows) },
            ...(wantCapture ? [{ name: 'capture written', passed: !!observed?.capture?.path && fs.existsSync(observed.capture.path) }] : []) ] }) });
        if (r.ok === false) return out(r);
        if (!observed) return out({ ok: false, error: 'NOT_EXECUTED_' + (r.reason || r.outcome) });
        ctx.emit({ type: 'tool', badge: 'CU-OBSERVE', target: `${target}${args?.title ? ' ' + String(args.title).slice(0, 40) : ''} (${observed.windows.length} windows)` });
        const result = { ok: true, outcome: r.outcome, windows: observed.windows, foreground: observed.foreground,
          capture: observed.capture ? { sha256: observed.capture.sha256, width: observed.capture.width, height: observed.capture.height, path: observed.capture.path,
            region: observed.capture.region || null, scale: observed.capture.scale || 1 } : null,
          analysis: observed.analysis ? { ink: observed.analysis.ink, mean: observed.analysis.mean } : null,
          phases: observed.phaseMs || null,
          visionCapability: vision() ? 'verified' : 'unverified',
          visionAvailable: vision(), visionNote: vision() ? 'selected model capability is verified' : 'selected model image input is not verified; only deterministic analysis is available' };
        if (vision() && observed.capture?.path) {
          const stat = fs.statSync(observed.capture.path);
          if (stat.size <= 3 * 1024 * 1024) {
            const image = fs.readFileSync(observed.capture.path);
            const signature = image.subarray(0, 8).toString('hex');
            if (signature === '89504e470d0a1a0a') result.__damarComputerUseImage = 'data:image/png;base64,' + image.toString('base64');
          }
        }
        return out(result);
      } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: false, readOnly: true }),
    tool({ name: 'computer_use_act', description: 'Act on one authorized desktop window: focus it, then move/click/right-click/double-click/drag/freehand-path/vertical-or-horizontal-scroll/type/hotkey. Drag and path are one bounded down-move-up helper operation; every path point must be inside the exact target window. Input is re-verified against the foreground window before dispatch, and the result reports what was actually observed. For entering a value into a small dialog field, use action "setfield" with x/y at the field center and text: it focuses the field, selects its content, types as real key events, commits (commit: "enter" | "tab" | "none"), and returns a zoomed read-back image of the field so the landed value can be confirmed; verification compares that tight region, not the whole window. For filling a RANGE of cells in a spreadsheet, use action "paste" with x/y at the top-left target cell and text as a tab-separated block (rows separated by newlines): it anchor-clicks the cell, places the text on the clipboard (write-only) and pastes it in one operation.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, pid: { type: 'integer' },
        action: { type: 'string', enum: ['move', 'click', 'dblclick', 'right', 'drag', 'path', 'wheel', 'type', 'hotkey', 'setfield', 'paste'] },
        x: { type: 'integer' }, y: { type: 'integer' }, endX: { type: 'integer' }, endY: { type: 'integer' },
        points: { type: 'array', maxItems: 128, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' } } },
        durationMs: { type: 'integer', minimum: 0, maximum: 5000 }, horizontal: { type: 'boolean' },
        text: { type: 'string' }, vk: { type: 'integer' },
        commit: { type: 'string', enum: ['enter', 'tab', 'none'] }, regionW: { type: 'integer' }, regionH: { type: 'integer' },
         modifiers: { type: 'object', properties: { ctrl: { type: 'boolean' }, alt: { type: 'boolean' }, shift: { type: 'boolean' }, win: { type: 'boolean' } } }, wheel: { type: 'integer' } },
        required: ['title', 'action'] },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        if (state.stopped) return out({ ok: false, error: 'DESKTOP_STOPPED' });
        const fingerprint = windowFingerprint({ title: String(args?.title || ''), pid: args?.pid ?? null });
        let before = null, applied = null, after = null;
        const __t0 = Date.now(); const phases = {};
        const r = await authorize(ctx, { op: 'cu-act', scopeToken: 'cu-act:' + fingerprint,
          card: { tool: 'computer_use_act', run: `${args.action} on window "${String(args?.title || '').slice(0, 60)}"${args.action === 'type' ? ` (text ${String(args?.text || '').length} chars)` : ''}`,
            change: 'operate this exact window with mouse/keyboard', scope: 'exact window title+pid, re-verified at dispatch time',
            risk: 'Real input events are sent to the desktop; serialized and immediately stoppable' },
          parameters: { title: String(args?.title || '').slice(0, 120), pid: args?.pid ?? null, action: args.action,
            point: args.action === 'type' || args.action === 'hotkey' ? null : { x: args?.x, y: args?.y },
            endPoint: args.action === 'drag' ? { x: args?.endX, y: args?.endY } : null,
            pathPoints: args.action === 'path' ? args.points : null,
            inputDigest: (args.action === 'type' || args.action === 'paste') ? crypto.createHash('sha256').update(String(args?.text || '')).digest('hex').slice(0, 24) : null },
          driver: async () => {
            phases.gateMs = Date.now() - __t0;
            await enqueue(ctx.signal, 'act', async signal => {
              if (args.action === 'setfield') {
                // Verify against a tight region around the field: a whole-window
                // grid cannot see a 2-digit change, a native-res crop can.
                const listing = await observe({ target: 'window', title: args?.title, pid: args?.pid, capture: false }, signal);
                const win = listing.windows.find(w => w.title === String(args?.title || '') && (args?.pid == null || w.pid === args?.pid));
                if (!win) throw Error('WINDOW_NOT_FOUND');
                const [l, t, r, b] = win.rect, ww = r - l, wh = b - t;
                const rw = Math.max(16, Math.min(args?.regionW || 280, ww)), rh = Math.max(16, Math.min(args?.regionH || 64, wh));
                const region = { x: Math.max(0, Math.min((args.x - l) - Math.floor(rw / 2), ww - rw)),
                  y: Math.max(0, Math.min((args.y - t) - Math.floor(rh / 2), wh - rh)), w: rw, h: rh };
                before = await observe({ target: 'window', title: args?.title, pid: args?.pid, region }, signal);
                applied = await act(args, signal);
                after = await observe({ target: 'window', title: args?.title, pid: args?.pid, region }, signal);
              } else {
                // Verification captures feed only the coarse ink-grid diff,
                // so cap them at 1024px: same checks, cheaper capture+encode.
                const __b0 = Date.now();
                before = await observe({ target: 'window', title: args?.title, pid: args?.pid, maxDim: 1024 }, signal);
                phases.beforeMs = Date.now() - __b0;
                const __d0 = Date.now();
                applied = await act(args, signal);
                phases.dispatchMs = Date.now() - __d0;
                const __a0 = Date.now();
                after = await observe({ target: 'window', title: args?.title, pid: args?.pid, maxDim: 1024 }, signal);
                phases.afterMs = Date.now() - __a0;
              }
            });
            return { applied: true };
          },
          verify: async () => { const region = await compareRegion(before, after); return { checks: [
            { name: 'dispatch verified in helper', passed: !!applied && !!applied.target },
            { name: 'window still exists', passed: !!after && after.windows.some(w => w.title === String(args?.title || '') && (args?.pid == null || w.pid === args.pid)) },
            ...(args.action === 'move' || args.action === 'click' || args.action === 'dblclick' || args.action === 'right' || args.action === 'drag' || args.action === 'path' || args.action === 'wheel' || args.action === 'setfield' || args.action === 'paste'
              ? [{ name: 'cursor at the requested point (±1px)', passed: !!applied?.cursor && Math.abs(applied.cursor[0] - (args.action === 'drag' ? args?.endX : args.action === 'path' ? args.points.at(-1)?.[0] : args?.x)) <= 1 && Math.abs(applied.cursor[1] - (args.action === 'drag' ? args?.endY : args.action === 'path' ? args.points.at(-1)?.[1] : args?.y)) <= 1 }]
              : []),
            ...(!['move', 'wheel'].includes(args.action) ? [{ name: 'screen region changed (observation)', passed: region ? region.changedCells > 0 : false, observed: region }] : []),
          ] }; } });
        phases.verifyResidualMs = Math.max(0, (Date.now() - __t0) - (phases.gateMs || 0) - (phases.beforeMs || 0) - (phases.dispatchMs || 0) - (phases.afterMs || 0));
        if (r.ok === false) return out(r);
        if (!applied) return out({ ok: false, error: 'NOT_EXECUTED_' + (r.reason || r.outcome) });
        ctx.emit({ type: 'tool', badge: 'CU-ACT', target: `${args.action} ${String(args?.title || '').slice(0, 40)}` });
        const result = { ok: true, outcome: r.outcome, phases, target: applied.target, rect: applied.rect, cursor: applied.cursor,
          foreground: applied.foreground, region: r.checks?.find(c => c.name.startsWith('screen region'))?.observed || null,
          readback: applied.readback ? { width: applied.readback.width, height: applied.readback.height,
            mean: applied.readback.mean, region: applied.readback.region } : null };
        if (vision() && applied.readback?.path && fs.existsSync(applied.readback.path)) {
          const stat = fs.statSync(applied.readback.path);
          if (stat.size <= 3 * 1024 * 1024) {
            const image = fs.readFileSync(applied.readback.path);
            if (image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
              result.__damarComputerUseImage = 'data:image/png;base64,' + image.toString('base64');
          }
        }
        return out(result);
      } catch (e) {
        const message = String(e?.message || e);
        if (message.startsWith('FOREGROUND_MISMATCH') || message.startsWith('POINT_OUTSIDE_TARGET') || message.startsWith('WINDOW_NOT_FOUND'))
          return out({ ok: false, error: message, foreground: e?.foreground || null, note: 'refused before any input was dispatched' });
        return fail(e);
      } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'computer_use_uia', description: 'Structured UI Automation channel for one authorized window. Action "tree" returns the element tree as TEXT (control type, name, bounding rect, current value, actionable patterns) - for native apps (LibreOffice, VS Code, system dialogs) prefer this over a screenshot: it is exact and cheap. Action "invoke" activates an element by name (and optional control type) via its Invoke/Toggle/SelectionItem pattern. Action "setvalue" writes a field through the Value pattern and verifies by reading the value back from the element. Canvas surfaces (games, image-editor canvases, Blender viewport) expose almost nothing here - keep using observe/act for those.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, pid: { type: 'integer' },
        action: { type: 'string', enum: ['tree', 'invoke', 'setvalue'] },
        name: { type: 'string' }, type: { type: 'string' }, value: { type: 'string' },
        maxDepth: { type: 'integer' }, maxNodes: { type: 'integer' } },
        required: ['title', 'action'] },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        if (state.stopped) return out({ ok: false, error: 'DESKTOP_STOPPED' });
        const fingerprint = windowFingerprint({ title: String(args?.title || ''), pid: args?.pid ?? null });
        let applied = null;
        const r = await authorize(ctx, { op: 'cu-uia', scopeToken: 'cu-uia:' + fingerprint,
          card: { tool: 'computer_use_uia', run: `${args.action} on window "${String(args?.title || '').slice(0, 60)}"`,
            change: 'read or operate this exact window via UI Automation', scope: 'exact window title+pid, re-verified at dispatch time',
            risk: 'Structured element access on the authorized window only; invoke/setvalue change app state like a user would' },
          parameters: { title: String(args?.title || '').slice(0, 120), pid: args?.pid ?? null, action: args.action,
            name: args?.name || null, type: args?.type || null },
          driver: async () => {
            await enqueue(ctx.signal, 'act', async signal => {
              const windows = await runHelper({ op: 'windows', limit: MAX_WINDOWS }, signal);
              if (windows.ok !== true) throw Error('DESKTOP_HELPER_FAILED_' + (windows.error || 'UNKNOWN'));
              const win = findWindow(windows.windows, { title: args?.title, pid: args?.pid });
              if (args.action !== 'tree') {
                const focused = await runHelper({ op: 'focus', hwnd: win.hwnd }, signal);
                if (focused.ok !== true || focused.foreground?.hwnd !== win.hwnd) throw Error('FOCUS_REFUSED');
              }
              const op = args.action === 'tree' ? 'uia_tree' : args.action === 'invoke' ? 'uia_invoke' : 'uia_setvalue';
              applied = await runHelper({ op, expect_hwnd: win.hwnd, expect_title: win.title,
                name: args?.name || '', type: args?.type || '', value: args?.value || '',
                max_depth: Number.isSafeInteger(args?.maxDepth) ? args.maxDepth : 6,
                max_nodes: Number.isSafeInteger(args?.maxNodes) ? args.maxNodes : 300 }, signal);
              if (applied.ok !== true) { const e = Error(applied.error || 'UIA_FAILED'); e.foreground = applied.foreground; throw e; }
              applied.__win = { title: win.title, pid: win.pid };
            });
            return { applied: true };
          },
          verify: async () => ({ checks: [
            { name: 'uia helper answered ok', passed: !!applied && applied.ok === true },
            ...(args.action === 'setvalue' ? [{ name: 'element value read-back matches', passed: applied?.element?.value === String(args?.value || '') }] : []),
          ] }) });
        if (r.ok === false) return out(r);
        if (!applied) return out({ ok: false, error: 'NOT_EXECUTED_' + (r.reason || r.outcome) });
        const result = { ok: true, outcome: r.outcome, channel: 'uia', target: applied.__win,
          ...(args.action === 'tree' ? { tree: applied.tree, truncated: !!applied.truncated }
            : { element: applied.element || null, matches: applied.matches ?? null }) };
        return out(result);
      } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'computer_use_appmodel', description: 'App object-model channel (enabled only when DAMAR_CU_APPMODEL_PORT is set): sends ONE fixed-vocabulary command to the in-app bridge of the staged application. Bridges: Blender bpy (ping, get_objects, add_cube, add_uv_sphere, set_location, set_base_color, save, render) and LibreOffice UNO for Calc (ping, get_cell, get_range, set_cell, set_range, fill_down, set_bold, set_number_format, insert_chart, save_as, export_pdf). This reads/writes the app MODEL directly - exact state, no pixels. Every response includes read-back verification of the affected objects/cells. Vision stays available for visual review of renders/canvas.',
      parameters: { type: 'object', properties: { command: { type: 'object' } }, required: ['command'] },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        if (state.stopped) return out({ ok: false, error: 'DESKTOP_STOPPED' });
        const port = Number(process.env.DAMAR_CU_APPMODEL_PORT || 0);
        if (!port) return out({ ok: false, error: 'APPMODEL_NOT_CONFIGURED' });
        const cmd = args?.command && typeof args.command === 'object' ? args.command : null;
        if (!cmd || typeof cmd.cmd !== 'string') return out({ ok: false, error: 'APPMODEL_CMD_INVALID' });
        let resp = null;
        const r = await authorize(ctx, { op: 'cu-appmodel', scopeToken: 'cu-appmodel:' + port,
          card: { tool: 'computer_use_appmodel', run: 'appmodel ' + cmd.cmd,
            change: 'operate the staged app through its object model', scope: 'the bench-staged app bridge on localhost only',
            risk: 'Fixed-vocabulary model commands (no arbitrary code); effects equal the user doing it in the app' },
          parameters: { port, cmd: cmd.cmd },
          driver: async () => {
            resp = await new Promise((resolve, reject) => {
              const net = require('node:net');
              const sock = net.connect(port, '127.0.0.1');
              let buf = '';
              const timer = setTimeout(() => { try { sock.destroy(); } catch {} reject(Error('APPMODEL_TIMEOUT')); }, 120000);
              sock.on('connect', () => sock.write(JSON.stringify(cmd) + '\n'));
              sock.on('data', d => { buf += d.toString('utf-8'); if (buf.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); } try { sock.end(); } catch {} } });
              sock.on('error', e => { clearTimeout(timer); reject(e); });
            });
            if (!resp || resp.ok !== true) throw Error('APPMODEL_CMD_FAILED_' + (resp?.error || 'NORESP'));
            return { applied: true };
          },
          verify: async () => ({ checks: [ { name: 'bridge answered ok', passed: !!resp && resp.ok === true } ] }) });
        if (r.ok === false) return out(r);
        return out({ ok: true, outcome: r.outcome, channel: 'appmodel', response: resp });
      } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'computer_use_dom', description: 'DOM channel for the bench-staged Edge instance (enabled only when DAMAR_CU_DOM_PORT is set): evaluates a JavaScript expression in the current page via CDP and returns its value as JSON text. For web apps with a real DOM (e.g. 2048: tiles and score are DOM elements) this reads EXACT state with zero screenshots - prefer it for reading game/document state; keep using act for input (key presses). Canvas apps expose almost nothing here.',
      parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        if (state.stopped) return out({ ok: false, error: 'DESKTOP_STOPPED' });
        const port = Number(process.env.DAMAR_CU_DOM_PORT || 0);
        if (!port) return out({ ok: false, error: 'DOM_NOT_CONFIGURED', note: 'no CDP port configured for this session' });
        const expr = String(args?.expression || '');
        if (!expr || expr.length > 4000) return out({ ok: false, error: 'DOM_EXPR_INVALID' });
        let value = null, evalError = null;
        const r = await authorize(ctx, { op: 'cu-dom', scopeToken: 'cu-dom:' + port,
          card: { tool: 'computer_use_dom', run: 'evaluate in staged page: ' + expr.slice(0, 80),
            change: 'read page state through the DOM of the bench-staged browser', scope: 'the hermetic staged Edge instance only (debug port on localhost)',
            risk: 'Expression evaluation inside the staged page; the bench gate scopes it to the staged browser instance' },
          parameters: { port, expression: expr.slice(0, 200) },
          driver: async () => {
            const listRes = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) });
            const targets = await listRes.json();
            const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && !/devtools/.test(t.url || ''));
            if (!page) throw Error('DOM_NO_PAGE_TARGET');
            value = await new Promise((resolve, reject) => {
              const ws = new WebSocket(page.webSocketDebuggerUrl);
              const timer = setTimeout(() => { try { ws.close(); } catch {} reject(Error('DOM_EVAL_TIMEOUT')); }, 15000);
              ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
              ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id !== 1) return; clearTimeout(timer); try { ws.close(); } catch {}
                const res = m.result?.result;
                if (m.result?.exceptionDetails) { evalError = String(m.result.exceptionDetails.text || 'EVAL_EXCEPTION').slice(0, 200); resolve(null); }
                else resolve(res && 'value' in res ? res.value : (res?.description ?? null)); } catch (e) { clearTimeout(timer); reject(e); } };
              ws.onerror = () => { clearTimeout(timer); reject(Error('DOM_WS_ERROR')); };
            });
            return { applied: true };
          },
          verify: async () => ({ checks: [ { name: 'cdp evaluate answered', passed: evalError === null } ] }) });
        if (r.ok === false) return out(r);
        if (evalError) return out({ ok: false, error: 'DOM_EVAL_EXCEPTION', detail: evalError });
        return out({ ok: true, outcome: r.outcome, channel: 'dom', value: value === undefined ? null : value });
      } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'computer_use_browser', description: 'Automate a real Core-owned browser window (fresh isolated profile): navigate an Owner-approved origin, click or fill a selector, read the page text, and verify the observed result with an allowlisted predicate. Other origins are refused.',
      parameters: { type: 'object', properties: { op: { type: 'string', enum: ['open', 'navigate', 'click', 'type', 'read', 'close'] },
        url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' },
        expect: { type: 'object', properties: { kind: { type: 'string', enum: ['text', 'selector', 'url'] }, value: { type: 'string' } } } },
        required: ['op'] },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        if (state.stopped) return out({ ok: false, error: 'DESKTOP_STOPPED' });
        const op = String(args?.op || '');
        if (op === 'close') { const wasOpen = !!state.browser; closeBrowser(); return out({ ok: true, closed: true, wasOpen: wasOpen }); }
        if (!['open', 'navigate', 'click', 'type', 'read'].includes(op)) throw Error('BROWSER_OP_UNKNOWN');
        let origin = null;
        if (op === 'open' || op === 'navigate') {
          if (typeof args?.url !== 'string' || args.url.length > 2000) throw Error('BROWSER_URL_INVALID');
          origin = originOf(args.url);
        } else {
          // click/type/read act on the page that is already open, so they are scoped to its
          // exact origin: a page moved to another origin needs a fresh Owner approval first.
          if (!state.ws || state.ws.readyState !== 1) throw Error('BROWSER_NOT_OPEN');
          const current = await pageState();
          if (!current?.url) throw Error('BROWSER_PAGE_STATE_FAILED');
          origin = originOf(current.url);
        }
        let page = null;
        const r = await authorize(ctx, { op: 'cu-web', scopeToken: 'cu-web:' + op + ':' + origin,
          card: { tool: 'computer_use_browser', run: `${op}${args?.url ? ' ' + String(args.url).slice(0, 100) : ''}${args?.selector ? ' on ' + String(args.selector).slice(0, 60) : ''}`,
            change: 'automate a Core-owned isolated browser window', scope: `exact origin ${origin}`,
            risk: 'A visible browser window is controlled; a fresh profile is used and other origins are refused' },
          parameters: { op, origin, selector: args?.selector ? String(args.selector).slice(0, 200) : null },
          driver: async () => {
            page = await enqueue(ctx.signal, 'browser', async () => {
              if (op === 'navigate' || op === 'open') {
                const result = await browserNavigate(String(args.url), ctx.signal);
                if (new URL(result.url).origin !== origin) throw Error('BROWSER_REDIRECT_REFUSED');
                return result;
              }
              if (op === 'click') return browserClick(args.selector, args.expect, ctx.signal);
              if (op === 'type') return browserType(args.selector, args.text, args.expect, ctx.signal);
              if (op === 'read') { await attachBrowser(ctx.signal); return pageState(); }
              throw Error('BROWSER_OP_UNKNOWN');
            });
            return { page: true };
          },
          verify: async () => ({ checks: [
            { name: 'page state observed', passed: !!page && typeof page.url === 'string' },
            ...(args?.expect ? [{ name: 'expect predicate (observed)', passed: page?.verified === true, observed: page?.verified }] : []) ] }) });
        if (r.ok === false) return out(r);
        if (!page) return out({ ok: false, error: 'NOT_EXECUTED_' + (r.reason || r.outcome) });
        ctx.emit({ type: 'tool', badge: 'CU-WEB', target: `${op} ${String(page.url || '').slice(0, 60)}` });
        return out({ ok: true, outcome: r.outcome, url: page.url, title: page.title, text: page.text,
          verified: page.verified, expect: page.expect });
      } catch (e) {
        const message = String(e?.message || e);
        if (message.startsWith('BROWSER_REDIRECT_REFUSED'))
          return out({ ok: false, error: message, note: 'the page left the authorized origin; the move is reported, never followed silently' });
        if (message.startsWith('BROWSER_')) return out({ ok: false, error: message, note: 'refused before anything was dispatched' });
        return fail(e);
      } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
  ];
}

module.exports = { configureComputerUse, createComputerUseTools, closeBrowser, state, browserAvailable };
