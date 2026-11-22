'use strict';
// DAMAR product launcher for the installed layout (%LOCALAPPDATA%\Programs\DAMAR). Run by damar.cmd with the bundled node.exe.
//   damar [resume [id] | sessions]   start Core if needed, then the CLI
//   damar core start|stop|status     background Core (one per user)
//   damar control [--print]          open DAMAR Control in the browser
//   damar presence                   start the Idle Presence + Notch app
//   damar shutdown                   stop Presence and Core (used by the installer/uninstaller)
//   damar update check               signed update manifest check (disabled unless an update URL and key are configured)
//   damar help | --help | version
// User data lives in DAMAR_DATA_ROOT (default %LOCALAPPDATA%\DAMAR); the install folder is never written.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), os = require('node:os'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..');
const NODE = process.execPath;
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_RAW = path.resolve(process.env.DAMAR_DATA_ROOT && path.isAbsolute(process.env.DAMAR_DATA_ROOT) ? process.env.DAMAR_DATA_ROOT : path.join(LOCAL, 'DAMAR'));
// Core's write guard refuses any path whose components are links or short names. A redirected or junctioned
// %LOCALAPPDATA% is legitimate, so Core gets the fully resolved real path; the guard still applies inside it.
const DATA = (() => { try { return fs.realpathSync.native(DATA_RAW); } catch { return DATA_RAW; } })();
const P = {
  run: path.join(DATA, 'run', 'core.json'), stop: path.join(DATA, 'run', 'stop.request'), last: path.join(DATA, 'state', 'last-core.json'),
  sessions: path.join(DATA, 'sessions'), profile: path.join(DATA, 'profile'), log: path.join(DATA, 'logs', 'core.log'), recovered: path.join(DATA, 'state', 'recovered.json'),
  python: path.join(HOME, 'runtime', 'python'), electron: path.join(HOME, 'runtime', 'electron', 'electron.exe'),
};
const PORT = Number(process.env.DAMAR_CORE_PORT || 29623);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) fail('DAMAR_CORE_PORT must be 1024-65535.');

function fail(msg, code = 1) { console.error('damar: ' + msg); process.exit(code); }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
function env(extra = {}) {
  const e = { ...process.env, DAMAR_DATA_ROOT: DATA, DAMAR_CORE_PORT: String(PORT), DAMAR_KEY_STORE: path.join(DATA, 'provider-keys'), DAMAR_WITNESS_DIR: path.join(DATA, 'authority'), ...extra };
  delete e.NODE_OPTIONS; delete e.DAMAR_TOKEN; // Core refuses both; a developer machine may have them set globally.
  e.PATH = P.python + path.delimiter + (process.env.PATH || ''); // bundled Python first: renderer and sandbox commands
  return e;
}
function running() {
  const s = readJson(P.run);
  return s && Number.isInteger(s.pid) && alive(s.pid) ? s : null;
}
function portFree(port) {
  return new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1'); });
}

