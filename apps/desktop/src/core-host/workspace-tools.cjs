'use strict';
// Workspace tools for the DAMAR agent loop (registered into Core's runtime by the isolated host; no Core file edited).
// Read-only: workspace_list, workspace_read, workspace_grep. Consequential: workspace_write, workspace_edit, workspace_run.
// Every path is confined to the turn's workspace root (realpath checked; protected sources always refused). Consequential
// calls ask the Owner through the CLI permission card and then run through Core's real authority + capability execution
// bridge (workspace-authority.cjs). Commands come from a fixed allowlist, run without a shell, with the workspace as cwd,
// a stripped environment, a time limit and an output cap, inside a Windows Job Object (job-run.py: kill-on-close, process
// and memory limits) so no descendant outlives the call. Child processes are NOT network-isolated (disclosed limit).
// File writes are performed by a separate single-file writer process (workspace-writer.cjs); the Core host's own
// scratch-only output guard stays in force. Consequential calls on one workspace are serialized.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawn } = require('node:child_process');

const MAX_READ = 64 * 1024, MAX_OUT = 64 * 1024, RUN_MS = 60000, MAX_LIST = 500, MAX_MATCHES = 100;
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.pytest_cache']);
const lower = p => path.resolve(p).toLowerCase();

// Protected sources: never readable or writable by the agent, whatever the workspace.
function isProtected(p, protectedRoots) {
  const x = lower(p);
  if (/[\\/]\.damar([\\/]|$)/i.test(x) || /^[a-z]:\\windows([\\/]|$)/i.test(x) || /^[a-z]:\\program files/i.test(x)) return true;
  return protectedRoots.some(r => x === lower(r) || x.startsWith(lower(r) + path.sep));
}

// Resolve a workspace-relative path; the real location (after symlinks) must stay inside the root.
function confine(root, rel, { mustExist = true } = {}) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.includes('\0')) throw Error('PATH_INVALID');
  const full = path.resolve(root, rel);
  const real = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
  const rootReal = real(root);
  let probe = full;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const probeReal = real(probe);
  if (!rootReal || !probeReal) throw Error('PATH_INVALID');
  const inside = x => lower(x) === lower(rootReal) || lower(x).startsWith(lower(rootReal) + path.sep);
  if (!inside(probeReal) || !inside(path.join(probeReal, path.relative(probe, full)))) throw Error('OUTSIDE_WORKSPACE');
  if (mustExist && !fs.existsSync(full)) throw Error('NOT_FOUND');
  return full;
}

