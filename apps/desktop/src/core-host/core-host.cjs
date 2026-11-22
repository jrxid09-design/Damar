'use strict';
// Run-owned isolated Core host on the approved endpoint 127.0.0.1:29623.
// Composes the existing inherited r7r3 launcher (jobs/approval authority) with a per-session copy of a
// hash-pinned canonical Damar snapshot (core-snapshot/) for: a fixed allowlist of authenticated read-only
// console GET routes, and Owner-gated Pandawa runs through canonical agentHub against an OFFLINE fixture
// provider. Outbound network is restricted to loopback. No other canonical route is reachable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Installed product: DAMAR_DATA_ROOT (absolute, e.g. %LOCALAPPDATA%\DAMAR) replaces the development scratch root.
const DATA_ROOT = process.env.DAMAR_DATA_ROOT && path.isAbsolute(process.env.DAMAR_DATA_ROOT) ? path.resolve(process.env.DAMAR_DATA_ROOT) : null;
const CANDIDATE = path.resolve(__dirname, '../..');
// Development fallback: the r7r3-scratch folder two levels above the candidate checkout (no machine path in shipped code).
const SCRATCH = DATA_ROOT || path.resolve(CANDIDATE, '../../r7r3-scratch');
// A fresh development checkout has no scratch root yet; create it (the installed product uses DATA_ROOT).
if (!DATA_ROOT) fs.mkdirSync(SCRATCH, { recursive: true });
const SNAPSHOT = path.resolve(process.env.DAMAR_CORE_SNAPSHOT || path.join(CANDIDATE, 'core-snapshot'));
const PORT = Number(process.env.DAMAR_CORE_PORT || 29623);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw Error('CORE_PORT_INVALID');
// Retired inherited UI surfaces (old control centre, previews, mobile/presence prototypes). DAMAR Control is /control/.
const LEGACY_UI = /^\/(cc2|uix|__r6|__preview-adapters|s|mobile)(\/|$|\?)/;
const retired = res => { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ success: false, error: 'LEGACY_SURFACE_RETIRED' })); };
const READ_ROUTES = Object.freeze(['/api/v1/console/tools', '/api/v1/console/plugins', '/api/v1/console/mcp/servers', '/api/v1/console/agents', '/api/v1/console/safety', '/api/v1/console/memory/stats', '/api/v1/console/context']);

function insideScratch(target) {
  const t = path.resolve(target).toLowerCase();
  return t.startsWith(SCRATCH.toLowerCase() + path.sep);
}

function cleanEnvironment(directory) {
  const home = path.join(directory, 'home');
  const env = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[key]) env[key] = process.env[key];
  const sys = process.env.SystemRoot || 'C:\\Windows';
  Object.assign(env, {
    // powershell.exe is required by the inherited leader lease for process start identity.
    PATH: `${sys}\\System32;${sys};${sys}\\System32\\WindowsPowerShell\\v1.0`,
    DAMAR_CORE_PORT: String(PORT),
    USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'),
    // Production unless the offline test fixtures are requested (they refuse to run outside NODE_ENV=test).
    NODE_ENV: process.env.DAMAR_CORE_TEST_FIXTURES === '1' ? 'test' : 'production',
    NODE_PATH: (process.env.DAMAR_REQUIRE_TRACE && process.env.DAMAR_TRACE_NODE_PATH) || path.join(SNAPSHOT, 'node_modules'), DAMAR_CORE_HOST_CHILD: '1', DAMAR_CORE_SNAPSHOT: SNAPSHOT,
  });
  if (process.env.DAMAR_CORE_TEST_FIXTURES === '1') env.DAMAR_CORE_TEST_FIXTURES = '1';
  if (DATA_ROOT) env.DAMAR_DATA_ROOT = DATA_ROOT;
  // Absolute interpreter for allowlisted workspace commands (the child PATH holds System32 only).
  const python = findPython();
  if (python) env.DAMAR_PYTHON = python;
  // Remembered provider keys (DPAPI, current user) live in the real user profile, not the session's private home.
  env.DAMAR_KEY_STORE = process.env.DAMAR_KEY_STORE && path.isAbsolute(process.env.DAMAR_KEY_STORE) ? process.env.DAMAR_KEY_STORE
    : path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'DAMAR', 'provider-keys');
  if (process.env.DAMAR_EGRESS === 'loopback') env.DAMAR_EGRESS = 'loopback';
  // The Owner-approved workspace_shell tool runs with the user's real PATH and profile, not the session home.
  for (const [k, v] of Object.entries({ PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP })) if (v) env['DAMAR_USER_' + k] = v;
  // Model-grant rollback witness also lives in the real profile, outside every session directory.
  env.DAMAR_WITNESS_DIR = process.env.DAMAR_WITNESS_DIR && path.isAbsolute(process.env.DAMAR_WITNESS_DIR) ? process.env.DAMAR_WITNESS_DIR
    : path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'DAMAR', 'authority');
  // Sandbox grant registry (crash sweep); tests point it at a scratch file.
  if (process.env.DAMAR_SANDBOX_REGISTRY && path.isAbsolute(process.env.DAMAR_SANDBOX_REGISTRY)) env.DAMAR_SANDBOX_REGISTRY = process.env.DAMAR_SANDBOX_REGISTRY;
  // Owner settings are profile-scoped across distinct Core sessions. Keep this data-only file under the
  // approved scratch root; test hosts can select an isolated profile file the same way.
  if (process.env.DAMAR_CORE_SETTINGS_FILE && path.isAbsolute(process.env.DAMAR_CORE_SETTINGS_FILE) && insideScratch(process.env.DAMAR_CORE_SETTINGS_FILE))
    env.DAMAR_CORE_SETTINGS_FILE = process.env.DAMAR_CORE_SETTINGS_FILE;
  if (process.env.DAMAR_PROVIDER_DEADLINES_FILE && insideScratch(process.env.DAMAR_PROVIDER_DEADLINES_FILE)) env.DAMAR_PROVIDER_DEADLINES_FILE = process.env.DAMAR_PROVIDER_DEADLINES_FILE;
  // Builder-only trace mode (scripts/build-core-snapshot.cjs) records which packages Core actually loads.
  if (process.env.DAMAR_REQUIRE_TRACE) env.DAMAR_REQUIRE_TRACE = process.env.DAMAR_REQUIRE_TRACE;
  return env;
}