// Long-lived supervisor (hidden): owns one Core host, forwards a stop request, records state for the other commands.
async function coreRun() {
  if (running()) return;
  for (const d of [P.sessions, P.profile, path.dirname(P.run), path.dirname(P.last)]) fs.mkdirSync(d, { recursive: true });
  try { fs.unlinkSync(P.stop); } catch {}
  const last = readJson(P.last)?.session;
  const args = [path.join(HOME, 'src', 'core-host', 'core-host.cjs')];
  let session;
  if (last && fs.existsSync(path.join(last, 'FINISHED.json'))) { session = last; args.push(session, '--resume'); }
  else {
    session = path.join(P.sessions, 'core-' + stamp());
    args.push(session);
    // Previous Core ended without a clean stop: recover into a new identity (ledgers kept, no grants replayed).
    if (last && fs.existsSync(path.join(last, 'STARTED.json'))) args.push('--recover-from', last);
  }
  writeJson(P.last, { session, port: PORT, t: new Date().toISOString() });
  const child = spawn(NODE, args, { cwd: HOME, env: env({ DAMAR_CORE_SETTINGS_FILE: path.join(P.profile, 'core-settings.json') }),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  const state = { pid: process.pid, corePid: child.pid, session, port: PORT, ready: false, startedUtc: new Date().toISOString(), version: readJson(path.join(HOME, 'VERSION.json'))?.version || null };
  writeJson(P.run, state);
  // Retention runs before READY is published, so a returning `damar core start` sees the pruned state.
  child.on('message', m => { if (m?.type === 'R7R3_READY') { console.log('READY ' + session); pruneSessions(session, args.includes('--recover-from') ? last : null); state.ready = true; writeJson(P.run, state); } });
  const poll = setInterval(() => { if (fs.existsSync(P.stop)) { try { fs.unlinkSync(P.stop); } catch {} if (child.connected) child.send({ type: 'R7R3_STOP' }); } }, 500);
  child.on('exit', code => {
    clearInterval(poll); try { fs.unlinkSync(P.run); } catch {}
    // A recovery that never reached READY must not block every later start: next start begins a fresh Core.
    if (!state.ready && args.includes('--recover-from')) writeJson(P.last, { session: null, abandonedRecovery: last, t: new Date().toISOString() });
    console.log('EXIT ' + code); process.exit(code ?? 1);
  });
}

// Retention: keep the newest DAMAR_KEEP_SESSIONS (default 5) Core session folders, including the active one. Only folders
// that stopped cleanly (FINISHED.json), were already recovered from, or never started are removed; never the active one
// and never a crashed one that has not been recovered (its ledgers would be lost).
function pruneSessions(active, recoveredFrom) {
  try {
    const keep = Math.max(1, Math.min(1000, Number.parseInt(process.env.DAMAR_KEEP_SESSIONS, 10) || 5));
    const recovered = new Set(readJson(P.recovered) || []);
    if (recoveredFrom) recovered.add(recoveredFrom);
    const dirs = fs.readdirSync(P.sessions).filter(n => /^core-\d{8}-\d{6}$/.test(n)).sort().map(n => path.join(P.sessions, n)).filter(d => d !== active);
    for (const d of dirs.slice(0, Math.max(0, dirs.length - (keep - 1)))) {
      const finished = fs.existsSync(path.join(d, 'FINISHED.json')), started = fs.existsSync(path.join(d, 'STARTED.json'));
      if (!(finished || recovered.has(d) || !started)) continue;
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
      recovered.delete(d); console.log('PRUNED ' + d);
    }
    writeJson(P.recovered, [...recovered].filter(d => fs.existsSync(d)));
  } catch (e) { console.log('PRUNE_SKIPPED ' + (e.code || e.message)); }
}

async function coreStart({ quiet = false, retried = false } = {}) {
  let s = running();
  if (!s) {
    if (!(await portFree(PORT))) fail(`port 127.0.0.1:${PORT} is in use by another program. Set DAMAR_CORE_PORT to a free port.`);
    if (DATA === DATA_RAW && !fs.existsSync(DATA_RAW)) { fs.mkdirSync(DATA_RAW, { recursive: true }); if (fs.realpathSync.native(DATA_RAW) !== DATA_RAW) return relaunch(); }
    fs.mkdirSync(path.dirname(P.log), { recursive: true });
    const log = fs.openSync(P.log, 'a');
    const sup = spawn(NODE, [__filename, '__core-run'], { cwd: HOME, env: env(), detached: true, stdio: ['ignore', log, log], windowsHide: true });
    sup.unref(); fs.closeSync(log);
    if (!quiet) process.stdout.write('Starting DAMAR Core');
  }
  for (let i = 0; i < 240; i++) {
    s = running();
    if (s?.ready) { if (!quiet) console.log(`\nDAMAR Core ready on 127.0.0.1:${s.port}`); return s; }
    if (i > 10 && !s) break;
    if (!quiet && i % 4 === 0) process.stdout.write('.');
    await sleep(500);
  }
  // A failed clean resume leaves the session unfinished (the launcher removed FINISHED.json), so one retry takes the
  // crash-recovery path into a new identity (e.g. a stale canonical audit-ledger lock whose PID Windows reused).
  const last = readJson(P.last)?.session;
  if (!retried && last && !fs.existsSync(path.join(last, 'FINISHED.json')) && fs.existsSync(path.join(last, 'STARTED.json'))) return coreStart({ quiet, retried: true });
  let tail = ''; try { tail = fs.readFileSync(P.log, 'utf8').split(/\r?\n/).slice(-15).join('\n'); } catch {}
  fail(`\nDAMAR Core did not become ready. Log: ${P.log}\n${tail}`);
}

async function coreStop() {
  const s = running();
  if (!s) { console.log('DAMAR Core is not running.'); return; }
  fs.writeFileSync(P.stop, new Date().toISOString());
  for (let i = 0; i < 120; i++) { if (!alive(s.pid)) { console.log('DAMAR Core stopped.'); return; } await sleep(500); }
  fail('DAMAR Core did not stop within 60 s; nothing was force-killed. See ' + P.log);
}

function presencePids() {
  // Only Electron processes started from THIS install's runtime folder.
  const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq '${P.electron.replace(/'/g, "''")}' -and $_.CommandLine -notlike '*gui-launch*' } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
}