// Minimal LCS line diff (files up to 2000 lines), returned as hunks with line numbers for the CLI diff overlay.
function lineDiff(before, after) {
  const a = before === null ? [] : before.split(/\r?\n/), b = after.split(/\r?\n/);
  if (a.length > 2000 || b.length > 2000) return { added: b.length, removed: a.length, hunks: [], truncated: true };
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { ops.push([' ', i + 1, j + 1, a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', i + 1, j + 1, a[i]]); i++; } else { ops.push(['+', i + 1, j + 1, b[j]]); j++; } }
  while (i < n) { ops.push(['-', i + 1, j + 1, a[i]]); i++; }
  while (j < m) { ops.push(['+', i + 1, j + 1, b[j]]); j++; }
  const hunks = []; let cur = null;
  ops.forEach((o, k) => {
    if (o[0] === ' ') return;
    if (!cur || k > cur.last + 3) { cur = { oldStart: o[1], newStart: o[2], lines: [], last: k }; hunks.push(cur); }
    for (let c = Math.max(cur.last + 1, k - 2); c < k; c++) if (ops[c][0] === ' ' && !cur.lines.some(l => l.k === c)) cur.lines.push({ k: c, t: ' ', n: ops[c][2], text: ops[c][3] });
    cur.lines.push({ k, t: o[0], n: o[0] === '-' ? o[1] : o[2], text: o[3] }); cur.last = k;
  });
  return { added: ops.filter(o => o[0] === '+').length, removed: ops.filter(o => o[0] === '-').length,
    hunks: hunks.slice(0, 20).map(h => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines.slice(0, 200).map(({ t, n, text }) => ({ t, n, text: text.slice(0, 400) })) })) };
}

// Allowlisted commands. Returns { exe, args } or throws COMMAND_NOT_ALLOWED.
function allowCommand(root, command, args, exes) {
  if (!Array.isArray(args) || args.length > 20 || args.some(a => typeof a !== 'string' || a.length > 200 || /[\0\r\n]/.test(a))) throw Error('COMMAND_NOT_ALLOWED');
  const inRoot = f => { confine(root, f); return true; };
  if (command === 'python' && exes.python) {
    if (args[0] === '-m' && ['pytest', 'py_compile', 'unittest'].includes(args[1])) return { exe: exes.python, args };
    if (args[0] && /\.py$/i.test(args[0]) && inRoot(args[0])) return { exe: exes.python, args };
  }
  if (command === 'node') {
    if (args[0] === '--test' || (args[0] === '--check' && args[1] && inRoot(args[1])) || (args[0] && /\.(c|m)?js$/i.test(args[0]) && inRoot(args[0]))) return { exe: exes.node, args };
  }
  throw Error('COMMAND_NOT_ALLOWED');
}

const JOB_RUN = path.join(__dirname, 'job-run.py'), WRITER = path.join(__dirname, 'workspace-writer.cjs');
// Node resolves its main module's real path by lstat-ing every ancestor (e.g. D:\), which the container may not read.
const NODE_NO_REALPATH = ['--preserve-symlinks', '--preserve-symlinks-main'];
// Sandbox configuration (set once by the Core host): the Python that runs job-run.py and the grant ledger. Without it
// nothing runs (fail closed).
const sandbox = { python: null, ledger: null, scratch: null };
function configureSandbox({ python, ledger, scratch }) { sandbox.python = python || null; sandbox.ledger = ledger || null; sandbox.scratch = scratch || null; }
// job-run.py arguments: Modify on the workspace only; Read+Execute on the interpreter's folder (and extra read dirs).
const sandboxArgs = (workspace, exe, read = []) => ['-I', JOB_RUN, '--ledger', sandbox.ledger, '--grant-rw', workspace,
  ...[path.dirname(exe), ...read].flatMap(dir => ['--grant-rx', dir]), '--'];
// Allowlisted command inside the Job Object AND the no-capability AppContainer (job-run.py); without it nothing runs.
function runProcess(exe, args, cwd, env, signal, python = sandbox.python, { readDirs = [], stdinData = '' } = {}) {
  return new Promise(resolve => {
    const started = Date.now(); let stdout = '', stderr = '', timedOut = false;
    if (!python || !sandbox.ledger) return resolve({ ok: false, error: 'CONTAINMENT_UNAVAILABLE', exitCode: null, stdout, stderr, durationMs: 0, timedOut });
    // Node programs in the container: skip the main-module realpath walk over unreadable ancestors (see NODE_NO_REALPATH).
    const childEnv = { ...env, NODE_OPTIONS: [env?.NODE_OPTIONS, ...NODE_NO_REALPATH].filter(Boolean).join(' ') };
    const child = spawn(python, [...sandboxArgs(cwd, exe, readDirs), exe, ...args], { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const cap = (s, d) => (s.length < MAX_OUT ? s + d.toString('utf8') : s).slice(0, MAX_OUT);
    child.stdout.on('data', d => { stdout = cap(stdout, d); });
    child.stderr.on('data', d => { stderr = cap(stderr, d); });
    child.stdin.end(stdinData);
    const kill = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, RUN_MS);
    signal?.addEventListener?.('abort', kill, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: 'SPAWN_FAILED_' + (e.code || 'UNKNOWN'), exitCode: null, stdout, stderr, durationMs: Date.now() - started, timedOut }); });
    child.on('close', code => { clearTimeout(timer); if (code === 125) return resolve({ ok: false, error: 'CONTAINMENT_UNAVAILABLE', exitCode: null, stdout, stderr, durationMs: Date.now() - started, timedOut });
      resolve({ ok: !timedOut && !signal?.aborted, exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut, cancelled: !!signal?.aborted }); });
  });
}