// First real python.exe on the parent PATH (the Microsoft Store alias stub under WindowsApps is skipped).
function findPython() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir || /\\WindowsApps\\?$/i.test(dir)) continue;
    const exe = path.join(dir, 'python.exe');
    try { if (fs.statSync(exe).isFile()) return exe; } catch {}
  }
  return null;
}

function hashTree(root) {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('CANONICAL_REPARSE_REFUSED');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      }
    }
  })(root);
  return files;
}
const sameTree = (a, b) => a.length === b.length && a.every((row, i) => row.path === b[i].path && row.sha256 === b[i].sha256);

// Deny every outbound TCP connection that is not loopback. Records denials for evidence.
// `allow`: exact public hostnames still reachable on port 443 (Mata Dewa feeds, src/mata-dewa/egress.cjs HOSTS).
function installEgressGuard(allow = []) {
  const net = require('node:net'), denied = [];
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (o && o.path === undefined) {
      const host = String(o.host ?? 'localhost').replace(/^\[|\]$/g, '').toLowerCase();
      if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !(allow.includes(host) && Number(o.port) === 443)) {
        denied.push({ host: host.slice(0, 64), port: Number(o.port) || null });
        process.nextTick(() => this.destroy(Error('EGRESS_DENIED_ISOLATED_CORE')));
        return this;
      }
    }
    return original.apply(this, args);
  };
  return denied;
}