// First run under a redirected/junctioned folder: the data root did not exist when DATA was resolved; restart once so
// every path (and the supervisor) uses the real location.
function relaunch() {
  const r = spawnSync(NODE, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
}

// ---- update check: <url> is a JSON manifest, <url>.sig its base64 Ed25519 signature over the exact bytes.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const newer = (a, b) => { const x = SEMVER.exec(a).slice(1).map(Number), y = SEMVER.exec(b).slice(1).map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
function verifyUpdate(bytes, signatureB64, publicKeyPem, current) {
  if (!crypto.verify(null, Buffer.from(bytes), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signatureB64).trim(), 'base64'))) throw Error('UPDATE_SIGNATURE_INVALID');
  const m = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (m.product !== 'DAMAR' || !SEMVER.test(m.version || '') || !/^https:\/\//.test(m.installer?.url || '') || !/^[a-f0-9]{64}$/.test(m.installer?.sha256 || '')) throw Error('UPDATE_MANIFEST_INVALID');
  return { current, latest: m.version, updateAvailable: SEMVER.test(current || '') ? newer(m.version, current) : true, installer: m.installer, notes: typeof m.notes === 'string' ? m.notes.slice(0, 2000) : null };
}
async function updateCheck() {
  const cfg = readJson(path.join(HOME, 'release', 'update.json')) || {};
  const url = process.env.DAMAR_UPDATE_URL || cfg.url, key = cfg.publicKey;
  if (!url || !key) return console.log('Update check is disabled: no update URL or signing key is configured in this build.');
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1')) fail('update URL must be https.');
  const get = async x => { const r = await fetch(x, { redirect: 'error', signal: AbortSignal.timeout(15000) }); if (!r.ok) throw Error('UPDATE_HTTP_' + r.status); return Buffer.from(await r.arrayBuffer()); };
  const [bytes, sig] = await Promise.all([get(url), get(url + '.sig')]);
  const r = verifyUpdate(bytes, sig.toString('utf8'), key, readJson(path.join(HOME, 'VERSION.json'))?.version);
  console.log(r.updateAvailable ? `DAMAR ${r.latest} is available (installed: ${r.current}).\nDownload: ${r.installer.url}\nSHA-256:  ${r.installer.sha256}\nVerify the download, then run the installer (your data is kept).` : `DAMAR is up to date (${r.current}).`);
}

function help() {
  console.log(`DAMAR ${readJson(path.join(HOME, 'VERSION.json'))?.version || ''}

Usage:
  damar                     Start DAMAR Core if needed, then open the CLI in this terminal
  damar resume [id]         Pick a saved session, or resume one by id
  damar sessions            List saved sessions
  damar core start|stop|status
  damar control [--print]   Open DAMAR Control in your browser (--print shows the private URL instead)
  damar presence            Start DAMAR Presence (Idle Presence + Notch)
  damar shutdown            Stop Presence and Core
  damar update check        Check for a newer signed release (when configured)
  damar version | help

The folder you start "damar" from is the agent's workspace.
Data: ${DATA}
Docs: ${path.join(HOME, 'docs')}`);
}

async function main(argv) {
  const [cmd, sub] = argv;
  if (['help', '--help', '-h', '/?'].includes(cmd)) return help();
  if (['version', '--version', '-v'].includes(cmd)) return console.log(JSON.stringify(readJson(path.join(HOME, 'VERSION.json')) || { version: 'unknown' }, null, 1));
  if (cmd === '__core-run') return coreRun();
  if (cmd === 'update') { if (sub !== 'check') fail('usage: damar update check'); return updateCheck(); }
  if (cmd === 'core') {
    if (sub === 'start') return void await coreStart();
    if (sub === 'stop') return coreStop();
    if (sub === 'status') { const s = running(); console.log(JSON.stringify(s ? { running: true, ...s } : { running: false, port: PORT, dataRoot: DATA }, null, 1)); process.exitCode = s?.ready ? 0 : 3; return; }
    fail('usage: damar core start|stop|status');
  }
  if (cmd === 'control') {
    const s = await coreStart({ quiet: true });
    const r = spawnSync(NODE, [path.join(HOME, 'src', 'control', 'launch.cjs'), s.session, ...(argv.includes('--print') ? ['--print'] : [])], { stdio: 'inherit', env: env(), windowsHide: true });
    process.exitCode = r.status ?? 1; return;
  }
  if (cmd === 'presence') {
    const s = await coreStart({ quiet: true });
    if (presencePids().length) { console.log('DAMAR Presence is already running.'); return; }
    const e = env(); delete e.ELECTRON_RUN_AS_NODE;
    spawn(P.electron, [path.join(HOME, 'src', 'presence'), '--profile', P.profile, '--session', s.session], { cwd: HOME, env: e, detached: true, stdio: 'ignore' }).unref();
    console.log('DAMAR Presence started.'); return;
  }
  if (cmd === 'shutdown') {
    for (const pid of presencePids()) { try { process.kill(pid); } catch {} }
    return coreStop();
  }
  // Everything else is the CLI (damar, damar resume [id], damar sessions); RUN_DAMAR_CLI.ps1 validates the arguments.
  const s = await coreStart({ quiet: true });
  process.on('SIGINT', () => {}); // Ctrl+C belongs to the CLI
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HOME, 'RUN_DAMAR_CLI.ps1'), ...argv, '-Session', s.session, '-Profile', P.profile],
    { stdio: 'inherit', env: env() });
  process.exitCode = r.status ?? 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(e => fail(e?.message || String(e)));
module.exports = { verifyUpdate, newer, pruneSessions };