// Owner-approved shell command on the host (not the AppContainer): the user's real PATH/profile, a time limit,
// an output cap, and the whole process tree killed on timeout or cancel.
function runShell(line, cwd, signal, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now(); let stdout = '', stderr = '', timedOut = false;
    const env = { ...process.env, PATH: process.env.DAMAR_USER_PATH || process.env.PATH };
    for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env['DAMAR_USER_' + k]) env[k] = process.env['DAMAR_USER_' + k];
    for (const k of Object.keys(env)) if (/^DAMAR_|TOKEN|SECRET|API_KEY/i.test(k)) delete env[k];
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', line], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = (s, d) => (s.length < MAX_OUT ? s + d.toString('utf8') : s).slice(0, MAX_OUT);
    child.stdout.on('data', d => { stdout = cap(stdout, d); });
    child.stderr.on('data', d => { stderr = cap(stderr, d); });
    const kill = () => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener?.('abort', kill, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: 'SPAWN_FAILED_' + (e.code || 'UNKNOWN'), exitCode: null, stdout, stderr, durationMs: Date.now() - started, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: !timedOut && !signal?.aborted, exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut, cancelled: !!signal?.aborted }); });
  });
}

// broker.context(sessionId) -> { root, requestPermission(card) -> 'once'|'session'|'deny', sessionEndsAt, signal, emit(event) }
// One approved file write through the separate writer process (see workspace-writer.cjs). before: 'absent' | sha256.
// The writer runs inside the same AppContainer: even a junction swapped into the workspace at the last instant cannot
// make it write outside, because the kernel refuses it (the sandbox SID has no write right anywhere else).
function writeFile({ node, root, rel, content, before, protectedRoots, remove = false }) {
  return new Promise((resolve, reject) => {
    if (!sandbox.python || !sandbox.ledger) return reject(Error('CONTAINMENT_UNAVAILABLE'));
    const child = spawn(sandbox.python, [...sandboxArgs(root, node, [path.dirname(WRITER)]), node, ...NODE_NO_REALPATH, WRITER], { cwd: root, env: { SystemRoot: process.env.SystemRoot }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => { out = (out + d).slice(0, 4096); });
    child.on('error', () => { clearTimeout(timer); reject(Error('WRITER_UNAVAILABLE')); });
    child.on('close', () => { clearTimeout(timer); let r; try { r = JSON.parse(out.trim().split('\n').pop()); } catch { return reject(Error('WRITER_NO_RESULT')); } if (r.ok) resolve(r); else reject(Error(String(r.error || 'WRITE_FAILED').slice(0, 60))); });
    child.stdin.end(JSON.stringify({ root, rel, contentB64: Buffer.from(content || '', 'utf8').toString('base64'), before, protectedRoots, remove }));
  });
}

function createWorkspaceTools({ AITool, authority, broker, protectedRoots, exes, childEnv, pandawa = null, checkpoints = null, projectMemory = null, settings = null }) {
  // Consequential calls on the same workspace run one at a time (no write/run interleaving across sessions).
  const locks = new Map();
  const serial = (root, fn) => { const key = lower(root), prev = locks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(key, next.catch(() => {})); return next; };
  const ctxOf = execution => {
    const sessionId = execution?.ingress?.sessionId ?? execution?.exec?.sessionId ?? null;
    const ctx = sessionId ? broker.context(sessionId) : null;
    if (!ctx) throw Error('NO_ACTIVE_TURN');
    if (isProtected(ctx.root, protectedRoots)) throw Error('PROTECTED_WORKSPACE');
    return ctx;
  };
  const out = value => JSON.stringify(value);
  const target = (ctx, rel, options) => { const abs = path.resolve(ctx.root, rel); const root = settings?.rootFor(ctx.root, abs) || ctx.root; const file = confine(root, rel, options); if (isProtected(file, protectedRoots)) throw Error('PROTECTED_PATH'); return { root, file }; };
  const fail = error => out({ ok: false, error: String(error?.message || error).slice(0, 160) });
  const tool = (spec, flags) => { const t = new AITool(spec); t.meta = flags; if (flags.canonicalAuthority) t.canonicalAuthority = true; return t; };
  const rootToken = ctx => 'root:' + crypto.createHash('sha256').update(lower(ctx.root)).digest('hex').slice(0, 16);

  async function executeTrustedPlugin(ctx, pluginKey, input) {
    if (!settings?.pluginSnapshot || !sandbox.scratch || !sandbox.python) throw Error('PLUGIN_CONTAINMENT_UNAVAILABLE');
    const snapshot = settings.pluginSnapshot(ctx.root, pluginKey);
    const { plugin, files } = snapshot;
    const invocation = crypto.randomUUID();
    const argsText = JSON.stringify(input ?? null);
    if (argsText.length > 16 * 1024) throw Error('PLUGIN_INPUT_TOO_LARGE');
    const digest = crypto.createHash('sha256').update(argsText).digest('hex');
    const scope = 'plugin:' + plugin.key + ':' + digest;
    let stage = null, work = null, result = null;
    try {
      const stageRoot = path.join(sandbox.scratch, 'plugin-stage');
      const workRoot = path.join(sandbox.scratch, 'plugin-work');
      fs.mkdirSync(stageRoot, { recursive: true }); fs.mkdirSync(workRoot, { recursive: true });
      stage = fs.mkdtempSync(path.join(stageRoot, 'run-'));
      work = fs.mkdtempSync(path.join(workRoot, 'run-'));
      for (const file of files) {
        const dest = path.resolve(stage, file.rel);
        if (!(dest.toLowerCase().startsWith(stage.toLowerCase() + path.sep))) throw Error('PLUGIN_PATH_INVALID');
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, file.bytes, { flag: 'wx' });
      }
      const entry = path.join(stage, plugin.entry);
      const exe = plugin.command === 'node' ? exes.node : exes.python;
      if (!exe) throw Error('PLUGIN_INTERPRETER_UNAVAILABLE');
      const argv = plugin.command === 'node' ? [...NODE_NO_REALPATH, entry] : ['-I', entry];
      const scopeArgs = { op: 'plugin', scopeToken: scope, card: { tool: 'trusted_plugin_execute', run: plugin.name,
        change: 'run a trusted project plugin with the supplied input', scope: 'Exact plugin digest and input', risk: 'Plugin code executes in a no-network AppContainer; code is read-only and output is returned to this turn' },
        parameters: { plugin: plugin.key, pluginDigest: plugin.digest, inputDigest: digest },
        driver: async () => {
          // Re-read trust and source immediately before invocation. Execution uses only this exact staged byte snapshot.
          const fresh = settings.pluginSnapshot(ctx.root, plugin.key);
          if (fresh.plugin.digest !== plugin.digest) throw Error('PLUGIN_TAMPERED_OR_CHANGED');
          result = await runProcess(exe, argv, work, childEnv, ctx.signal, sandbox.python,
            { readDirs: [stage], stdinData: argsText });
          return { exitCode: result.exitCode, timedOut: result.timedOut };
        },
        verify: async () => ({ checks: [
          { name: 'completed in sandbox', passed: !!result && result.exitCode !== null && !result.timedOut && !result.cancelled },
          { name: 'read-only staged code', passed: fs.existsSync(entry) && fs.statSync(entry).isFile() },
        ] }) };
      const authorityResult = await consequential(ctx, scopeArgs);
      if (authorityResult.ok === false) return authorityResult;
      if (!result) return { ok: false, error: 'PLUGIN_NOT_EXECUTED_' + (authorityResult.reason || authorityResult.outcome) };
      return { ok: result.ok && result.exitCode === 0 && authorityResult.outcome === 'EXECUTED_VERIFIED',
        outcome: authorityResult.outcome, exitCode: result.exitCode, timedOut: result.timedOut,
        stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs };
    } finally {
      // The AppContainer receives write access only to this empty per-run directory, never to plugin source.
      for (const dir of [work, stage]) if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
  }

  // Ask the Owner, mint the grant, execute through Core's bridge, consume an "Allow once" grant afterwards.
  async function consequential(ctx, spec) { return serial(ctx.root, () => consequentialNow(ctx, spec)); }
  async function consequentialNow(ctx, { op, scopeToken, card, parameters, driver, verify }) {
    if (settings?.autonomy() === 'read-only') return { ok: false, error: 'READ_ONLY_PROFILE' };
    const scope = [scopeToken, rootToken(ctx)];
    let mode = null;
    const existing = await authority.evaluate(op, scope).catch(() => null);
    if (!existing?.allowed) {
      const answer = await ctx.requestPermission(card);
      if (answer !== 'once' && answer !== 'session') return { ok: false, error: 'DENIED_BY_OWNER' };
      mode = answer;
      await authority.grant({ op, scope, mode, sessionEndsAt: ctx.sessionEndsAt, summary: card.change });
    }
    const invocation = 'inv-' + crypto.randomUUID();
    const result = await authority.execute({ op, scope, parameters, driver, verify, invocation });
    if (mode === 'once') await authority.consume(op, scope).catch(() => {});
    return result;
  }

  return [
    // The agent's live plan (shown in the CLI sidebar as Plan x/N). Read-only: it changes nothing but the display.
    tool({ name: 'plan_update', description: 'Show your current step-by-step plan to the Owner (labels with state done | active | pending | stopped).',
      parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, state: { type: 'string', enum: ['done', 'active', 'pending', 'stopped'] } }, required: ['label', 'state'] } } }, required: ['steps'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution);
        const steps = (Array.isArray(args?.steps) ? args.steps : []).slice(0, 12).map(s => ({ label: String(s?.label || '').replace(/[\x00-\x1f]/g, ' ').slice(0, 80), state: ['done', 'active', 'pending', 'stopped'].includes(s?.state) ? s.state : 'pending' })).filter(s => s.label);
        if (!steps.length) throw Error('PLAN_EMPTY');
        ctx.emit({ type: 'plan', steps }); return out({ ok: true, steps: steps.length }); } catch (e) { return fail(e); } } },
      { readOnly: true }),
    tool({ name: 'workspace_list', description: 'List files and folders in the workspace (relative path, default ".").',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder relative to the workspace root.' } } },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution); const dir = target(ctx, args?.path || '.').file;
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !SKIP.has(e.name)).slice(0, MAX_LIST).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? null : fs.statSync(path.join(dir, e.name)).size }));
        ctx.emit({ type: 'tool', badge: 'GLOB', target: `${args?.path || '.'} (${entries.length} entries)` }); return out({ ok: true, path: args?.path || '.', entries }); } catch (e) { return fail(e); } } },
      { readOnly: true }),
    tool({ name: 'workspace_read', description: 'Read a text file in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution); const file = target(ctx, args.path).file;
        const buf = fs.readFileSync(file); const content = buf.subarray(0, MAX_READ).toString('utf8'); const lines = content.split(/\r?\n/).length;
        ctx.emit({ type: 'tool', badge: 'READ', target: `${args.path} (lines 1..${lines})` }); return out({ ok: true, path: args.path, lines, truncated: buf.length > MAX_READ, content }); } catch (e) { return fail(e); } } },
      { readOnly: true }),
    tool({ name: 'workspace_grep', description: 'Search workspace text files for a regular expression.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution); const base = target(ctx, args.path || '.').file; const re = new RegExp(String(args.pattern).slice(0, 200)); const matches = [];
        const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (matches.length >= MAX_MATCHES || SKIP.has(e.name)) continue; const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p); else if (fs.statSync(p).size < 1 << 20) fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => { if (matches.length < MAX_MATCHES && re.test(l)) matches.push({ path: path.relative(ctx.root, p).replace(/\\/g, '/'), line: i + 1, text: l.trim().slice(0, 200) }); }); } };
        if (fs.statSync(base).isDirectory()) walk(base);
        ctx.emit({ type: 'tool', badge: 'GREP', target: `${args.pattern} ${args.path || '.'} (${matches.length} matches)` }); return out({ ok: true, matches }); } catch (e) { return fail(e); } } },
      { readOnly: true }),
    tool({ name: 'workspace_write', description: 'Create or overwrite a text file in the workspace (asks the Owner).',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution); const { file, root } = target(ctx, args.path, { mustExist: false }); const scoped = { ...ctx, root };
        if (typeof args.content !== 'string' || args.content.length > 512 * 1024) throw Error('CONTENT_INVALID');
        const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, diff = lineDiff(before, args.content);
        const r = await consequential(scoped, { op: 'write', scopeToken: 'path:' + path.relative(root, file).replace(/\\/g, '/'),
          card: { tool: 'workspace_write', run: args.path, change: before === null ? 'create a file in the workspace' : 'overwrite a file in the workspace', scope: 'Current workspace', risk: before === null ? 'Creates a file' : 'Replaces file content', diff },
          parameters: { path: args.path, sha256: crypto.createHash('sha256').update(args.content).digest('hex') },
          driver: async () => { await writeFile({ node: exes.node, root, rel: path.relative(root, file), content: args.content, before: before === null ? 'absent' : crypto.createHash('sha256').update(before).digest('hex'), protectedRoots }); return { written: true }; },
          verify: async p => ({ checks: [{ name: 'content hash', passed: fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === p.sha256 }] }) });
        if (r.ok === false) return out(r);
        const ok = r.outcome === 'EXECUTED_VERIFIED';
        if (ok) { checkpoints?.record({ session: ctx.cliSession, turnId: ctx.turnId, root, rel: path.relative(root, file), before, after: args.content }); ctx.emit({ type: 'diff', badge: before === null ? 'CREATE' : 'EDIT', path: args.path, diff }); }
        return out({ ok, created: before === null, path: args.path, outcome: r.outcome, reason: r.reason, diff: { added: diff.added, removed: diff.removed } }); } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'workspace_edit', description: 'Replace one exact occurrence of text in a workspace file (asks the Owner).',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution); const { file, root } = target(ctx, args.path); const scoped = { ...ctx, root };
        const before = fs.readFileSync(file, 'utf8'); const count = before.split(String(args.old)).length - 1;
        if (!args.old || count !== 1) throw Error(count === 0 ? 'TEXT_NOT_FOUND' : 'TEXT_NOT_UNIQUE');
        const after = before.replace(String(args.old), String(args.new)), diff = lineDiff(before, after);
        const r = await consequential(scoped, { op: 'edit', scopeToken: 'path:' + path.relative(root, file).replace(/\\/g, '/'),
          card: { tool: 'workspace_edit', run: args.path, change: 'edit a file in the workspace', scope: 'Current workspace', risk: 'Changes file content', diff },
          parameters: { path: args.path, before: crypto.createHash('sha256').update(before).digest('hex'), after: crypto.createHash('sha256').update(after).digest('hex') },
          driver: async () => { await writeFile({ node: exes.node, root, rel: path.relative(root, file), content: after, before: crypto.createHash('sha256').update(before).digest('hex'), protectedRoots }); return { edited: true }; },
          verify: async p => ({ checks: [{ name: 'content hash', passed: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === p.after }] }) });
        if (r.ok === false) return out(r);
        const ok = r.outcome === 'EXECUTED_VERIFIED';
        if (ok) { checkpoints?.record({ session: ctx.cliSession, turnId: ctx.turnId, root, rel: path.relative(root, file), before, after }); ctx.emit({ type: 'diff', badge: 'EDIT', path: args.path, diff }); }
        return out({ ok, path: args.path, outcome: r.outcome, reason: r.reason, diff: { added: diff.added, removed: diff.removed } }); } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'workspace_run', description: 'Run an allowlisted command in the workspace: python -m pytest|py_compile|unittest, python <file.py>, node --test, node --check <file>, node <file.js> (asks the Owner).',
      parameters: { type: 'object', properties: { command: { type: 'string', enum: ['python', 'node'] }, args: { type: 'array', items: { type: 'string' } } }, required: ['command'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution); const { exe, args: argv } = allowCommand(ctx.root, args.command, args.args || [], exes);
        const line = [args.command, ...argv].join(' ');
        ctx.emit({ type: 'tool', badge: /pytest|unittest|--test|py_compile|--check/.test(line) ? 'VERIFY' : 'RUN', target: line });
        let res = null;
        const r = await consequential(ctx, { op: 'run', scopeToken: 'cmd:' + crypto.createHash('sha256').update(line).digest('hex').slice(0, 24),
          card: { tool: 'workspace_run', run: line, change: 'run a command in the workspace', scope: 'Current workspace', risk: 'Runs code from the workspace' },
          parameters: { command: line },
          driver: async () => { res = await runProcess(exe, argv, ctx.root, childEnv, ctx.signal, exes.python); return { exitCode: res.exitCode }; },
          verify: async () => ({ checks: [{ name: 'process finished', passed: !!res && res.exitCode !== null && !res.timedOut }] }) });
        if (r.ok === false) return out(r);
        if (!res) return out({ ok: false, error: 'NOT_EXECUTED_' + (r.reason || r.outcome) });
        ctx.emit({ type: 'run', target: line, exitCode: res.exitCode, durationMs: res.durationMs, output: (res.stdout + res.stderr).slice(-4000) });
        return out({ ...res, ok: res.ok && res.exitCode === 0, outcome: r.outcome }); } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'workspace_shell', description: 'Run any PowerShell command line in the workspace with the Owner\'s user rights and network (npm, git, pip, builds, scripts). Asks the Owner for every command; prefer workspace_run for tests.',
      parameters: { type: 'object', properties: { command: { type: 'string', maxLength: 4000 }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800 } }, required: ['command'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution);
        const line = String(args?.command || '');
        if (!line.trim() || line.length > 4000 || /\0/.test(line)) throw Error('COMMAND_INVALID');
        ctx.emit({ type: 'tool', badge: 'SHELL', target: line.slice(0, 200) });
        let res = null;
        const r = await consequential(ctx, { op: 'run', scopeToken: 'sh:' + crypto.createHash('sha256').update(line).digest('hex').slice(0, 24),
          card: { tool: 'workspace_shell', run: line, change: 'run a shell command in the workspace', scope: 'Current workspace (user rights, network)', risk: 'Runs with your Windows user rights, not sandboxed' },
          parameters: { command: line },
          driver: async () => { res = await runShell(line, ctx.root, ctx.signal, (Number.isInteger(args.timeoutSeconds) ? args.timeoutSeconds : 600) * 1000); return { exitCode: res.exitCode }; },
          verify: async () => ({ checks: [{ name: 'process finished', passed: !!res && res.exitCode !== null && !res.timedOut }] }) });
        if (r.ok === false) return out(r);
        if (!res) return out({ ok: false, error: 'NOT_EXECUTED_' + (r.reason || r.outcome) });
        ctx.emit({ type: 'run', target: line.slice(0, 200), exitCode: res.exitCode, durationMs: res.durationMs, output: (res.stdout + res.stderr).slice(-4000) });
        return out({ ...res, ok: res.ok && res.exitCode === 0, outcome: r.outcome }); } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    tool({ name: 'trusted_plugin_execute', description: 'Execute one Owner-trusted project plugin by its current digest in a no-network AppContainer; plugin code is read-only and only bounded JSON input/output is exchanged. Asks the Owner for this exact plugin and input.',
      parameters: { type: 'object', properties: { key: { type: 'string', minLength: 24, maxLength: 24 }, input: {} }, required: ['key'] },
      execute: async (args, execution) => { try {
        const ctx = ctxOf(execution);
        const result = await executeTrustedPlugin(ctx, String(args?.key || ''), args?.input);
        if (result.ok) ctx.emit({ type: 'tool', badge: 'PLUGIN', target: `trusted plugin ${String(args.key).slice(0, 24)} (exit ${result.exitCode})` });
        return out(result);
      } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false }),
    // Persistent project memory: the agent may propose a note; it is saved only after the Owner approves it.
    ...(projectMemory ? [tool({ name: 'project_memory_add', description: 'Save a short note to this workspace\'s persistent project memory (asks the Owner). Use for lasting project facts or instructions.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution);
        const text = String(args?.text || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 400);
        if (!text) throw Error('NOTE_EMPTY'); if (settings?.cognitive?.()?.memoryEnabled === false) throw Error('PROJECT_MEMORY_DISABLED');
        let saved = null;
        const r = await consequential(ctx, { op: 'remember', scopeToken: 'note:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 24),
          card: { tool: 'project_memory_add', run: text.slice(0, 120), change: 'save a note to the project memory of this workspace', scope: 'Current workspace (all future sessions)', risk: 'Damar follows this note in later turns' },
          parameters: { textSha: crypto.createHash('sha256').update(text).digest('hex') },
          driver: async () => { saved = projectMemory.add(ctx.root, text); return { id: saved.id }; },
          verify: async () => ({ checks: [{ name: 'note stored', passed: !!saved && projectMemory.list(ctx.root).some(n => n.id === saved.id) }] }) });
        if (r.ok === false) return out(r);
        if (saved) ctx.emit({ type: 'tool', badge: 'MEMORY', target: text.slice(0, 120) });
        return out({ ok: !!saved && r.outcome === 'EXECUTED_VERIFIED', id: saved?.id || null, text }); } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false })] : []),
    // Delegation to a Pandawa specialist: one Owner-approved Core agentHub run (same path as `subagent run`); the tool
    // follows the run to its Core-reported outcome and streams its state to the CLI as a sub-agent block.
    ...(pandawa ? [tool({ name: 'pandawa_delegate', description: 'Delegate focused tasks to Pandawa specialist sub-agents through DAMAR Core (asks the Owner once). One task: worker + task. Several in parallel: tasks = [{worker, task}] (max 3). Workers: ' + pandawa.workers.join(', ') + '.',
      parameters: { type: 'object', properties: { worker: { type: 'string', enum: [...pandawa.workers] }, task: { type: 'string' },
        tasks: { type: 'array', items: { type: 'object', properties: { worker: { type: 'string', enum: [...pandawa.workers] }, task: { type: 'string' } }, required: ['worker', 'task'] } } } },
      execute: async (args, execution) => { try { const ctx = ctxOf(execution);
        const jobs = (Array.isArray(args?.tasks) && args.tasks.length ? args.tasks : [{ worker: args?.worker, task: args?.task }]).slice(0, 3)
          .map(j => ({ worker: String(j?.worker || ''), task: String(j?.task || '').trim().slice(0, 2000) }));
        if (!jobs.length || jobs.some(j => !pandawa.workers.includes(j.worker) || !j.task)) throw Error('INVALID_SUBAGENT_REQUEST');
        const digest = crypto.createHash('sha256').update(JSON.stringify(jobs)).digest('hex');
        const started = [];
        const r = await consequential(ctx, { op: 'delegate', scopeToken: `agent:${digest.slice(0, 24)}`,
          card: { tool: 'pandawa_delegate', run: jobs.map(j => `${j.worker}: ${j.task.slice(0, 60)}`).join(' | ').slice(0, 160),
            change: jobs.length > 1 ? `start ${jobs.length} Pandawa sub-agent runs in parallel in Core` : 'start a Pandawa sub-agent run in Core', scope: 'Active provider', risk: 'Runs model inference for the sub-agents' },
          parameters: { jobs: jobs.length, digest },
          driver: async () => { for (const j of jobs) { const s = pandawa.start({ requestId: 'agent_' + crypto.randomUUID().replace(/-/g, ''), cliSession: ctx.cliSession, worker: j.worker, task: j.task }); if (s.status !== 202) throw Error(s.body?.error || 'NOT_ACCEPTED'); started.push({ ...j, run: s.body.data }); } return { runs: started.length }; },
          verify: async () => ({ checks: [{ name: 'every run accepted by Core', passed: started.length === jobs.length }] }) });
        if (r.ok === false) return out(r);
        if (!started.length) return out({ ok: false, error: 'NOT_STARTED_' + (r.reason || r.outcome) });
        // Follow every run at once; each state change streams to the CLI's sub-agent block; abort cancels all.
        const done = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN']), last = new Map();
        const until = Date.now() + 180000; let cancelled = false;
        for (;;) {
          const views = started.map(j => (last.has(j.run.runId) ? pandawa.view(j.run.runId) : j.run));   // Core's accepted snapshot first
          views.forEach((v, i) => { if (last.get(v.runId) !== v.state) { last.set(v.runId, v.state); ctx.emit({ type: 'agent', runId: v.runId, worker: started[i].worker, task: started[i].task.slice(0, 160), state: v.state, output: v.outputPreview ? String(v.outputPreview).slice(0, 2000) : null, error: v.error }); } });
          if (views.every(v => done.has(v.state))) break;
          if (!cancelled && (ctx.signal.aborted || Date.now() > until)) { cancelled = true; for (const j of started) pandawa.cancel(j.run.runId); }
          await new Promise(res => setTimeout(res, 150));
        }
        const results = started.map(j => { const v = pandawa.view(j.run.runId); return { runId: v.runId, worker: j.worker, state: v.state, output: v.outputPreview ? String(v.outputPreview).slice(0, 1000) : null, error: v.error }; });
        return out(results.length === 1 ? { ok: results[0].state === 'COMPLETED', ...results[0] } : { ok: results.every(x => x.state === 'COMPLETED'), parallel: true, results }); } catch (e) { return fail(e); } } },
      { canonicalAuthority: true, sideEffects: true, readOnly: false })] : []),
  ];
}
module.exports = { createWorkspaceTools, confine, isProtected, lineDiff, allowCommand, runProcess, runShell, writeFile, configureSandbox };