// Parent mode: refuse unsafe inputs, then run the child with a clean, redirected environment.
function parent(directory, resume, recoverFrom) {
  if (!directory || !path.isAbsolute(directory) || !insideScratch(directory) || directory.split(/[\\/]/).includes('..')) throw Error('EXPLICIT_NEW_SCRATCH_SESSION_REQUIRED');
  if (resume ? !fs.existsSync(path.join(directory, 'FINISHED.json')) : fs.existsSync(directory)) throw Error(resume ? 'FINISHED_SESSION_REQUIRED_FOR_RESUME' : 'SESSION_DIRECTORY_EXISTS');
  if (process.env.NODE_OPTIONS) throw Error('NODE_OPTIONS_REFUSED');
  if (recoverFrom && !insideScratch(recoverFrom)) throw Error('SCRATCH_RECOVERY_SOURCE_REQUIRED');
  if (recoverFrom) {
    // Crash recovery into a NEW identity (inherited contract: rotated credentials, no grants, supervisor OFF).
    // Core's append-only Pandawa/receipt/session ledgers move byte-exact; interrupted work becomes OUTCOME_UNKNOWN, never replayed.
    require(path.join(CANDIDATE, 'inherited-v53/scripts/r7r3-recover.cjs')).recover(path.resolve(recoverFrom), directory, SCRATCH);
    for (const f of ['pandawa-runs.jsonl', 'usage-receipts.jsonl', 'cli-sessions.jsonl', 'agent-turn-history.jsonl', 'agent-turns.jsonl', 'checkpoints.jsonl', 'project-memory.jsonl', 'discussions.jsonl']) if (fs.existsSync(path.join(recoverFrom, f))) fs.copyFileSync(path.join(recoverFrom, f), path.join(directory, f), fs.constants.COPYFILE_EXCL);
  }
  const lifecycle = require('./core-lifecycle.cjs'), statusFile = path.join(directory, 'core-lifecycle.json');
  let currentResume = resume, activeChild = null, shutdownRequested = false, restartRequested = false, stopTimedOut = false;
  let reserved = null, restartTimes = [], stopTimer = null;
  const childEnv = cleanEnvironment(directory);
  const mark = (state, reason = null) => { try { lifecycle.writeStatus(statusFile, { state, reason, attempt: restartTimes.length }); } catch {} };
  const finishParent = code => { process.exitCode = code ?? 1; if (process.connected) process.disconnect(); };
  function requestStop() {
    if (shutdownRequested) return;
    shutdownRequested = true; mark('STOPPING');
    if (activeChild?.connected) activeChild.send({ type: 'R7R3_STOP' });
    stopTimer = setTimeout(() => { if (activeChild && activeChild.exitCode === null) { stopTimedOut = true; mark('STOP_TIMEOUT', 'GRACEFUL_SHUTDOWN_TIMEOUT'); console.error('CORE_STOP_TIMEOUT: session and process preserved; no force termination was attempted.'); } }, lifecycle.STOP_TIMEOUT_MS);
    stopTimer.unref?.();
  }
  function startChild() {
    const args = [__filename, directory, ...(currentResume ? ['--resume'] : []), ...(recoverFrom ? ['--recovered'] : [])];
    mark(currentResume ? 'RESUMING' : 'STARTING');
    const child = spawn(process.execPath, args, { env: childEnv, cwd: CANDIDATE, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    activeChild = child; restartRequested = false; reserved = null; stopTimedOut = false;
    child.on('message', message => {
      if (message?.type === 'R7R3_READY') { mark('READY'); if (process.send) process.send({ type: 'R7R3_READY' }); return; }
      if (message?.type === 'R7R3_RESTART_RESERVE' && typeof message.requestId === 'string') {
        const now = Date.now(); restartTimes = restartTimes.filter(t => now - t < lifecycle.RESTART_WINDOW_MS);
        const allowed = !shutdownRequested && !restartRequested && !reserved && restartTimes.length < lifecycle.MAX_RESTARTS_PER_WINDOW;
        if (allowed) reserved = { requestId: message.requestId, expiresAt: now + 5000 };
        if (child.connected) child.send({ type: allowed ? 'R7R3_RESTART_RESERVED' : 'R7R3_RESTART_RESERVATION_FAILED', requestId: message.requestId });
        return;
      }
      if (message?.type === 'R7R3_RESTART_CANCEL' && reserved?.requestId === message.requestId) { reserved = null; return; }
      if (message?.type === 'R7R3_RESTART_COMMIT' && reserved?.requestId === message.requestId && reserved.expiresAt > Date.now()) {
        reserved = null; restartTimes.push(Date.now()); restartRequested = true; currentResume = true; mark('STOPPING_FOR_RESTART');
        if (child.connected) child.send({ type: 'R7R3_STOP' });
        stopTimer = setTimeout(() => { if (activeChild === child && child.exitCode === null) { stopTimedOut = true; mark('STOP_TIMEOUT', 'RESTART_GRACEFUL_SHUTDOWN_TIMEOUT'); console.error('CORE_RESTART_TIMEOUT: existing session and Core process preserved; no force termination was attempted.'); } }, lifecycle.STOP_TIMEOUT_MS);
        stopTimer.unref?.(); return;
      }
      if (message?.type === 'R7R3_STOP') { requestStop(); return; }
      if (process.send) process.send(message);
    });
    child.on('error', () => { mark('FAILED', 'CORE_CHILD_START_FAILED'); finishParent(1); });
    child.on('exit', code => {
      if (activeChild !== child) return;
      clearTimeout(stopTimer); activeChild = null;
      if (shutdownRequested) { mark(code === 0 ? 'STOPPED' : 'STOP_FAILED', code === 0 ? null : 'CORE_EXIT_NONZERO'); finishParent(code === 0 ? 0 : code); return; }
      if (restartRequested) {
        const finished = fs.existsSync(path.join(directory, 'FINISHED.json'));
        if (code !== 0 || !finished || stopTimedOut) {
          mark('RESTART_FAILED', !finished ? 'FINISHED_MARKER_MISSING' : code !== 0 ? 'CORE_EXIT_NONZERO' : 'SHUTDOWN_TIMEOUT');
          console.error('CORE_RESTART_FAILED: durable finish was not confirmed; session was preserved and no process was force-killed.');
          finishParent(1); return;
        }
        mark('RESTARTING'); setTimeout(startChild, 100); return;
      }
      mark('EXITED', code === 0 ? null : 'UNEXPECTED_CORE_EXIT'); finishParent(code ?? 1);
    });
  }
  process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
  process.on('message', message => { if (message?.type === 'R7R3_STOP') requestStop(); });
  startChild();
}

async function child(directory, resume, recovered = false) {
  if (!insideScratch(process.env.USERPROFILE || '') || process.env.DAMAR_TOKEN) throw Error('UNISOLATED_ENVIRONMENT_REFUSED');
  if (process.env.DAMAR_REQUIRE_TRACE) {
    const Module = require('node:module'), seen = new Set(), resolve = Module._resolveFilename;
    Module._resolveFilename = function (...a) { const f = resolve.apply(this, a); if (f.includes('node_modules')) seen.add(f); return f; };
    process.on('exit', () => fs.writeFileSync(process.env.DAMAR_REQUIRE_TRACE + '.' + process.pid + '.json', JSON.stringify([...seen].sort(), null, 1)));
  }
  const snapshotManifest = JSON.parse(fs.readFileSync(path.join(SNAPSHOT, 'SNAPSHOT_MANIFEST.json'), 'utf8'));
  const lifecycleBridge = require('./core-lifecycle.cjs').createChildBridge({ file: path.join(directory, 'core-lifecycle.json') });
  // Owner policy: Core may reach the network (web tools, Mata Dewa feeds, remote providers).
  // DAMAR_EGRESS=loopback restores the isolated loopback-only Core.
  const egressDenied = process.env.DAMAR_EGRESS === 'loopback' ? installEgressGuard(require('../mata-dewa/egress.cjs').HOSTS) : [];
  const { start } = require(path.join(CANDIDATE, 'inherited-v53/src/r7r3/launcher.cjs'));
  // Launcher creates/resumes the session directory, credentials and installs the scratch-only write guard.
  const runtime = await start({ directory, port: PORT, resume, recovered, scratchRoot: SCRATCH });
  // The inherited server listens before the host routes below are wired: until then DAMAR routes answer 503
  // CORE_STARTING (never the inherited app's 404, which a reconnecting CLI would read as "turn unknown").
  const OURS = /^\/api\/(r9\/|v1\/console)/;
  const bootOriginal = runtime.server.listeners('request');
  runtime.server.removeAllListeners('request');
  runtime.server.on('request', (req, res) => {
    if (LEGACY_UI.test(req.url || '')) return retired(res);
    if (!OURS.test(req.url || '')) { for (const l of bootOriginal) l.call(runtime.server, req, res); return; }
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1' }); res.end(JSON.stringify({ success: false, error: 'CORE_STARTING' }));
  });
  // Materialize the (empty, valid) durable job state so inherited crash recovery always has a source to copy.
  if (!resume && !recovered) try { fs.writeFileSync(path.join(directory, 'jobs.json'), JSON.stringify({ schemaVersion: 1, sequence: 0, plans: [], events: [] }), { flag: 'wx', mode: 0o600 }); } catch {}
  let shutdownTurns = async () => {}, sandboxLifecycle = null;
  const fixturesEnabled = process.env.DAMAR_CORE_TEST_FIXTURES === '1';
  if (process.env.NODE_ENV !== 'test' && fixturesEnabled) throw Error('FIXTURES_REQUIRE_ISOLATED_TEST_ENVIRONMENT');
  const providers = {};
  if (fixturesEnabled) {
    const { createOfflineProvider } = require('./offline-provider.cjs');
    providers['offline-fixture-a'] = createOfflineProvider({ id: 'offline-fixture-a', model: 'damar-offline-fixture-a', models: ['damar-offline-fixture-a', 'damar-offline-fixture-a-mini'], imageInput: false });
    providers['offline-fixture-b'] = createOfflineProvider({ id: 'offline-fixture-b', model: 'damar-offline-fixture-b', models: ['damar-offline-fixture-b', 'damar-offline-fixture-b-mini'], imageInput: false });
  }
  try {
    for (const p of Object.values(providers)) await p.start();
    for (const sub of ['home/tmp', 'home/AppData/Roaming', 'home/AppData/Local', 'canonical/cwd', 'canonical/configs']) fs.mkdirSync(path.join(directory, sub), { recursive: true });
    const copyRoot = path.join(directory, 'canonical');
    const pinned = hashTree(path.join(SNAPSHOT, 'src'));
    if (!sameTree(pinned, snapshotManifest.src.files)) throw Error('CORE_SNAPSHOT_MANIFEST_MISMATCH');
    if (!resume) {
      fs.cpSync(path.join(SNAPSHOT, 'src'), path.join(copyRoot, 'src'), { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      fs.copyFileSync(path.join(SNAPSHOT, 'package.json'), path.join(copyRoot, 'package.json'));
    }
    const copy = hashTree(path.join(copyRoot, 'src'));
    if (!sameTree(pinned, copy)) throw Error('CANONICAL_COPY_MISMATCH');
    if (!resume) fs.writeFileSync(path.join(copyRoot, 'CANONICAL_COPY_MANIFEST.json'), JSON.stringify({ count: copy.length, snapshotAggregate: snapshotManifest.src.aggregate, files: copy }), { flag: 'wx' });
    const fixture = providers['offline-fixture-a'];
    const canonicalProviders = fixturesEnabled
      ? { active: 'custom', providers: { custom: { apiKey: 'offline-fixture', baseUrl: fixture.baseUrl(), model: fixture.model } }, llamacpp: { model: null }, updatedAt: null }
      : { active: 'custom', providers: { custom: { apiKey: null, baseUrl: null, model: null } }, llamacpp: { model: null }, updatedAt: null };
    fs.writeFileSync(path.join(copyRoot, 'configs/providers.json'), JSON.stringify(canonicalProviders));
    const credFile = path.join(directory, 'console-credentials.json');
    if (!fs.existsSync(credFile)) fs.writeFileSync(credFile, JSON.stringify({ console: crypto.randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 });
    process.env.DAMAR_TOKEN = JSON.parse(fs.readFileSync(credFile, 'utf8')).console;
    process.chdir(path.join(copyRoot, 'cwd')); // dotenv reads cwd/.env: none exists here.
    const app = require(path.join(copyRoot, 'src/app.js'));
    const hub = require(path.join(copyRoot, 'src/services/agentHub.js'));
    const providerConfig = require(path.join(copyRoot, 'src/services/providerConfigService.js'));
    const aiRuntime = require(path.join(copyRoot, 'src/services/aiRuntimeService.js'));
    const usageService = require(path.join(copyRoot, 'src/services/usageService.js'));
    const deadlines = require('./provider-deadlines.cjs').createProviderDeadlines(process.env.DAMAR_PROVIDER_DEADLINES_FILE || path.join(directory, 'provider-deadlines.json'));
    deadlines.install({ aiRuntime, HttpClient: require(path.join(copyRoot, 'src/plugins/http/services/HttpClient.js')),
      turnContext: require('./agent-turns.cjs').turnContext });
    const keyStoreDir = process.env.DAMAR_KEY_STORE || path.join(require('node:os').homedir(), 'AppData', 'Local', 'DAMAR', 'provider-keys');
    const keyStore = require('./key-store.cjs').createKeyStore({ dir: keyStoreDir, python: process.env.DAMAR_PYTHON && path.isAbsolute(process.env.DAMAR_PYTHON) ? process.env.DAMAR_PYTHON : null });
    let registry = null;
    // Grants are durable across Core sessions: journal + key beside provider-connections.json (tests: session directory).
    const grantsDir = fixturesEnabled ? directory : keyStoreDir;
    const modelGrants = require('./model-grants.cjs').createModelGrants({ directory: (fs.mkdirSync(grantsDir, { recursive: true }), grantsDir), candidate: CANDIDATE, port: PORT,
      ownerAuthority: require('./model-grants.cjs').profileSecret(grantsDir),
      witness: process.env.DAMAR_WITNESS_DIR ? require('./user-witness.cjs').createUserWitness({ root: process.env.DAMAR_WITNESS_DIR }) : null });
    const providerRuntime = fixturesEnabled ? null : require('./provider-runtime.cjs').createProviderRuntime({ providerConfig, aiRuntime,
      canDispatch: () => registry?.active()?.executable === true });
    if (providerRuntime) aiRuntime.reconfigure();
    registry = require('./provider-registry.cjs').createProviderRegistry({
      fixtures: Object.values(providers),
      // Provider connections are user-scoped and persist next to the remembered keys (isolated tests: the session directory).
      routeFile: path.join(fixturesEnabled ? directory : keyStoreDir, 'provider-connections.json'), modelGrants,
      keyStore, applyLive: providerRuntime ? args => providerRuntime.activate(args) : undefined,
      applyFixture: async (fixture, model) => {
        if (!fixturesEnabled) throw Error('FIXTURES_DISABLED');
        providerConfig.setProvider('custom', { apiKey: 'offline-fixture', baseUrl: fixture.baseUrl(), model });
        providerConfig.setActive('custom');
        await aiRuntime.reconfigure();
      },
    });
    // Provider router (key rotation, cooldown/failover, combos) sits inside the usage meter: install it first.
    const routeOverride = () => require('./cognitive.cjs').runScope.getStore()?.route || null;
    const providerRouter = require('./provider-router.cjs').createProviderRouter({ registry, routeOverride, timeouts: () => deadlines.view() });
    if (providerRuntime) providerRouter.installCanonical(require(path.join(copyRoot, 'src/plugins/http/services/HttpClient.js')), { transport: true });
    const usageLedgerFile = process.env.DAMAR_KEY_STORE && insideScratch(keyStoreDir)
      ? path.join(keyStoreDir, 'live-inference-usage.jsonl')
      : path.join(SCRATCH, 'provider-usage', 'live-inference-usage.jsonl');
    const liveBudget = providerRuntime ? require('./provider-budget.cjs').createProviderBudget({
      file: usageLedgerFile,
      httpClient: require(path.join(copyRoot, 'src/plugins/http/services/HttpClient.js')),
      turnContext: require('./agent-turns.cjs').turnContext,
      // A Pandawa member route is metered against (and billed to) the routed target's own grant, not the selection's.
      provider: () => { const a = registry.active(), o = a.kind === 'live' ? routeOverride() : null; if (!o) return a;
        const t = registry.targets(o.connection, o.model)[0];
        return t ? { ...a, executable: true, limits: t.auth?.limits, injectedTokens: t.injectedTokens, billed: { id: t.id, model: t.model } } : { ...a, executable: false, reason: 'LIVE_MODEL_NOT_AUTHORIZED' }; },
      ledger: registry.active().ledger,
      inputTokenBound: require('./provider-budget.cjs').byteInputBound,
    }) : null;
    providerRouter.useBudget(liveBudget);
    // DAMAR /v1 gateway: its own listener (off until the Owner enables it in Control), settings + keys beside the profile.
    const gateway = require('./gateway.cjs').createGateway({ file: path.join(grantsDir, 'gateway.json'), registry, router: providerRouter, budget: liveBudget });
    try { await gateway.start(); } catch (error) { console.error('GATEWAY_START_FAILED ' + error.code); }
    const providerAdmin = require('./provider-admin-routes.cjs').createProviderAdminRoutes({ registry, router: providerRouter, gateway, budget: liveBudget });
    // Agent turns: Core's real agent loop with host workspace tools under real Core authority grants (see workspace-*.cjs).
    const PROTECTED = [path.resolve('C:/Workspace/Damar'), path.resolve(__dirname, '../../../../ui-prototypes') /* Owner-approved UI design prototypes */, path.resolve('C:/Workspace/damar-uix-control-center-v2'),
      path.join(SCRATCH, 'fidelity-v53-20261113-204927'), path.dirname(CANDIDATE), directory, SNAPSHOT, ...(DATA_ROOT ? [DATA_ROOT] : [])];
    const { isProtected } = require('./workspace-tools.cjs');
    const settingsFile = process.env.DAMAR_CORE_SETTINGS_FILE && insideScratch(process.env.DAMAR_CORE_SETTINGS_FILE)
      ? process.env.DAMAR_CORE_SETTINGS_FILE : path.join(directory, 'core-settings.json');
    const coreSettings = require('./core-settings.cjs').createCoreSettings({ file: settingsFile, isProtected: p => isProtected(p, PROTECTED) });
    const authority = require('./workspace-authority.cjs').createWorkspaceAuthority({ coreSrc: path.join(copyRoot, 'src'), dataDir: path.join(directory, 'workspace-authority') });
    let r9 = null;
    shutdownTurns = () => Promise.all([turns.shutdown(), team.shutdown()]);
    require('./agent-turns.cjs').installTurnFetch(u => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u));
    const turns = require('./agent-turns.cjs').createAgentTurns({ aiRuntime, isProtectedRoot: p => isProtected(p, PROTECTED),
      recordUsage: e => r9.recordTurnUsage(e), activeProvider: () => registry.active(), offeredTools: () => tools,
      authorize: (session, client) => r9.sessions.requireAttached(session, client), settings: coreSettings,
      holds: (session, client) => r9.sessions.holds(session, client),
      historyFile: path.join(directory, 'agent-turn-history.jsonl'), journalFile: path.join(directory, 'agent-turns.jsonl'), projectMemory: { select: (...a) => projectMemory.select(...a) }, appendDurable: require('./r9-routes.cjs').appendDurable, readJsonl: require('./r9-routes.cjs').readJsonl, deadlines });
    // Project memory is profile-scoped (next to the Owner settings) so it survives crash recovery; the session file is imported once.
    const projectMemory = require('./project-memory.cjs').createProjectMemory({ file: path.join(path.dirname(settingsFile), 'project-memory.jsonl'), legacyFile: path.join(directory, 'project-memory.jsonl'), appendDurable: require('./r9-routes.cjs').appendDurable, readJsonl: require('./r9-routes.cjs').readJsonl });
    // Host context joins Core's system prompt (never replaces it) + reply-language directive; Core's MemoryService reads project memory.
    require('./cognitive.cjs').installAssemble({ aiRuntime, settings: coreSettings });
    require('./cognitive.cjs').installMemoryBridge({ memoryService: require(path.join(copyRoot, 'src/memory/services/MemoryService.js')), projectMemory, settings: coreSettings });
    // Core's consciousness singleton: scoped per CLI session and switchable (cognitive.mind).
    require('./cognitive.cjs').installMind({ mind: require(path.join(copyRoot, 'src/consciousness')), settings: coreSettings,
      sessionOf: () => { const t = require('./agent-turns.cjs').turnContext.getStore(); return t ? turns.get(t.id)?.cliSession ?? null : null; } });
    const checkpoints = require('./checkpoints.cjs').createCheckpoints({ file: path.join(directory, 'checkpoints.jsonl'), appendDurable: require('./r9-routes.cjs').appendDurable, readJsonl: require('./r9-routes.cjs').readJsonl,
      writeFile: require('./workspace-tools.cjs').writeFile, authority, protectedRoots: PROTECTED, node: process.execPath });
    const sys = process.env.SystemRoot || 'C:\\Windows', home = path.join(directory, 'home');
    const python = process.env.DAMAR_PYTHON && path.isAbsolute(process.env.DAMAR_PYTHON) ? process.env.DAMAR_PYTHON : null;
    const childEnv = { SystemRoot: sys, PATH: [python && path.dirname(python), `${sys}\\System32`].filter(Boolean).join(';'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'),
      USERPROFILE: home, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' };
    // Agent commands and file writes run in the Job Object + no-capability AppContainer; grants recorded per Core session.
    require('./workspace-tools.cjs').configureSandbox({ python, ledger: path.join(directory, 'sandbox-grants.jsonl'), scratch: directory });
    // Grant lifecycle: sweep the grants of Cores that died (crash recovery), register this one, revoke on stop.
    sandboxLifecycle = require('./sandbox-lifecycle.cjs').createSandboxLifecycle({ ledger: path.join(directory, 'sandbox-grants.jsonl'),
      registry: process.env.DAMAR_SANDBOX_REGISTRY && path.isAbsolute(process.env.DAMAR_SANDBOX_REGISTRY) ? process.env.DAMAR_SANDBOX_REGISTRY : path.join(SCRATCH, 'damar-sandbox-registry.jsonl') });
    const swept = sandboxLifecycle.register();
    fs.writeFileSync(path.join(directory, 'sandbox-sweep.json'), JSON.stringify({ t: new Date().toISOString(), ...swept }));
    const tools = require('./workspace-tools.cjs').createWorkspaceTools({ AITool: require(path.join(copyRoot, 'src/ai/models/AITool.js')),
      authority, broker: turns.broker, protectedRoots: PROTECTED, exes: { python, node: process.execPath }, childEnv, checkpoints, projectMemory, settings: coreSettings, pandawa: { workers: require('./r9-routes.cjs').WORKERS, start: x => r9.pandawa.start(x), view: id => r9.pandawa.view(id), cancel: id => r9.pandawa.cancel(id) } });
    // Computer-Use: the shared Core-owned desktop broker (same authority bridge as the workspace tools).
    // Fail closed: without the sandbox python there is no desktop helper and no computer use.
    require('./computer-use.cjs').configureComputerUse({ python, scratch: path.join(directory, 'cu'), browserExe: null });
    const cuTools = require('./computer-use.cjs').createComputerUseTools({ AITool: require(path.join(copyRoot, 'src/ai/models/AITool.js')),
      authority, broker: turns.broker, settings: coreSettings,
      visionCapable: () => { try { return registry.active()?.capabilities?.imageInput === 'verified'; } catch { return false; } } });
    const nativeTools = aiRuntime.nativeTools.bind(aiRuntime);
    aiRuntime.nativeTools = () => [...nativeTools(), ...tools, ...cuTools];
    aiRuntime.ensure(); aiRuntime.refreshTools();
    await authority.init();
    // Pandawa team: per-member models (pandawa.models.*) and DAMAR-led discussions; members keep their canonical roles, no tools.
    const identity = require(path.join(copyRoot, 'src/services/pandawaIdentity.js'));
    const team = require('./pandawa-team.cjs').createPandawaTeam({ registry, router: providerRuntime ? providerRouter : null, settings: coreSettings, projectMemory, file: path.join(directory, 'discussions.jsonl'),
      appendDurable: require('./r9-routes.cjs').appendDurable, readJsonl: require('./r9-routes.cjs').readJsonl, activity: a => turns.noteActivity(a),
      roleOf: m => m === 'damar' ? { label: 'DAMAR (lead)', mandate: 'You lead the Pandawa team: weigh the members proposals on evidence and decide.' } : identity.roleProfile(m) });
    r9 = require('./r9-routes.cjs').createR9Routes({
      directory, credentials: runtime.credentials, hub, registry, turns, checkpoints, settings: coreSettings, modelGrants, providerAdmin, team,
      mataDewa: require('../mata-dewa/index.cjs').createMataDewa({ settings: coreSettings, keyStore, cacheFile: path.join(directory, 'mata-dewa-cache.json'), profileDir: path.join(path.dirname(settingsFile), 'mata-dewa'), python, alprDir: path.join(SCRATCH, 'alpr'), // installed: %LOCALAPPDATA%\DAMAR\alpr
        // ALPR watchlist hits join the redacted activity feed (requester: camera label only; owner: plate in `detail`).
        onAlert: a => turns.noteActivity({ kind: 'alert', source: 'mata-dewa', label: String(a.cameraName).slice(0, 40) + ' · watchlist match', detail: a.plate }) }),
      lifecycle: lifecycleBridge, jobSnapshot: () => {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(directory, 'jobs.json'), 'utf8'));
          if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
          return { jobs: Array.isArray(state.jobs) ? state.jobs : [], plans: Array.isArray(state.plans) ? state.plans : null };
        } catch { return null; }
      },
      budget: liveBudget,
      memory: { store: projectMemory, validRoot: r => typeof r === 'string' && path.isAbsolute(r) && fs.existsSync(r) && fs.statSync(r).isDirectory() && !isProtected(r, PROTECTED) },
      sandbox: () => ({ workspace: 'the directory DAMAR was launched from', protectedRoots: PROTECTED.length + ' protected locations + the Owner profile, Windows and Program Files',
        writes: 'one file per approved request, through the separate writer process (no links, no junctions, no hard links)',
        commands: ['python -m unittest | py_compile | pytest', 'python <file.py in workspace>', 'node --test', 'node --check <file>', 'node <file.js in workspace>'],
        containment: python ? 'No-capability Windows AppContainer inside a Job Object (32 processes, 1 GiB); unavailable means refusal' : 'UNAVAILABLE: commands refused (python not found)',
        computerUse: python ? 'Core-owned desktop broker (screen capture, input, browser automation): every target asks the Owner, operations are serialized and instantly stoppable via computer_use_stop; agent subprocesses keep zero desktop access' : 'UNAVAILABLE (python not found)',
        network: 'DENIED by AppContainer for agent commands and file writer', approvals: 'every write, edit, command and delegation asks the Owner (once / this session / deny)' }),
      canonicalUsageToday: () => { try { return usageService.today(); } catch { return null; } },
    });
    const server = runtime.server;
    const original = bootOriginal;
    const control = require('../control/serve.cjs'); // DAMAR Control static files (non-secret; data stays behind r9/console auth)
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (control.isControlPath(url.pathname)) return control.serveControl(req, res, url);
      if (LEGACY_UI.test(url.pathname)) return retired(res);
      const ours = url.pathname.startsWith('/api/v1/console') || url.pathname.startsWith('/api/r9/');
      if (!ours) { for (const l of original) l.call(server, req, res); return; }
      const host = `127.0.0.1:${req.socket.localPort}`;
      const send = (status, error) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ success: false, error })); };
      if (req.socket.localAddress !== '127.0.0.1' || req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, 'ORIGIN_DENIED');
      if (url.pathname.startsWith('/api/r9/')) { r9(req, res, url).catch(() => { if (!res.headersSent) send(503, 'R9_UNAVAILABLE'); }); return; }
      if (!READ_ROUTES.includes(url.pathname) || url.search) return send(404, 'ROUTE_NOT_MOUNTED_IN_ISOLATED_CORE');
      if (req.method !== 'GET') return send(405, 'READ_ONLY_ROUTE');
      app(req, res);
    });
    const info = { address: runtime.address, readRoutes: READ_ROUTES, canonicalFiles: copy.length, snapshotAggregate: snapshotManifest.src.aggregate, providers: Object.keys(providers), pid: process.pid, resumed: resume, recovered };
    fs.writeFileSync(path.join(directory, 'core-host.json'), JSON.stringify(info));
    console.log(JSON.stringify({ status: 'READY', ...info, directory, readRoutes: READ_ROUTES.length, supervisor: 'OFF', liveInference: false }));
    lifecycleBridge.ready();
    process.on('exit', () => { try { fs.writeFileSync(path.join(directory, 'egress-denied.json'), JSON.stringify({ count: egressDenied.length, denied: egressDenied.slice(0, 64) })); } catch {} });
  } catch (error) { await runtime.stop(); for (const p of Object.values(providers)) await p.close().catch(() => {}); throw error; }
  // Running agent turns end INTERRUPTED (CORE_STOPPED, resumable with /continue) before the providers close.
  const releaseGrants = () => { try { const r = sandboxLifecycle?.release(); if (r) fs.writeFileSync(path.join(directory, 'sandbox-release.json'), JSON.stringify({ t: new Date().toISOString(), ...r })); } catch {} sandboxLifecycle = null; };
  process.on('exit', releaseGrants);
  process.on('exit', () => require('./computer-use.cjs').closeBrowser());
  let stopping;
  const stop = () => stopping ||= shutdownTurns().catch(() => {}).then(releaseGrants).then(() => runtime.stop()).then(() => Promise.all(Object.values(providers).map(p => p.close()))).then(() => { if (process.connected) process.disconnect(); setTimeout(() => process.exit(0), 200).unref(); });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('message', m => { if (m?.type === 'R7R3_STOP') stop(); });
  process.once('disconnect', stop); // launcher died: never leave an orphaned authority.
}

if (require.main === module) {
  const directory = process.argv[2] && path.resolve(process.argv[2]);
  const resume = process.argv.includes('--resume');
  const from = process.argv.indexOf('--recover-from');
  const recoverFrom = from > 0 ? process.argv[from + 1] : null;
  const run = process.env.DAMAR_CORE_HOST_CHILD === '1' ? child(directory, resume, process.argv.includes('--recovered')) : Promise.resolve().then(() => parent(directory, resume, recoverFrom));
  run.catch(error => { console.error(error.code === 'EADDRINUSE' ? 'CORE_ENDPOINT_IN_USE_NOT_TOUCHED' : (error.code || error.message)); process.exitCode = 1; if (process.connected) process.disconnect(); }); // startup failure: release the IPC channel so the process exits
}
module.exports = { READ_ROUTES, cleanEnvironment, insideScratch, hashTree, installEgressGuard };
