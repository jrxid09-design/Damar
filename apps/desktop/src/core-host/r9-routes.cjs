'use strict';
// Core-side Pandawa run lifecycle + durable per-session usage receipts for the isolated host.
// Runs execute the canonical agentHub worker path (no local orchestrator); the only provider is the
// offline fixture. Mutations need the Owner credential; reads accept requester or owner.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const WORKERS = Object.freeze(['puntadewa', 'werkudara', 'janaka', 'nakula', 'sadewa']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN']);
const MAX_RUNS = 256, MAX_QUEUE = 8;

function appendDurable(file, row) {
  const fd = fs.openSync(file, 'a+');
  try {
    // After a crash mid-append the file can end in a torn line; start a fresh line so this row is not glued onto it.
    const size = fs.fstatSync(fd).size, last = Buffer.alloc(1);
    const torn = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    fs.writeSync(fd, (torn ? '\n' : '') + JSON.stringify(row) + '\n'); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
// A torn final line (crash mid-append) is ignored; corruption anywhere else fails closed.
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const last = lines[lines.length - 1] === '' ? lines.length - 2 : lines.length - 1;
  const rows = [];
  lines.forEach((line, i) => {
    if (!line) return;
    try { rows.push(JSON.parse(line)); } catch { if (i !== last) throw Error('CORRUPT_DURABLE_LEDGER'); }
  });
  return rows;
}
const tokenEq = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
const clean = (s, n) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ').slice(0, n);

function createR9Routes({ directory, credentials, hub, registry, canonicalUsageToday, turns = null, sandbox = () => null, checkpoints = null, memory = null, settings = null, budget = null, lifecycle = null, jobSnapshot = () => null, modelGrants = null, mataDewa = null, team = null, providerAdmin = null, media = null, oauthLogin = null, onboardingChat = null, cyber = null, otomasi = null, parallelRuns = 3 }) {
  if (!Number.isSafeInteger(parallelRuns) || parallelRuns < 1 || parallelRuns > 3) throw Error('PANDAWA_PARALLEL_INVALID');
  const runsFile = path.join(directory, 'pandawa-runs.jsonl'), receiptsFile = path.join(directory, 'usage-receipts.jsonl');
  const runs = new Map(), byRequest = new Map(), receipts = new Map();
  const apply = ev => {
    const r = runs.get(ev.runId) || { createdAt: ev.t };
    const { t, ...patch } = ev; Object.assign(r, patch, { updatedAt: t }); runs.set(ev.runId, r);
    if (r.requestId) byRequest.set(r.requestId, ev.runId);
  };
  const record = (runId, patch) => { const ev = { t: Date.now(), runId, ...patch }; appendDurable(runsFile, ev); apply(ev); };
  for (const ev of readJsonl(runsFile)) apply(ev);
  for (const r of readJsonl(receiptsFile)) {
    const prev = receipts.get(r.receiptId);
    if (prev && JSON.stringify(prev) !== JSON.stringify(r)) throw Error('CONFLICTING_DURABLE_RECEIPT');
    receipts.set(r.receiptId, r);
  }
  // No replay after restart: an interrupted run's outcome is unknown, never re-dispatched.
  for (const [id, r] of runs) if (!TERMINAL.has(r.state)) record(id, { state: 'OUTCOME_UNKNOWN', reason: 'HOST_RESTARTED_DURING_RUN' });

  // Parallel sub-agents: up to PARALLEL runs at once (bounded queue of MAX_QUEUE outstanding). Provider usage is attributed
  // per request, not by position: a Pandawa run claims the ledger entries whose request carried its task (no tools), an
  // agent turn claims its own tool-bearing entries, and a claimed entry is never counted twice.
  const PARALLEL = parallelRuns, claimed = new Set();
  let running = 0, queued = 0; const waiting = [];
  const pump = () => { while (running < PARALLEL && waiting.length) { const { fn, resolve, reject } = waiting.shift(); running++; Promise.resolve().then(fn).then(resolve, reject).finally(() => { running--; queued--; pump(); }); } };
  const enqueue = fn => new Promise((resolve, reject) => { queued++; waiting.push({ fn, resolve, reject }); pump(); });

  async function execute(runId) {
    const run = runs.get(runId);
    if (run.cancelRequested) return record(runId, { state: 'CANCELLED', reason: 'CANCELLED_BEFORE_START' });
    const provider = registry.active(), start = provider.ledger.length;
    // A queued run whose provider was switched to a live one is refused, never dispatched.
    if (!provider.executable) return record(runId, { state: 'FAILED', provider: provider.id, model: provider.model, error: 'LIVE_INFERENCE_NOT_AUTHORIZED', attempts: 0 });
    // Per-member model (pandawa.models.<worker>) and the session's workspace for memory: scoped to this run (cognitive.runScope).
    const route = team?.routeFor?.(run.worker) || null, scope = { route, lang: require('./cognitive.cjs').detectLanguage(run.task), root: (() => { try { return sessions.get(run.cliSession)?.cwd || null; } catch { return null; } })() };
    record(runId, { state: 'RUNNING', provider: route?.connection || provider.id, model: route?.model || provider.model });
    let result;
    try { result = await require('./cognitive.cjs').runScope.run(scope, () => hub.run(run.worker, run.task, { exec: { role: 'user', sessionId: run.pandawaSession, capabilitySet: ['__none__'] } })); }
    catch { result = { ok: false, error: 'WORKER_EXCEPTION' }; }
    const mine = provider.ledger.slice(start).filter(e => !e.tools && !claimed.has(e.responseId) && String(e.lastUser || '').includes(run.task.slice(0, 120)));
    for (const e of mine) claimed.add(e.responseId);
    for (const e of mine) {
      const confirmed = e.usageReported && Number.isSafeInteger(e.promptTokens) && Number.isSafeInteger(e.completionTokens);
      const receipt = { receiptId: `${e.provider}:${e.responseId}`, runId, requestId: run.requestId, cliSession: run.cliSession, provider: route?.connection || e.provider, model: route?.model || e.model,   // the meter row names the selection; a member route served the call
        status: confirmed ? 'CONFIRMED' : e.estimated ? 'ESTIMATED' : e.status === 'COMPLETED' ? 'UNKNOWN_USAGE' : 'NO_USAGE_' + e.status, estimated: !!e.estimated,   // estimated: conservative meter estimate (model reports no usage)
        inputTokens: confirmed || e.estimated ? e.promptTokens : null, outputTokens: confirmed || e.estimated ? e.completionTokens : null, totalTokens: confirmed || e.estimated ? e.promptTokens + e.completionTokens : null };
      if (!receipts.has(receipt.receiptId)) { appendDurable(receiptsFile, receipt); receipts.set(receipt.receiptId, receipt); }
    }
    const attempts = mine.length;
    // Cancelled while running: the provider call could not be aborted (canonical agentHub takes no signal), so its result
    // is discarded and the run ends CANCELLED; the tokens it used are still receipted above.
    if (runs.get(runId).cancelRequested) record(runId, { state: 'CANCELLED', reason: 'CANCELLED_WHILE_RUNNING_RESULT_DISCARDED', attempts });
    else if (result.ok) record(runId, { state: 'COMPLETED', outputPreview: clean(result.output, 240), attempts });
    else record(runId, { state: 'FAILED', error: clean(result.error, 120), attempts });
  }

  const view = r => ({ runId: r.runId, requestId: r.requestId, worker: r.worker, entityId: 'pandawa:' + r.worker, state: r.state, cancelRequested: !!r.cancelRequested,
    reason: r.reason || null, provider: r.provider || null, model: r.model || null, outputPreview: r.outputPreview || null, error: r.error || null,
    attempts: r.attempts ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt });
  function usageFor(cliSession) {
    const rows = [...[...receipts.values()].filter(r => r.cliSession === cliSession), ...(team?.receiptsFor?.(cliSession) || [])];   // + Pandawa discussion receipts
    const confirmed = rows.filter(r => r.status === 'CONFIRMED'), unknown = rows.filter(r => r.status === 'UNKNOWN_USAGE');
    const pending = [...runs.values()].filter(r => r.cliSession === cliSession && !TERMINAL.has(r.state)).length;
    const unknownRuns = [...runs.values()].filter(r => r.cliSession === cliSession && r.state === 'OUTCOME_UNKNOWN').length;
    const sum = k => confirmed.reduce((n, r) => n + r[k], 0);
    const byProvider = {};
    for (const r of confirmed) { const k = r.provider + '/' + r.model; const b = byProvider[k] ||= { inputTokens: 0, outputTokens: 0, receipts: 0 }; b.inputTokens += r.inputTokens; b.outputTokens += r.outputTokens; b.receipts++; }
    const byMember = {}; for (const r of confirmed) { const m = r.member || (runs.get(r.runId)?.worker) || null; if (!m) continue; const b = byMember[m] ||= { inputTokens: 0, outputTokens: 0, receipts: 0 }; b.inputTokens += r.inputTokens; b.outputTokens += r.outputTokens; b.receipts++; }
    return { cliSession, source: 'core-durable-receipts', inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
      confirmedReceipts: confirmed.length, unknownUsageReceipts: unknown.length, attemptsWithoutUsage: rows.length - confirmed.length - unknown.length,
      pendingRuns: pending, unknownOutcomeRuns: unknownRuns, complete: unknown.length === 0 && pending === 0 && unknownRuns === 0, byProvider, byMember,
      estimated: false, cost: 'UNAVAILABLE_NO_RATE_PROVENANCE', provider: 'offline-fixture-only' };
  }

  // CLI session history: same ledger contract, same directory, same authentication; usage and runs joined by cliSession.
  const runsFor = id => [...runs.values()].filter(r => r.cliSession === id).map(view);
  const lifecycleCounts = () => {
    const turnCounts = turns?.counts?.() || { running: 0, pendingPermissions: 0 };
    const snapshot = jobSnapshot();
    const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : null;
    const plans = Array.isArray(snapshot?.plans) ? snapshot.plans : null;
    const rows = [...(jobs || []), ...(plans || [])];
    const done = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'REVOKED', 'REJECTED', 'EXPIRED', 'VERIFIED', 'DENIED']);
    const activeJobs = rows.filter(row => !done.has(String(row.status || '').toUpperCase())).length;
    return { activeTurns: turnCounts.running, pendingPermissions: turnCounts.pendingPermissions,
      activePandawaRuns: [...runs.values()].filter(row => !TERMINAL.has(row.state)).length,
      queuedPandawaRuns: queued, activeDiscussions: team?.counts?.().running || 0, activeJobs, jobStateAvailable: !!snapshot && (jobs !== null || plans !== null) };
  };
  // Transcript binding for surfaces whose conversation lives in the agent-turn journal (Presence): history rows
  // carry no timestamp of their own, so each message takes the START time of its turn from agent-turns.jsonl.
  // Cached on file mtimes; a read error yields an empty transcript rather than a failed session view.
  const turnHistoryCache = { key: '', bySession: new Map() };
  const turnHistoryFor = id => {
    try {
      const hf = path.join(directory, 'agent-turn-history.jsonl'), jf = path.join(directory, 'agent-turns.jsonl');
      const key = [hf, jf].map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(':');
      if (turnHistoryCache.key !== key) {
        const starts = new Map();
        for (const r of readJsonl(jf)) if (r && r.type === 'START' && r.turnId) starts.set(r.turnId, r.t || null);
        const bySession = new Map();
        for (const r of readJsonl(hf)) {
          if (!r || typeof r.session !== 'string' || !['user', 'assistant'].includes(r.role) || typeof r.content !== 'string') continue;
          const arr = bySession.get(r.session) || []; arr.push({ t: starts.get(r.turnId) ?? null, role: r.role, text: r.content }); bySession.set(r.session, arr);
        }
        turnHistoryCache.key = key; turnHistoryCache.bySession = bySession;
      }
      return turnHistoryCache.bySession.get(id) || [];
    } catch { return []; }
  };
  const sessions = require('./cli-sessions.cjs').createSessionStore({ file: path.join(directory, 'cli-sessions.jsonl'), appendDurable, runsFor, usageFor, turnHistoryFor });

  // Agent-turn token receipts: the provider's own ledger entries for the turn, keyed by the CLI session (same ledger).
  function recordTurnUsage({ turnId, cliSession, entries }) {
    for (const e of entries.filter(x => x.tools > 0 && !claimed.has(x.responseId))) {
      claimed.add(e.responseId);
      const confirmed = e.usageReported && Number.isSafeInteger(e.promptTokens) && Number.isSafeInteger(e.completionTokens);
      const receipt = { receiptId: `${e.provider}:${e.responseId}`, runId: turnId, requestId: turnId, cliSession, provider: e.provider, model: e.model,
        status: confirmed ? 'CONFIRMED' : e.estimated ? 'ESTIMATED' : e.status === 'COMPLETED' ? 'UNKNOWN_USAGE' : 'NO_USAGE_' + e.status, estimated: !!e.estimated,   // estimated: conservative meter estimate (model reports no usage)
        inputTokens: confirmed || e.estimated ? e.promptTokens : null, outputTokens: confirmed || e.estimated ? e.completionTokens : null, totalTokens: confirmed || e.estimated ? e.promptTokens + e.completionTokens : null };
      if (!receipts.has(receipt.receiptId)) { appendDurable(receiptsFile, receipt); receipts.set(receipt.receiptId, receipt); }
    }
  }

  async function body(req, max = 8192) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(Error('JSON_REQUIRED'), { status: 415 });
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw Object.assign(Error('BODY_TOO_LARGE'), { status: 413 }); chunks.push(c); }
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { throw Object.assign(Error('INVALID_JSON'), { status: 400 }); }
  }
  const role = req => { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : ''; return tokenEq(t, credentials.owner) ? 'owner' : tokenEq(t, credentials.requester) ? 'requester' : null; };

  // One Owner-approved Pandawa run through Core agentHub (used by the route and by the agent's pandawa_delegate tool).
  function startRun(input) {
    const { requestId, cliSession, worker, task } = input || {};
    if (Object.keys(input || {}).sort().join() !== 'cliSession,requestId,task,worker' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId || '') || !/^[a-f0-9]{64}$/.test(cliSession || '') ||
        !WORKERS.includes(worker) || typeof task !== 'string' || !task.trim() || task.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(task)) return { status: 400, body: { success: false, error: 'INVALID_SUBAGENT_REQUEST' } };
    const digest = crypto.createHash('sha256').update(JSON.stringify([cliSession, worker, task])).digest('hex');
    if (byRequest.has(requestId)) {
      const existing = runs.get(byRequest.get(requestId));
      if (existing.digest !== digest) return { status: 409, body: { success: false, error: 'REQUEST_ID_CONFLICT' } };
      return { status: 200, body: { success: true, duplicate: true, data: view(existing) } };
    }
    if (!registry.active().executable) return { status: 409, body: { success: false, error: 'LIVE_INFERENCE_NOT_AUTHORIZED', data: { provider: registry.active().id } } };
    if (runs.size >= MAX_RUNS) return { status: 429, body: { success: false, error: 'RUN_LIMIT' } };
    if (queued >= MAX_QUEUE) return { status: 429, body: { success: false, error: 'QUEUE_FULL' } };
    const runId = 'run_' + crypto.randomUUID().replace(/-/g, '');
    const pandawaSession = 'ses_' + runId;
    hub.createPandawaSession({ sessionId: pandawaSession, targetEntity: worker, ownerUserId: 'owner', surface: 'cli', channel: 'cli' });
    record(runId, { requestId, cliSession, worker, task, digest, pandawaSession, state: 'ACCEPTED' });
    enqueue(() => execute(runId)).catch(() => { if (!TERMINAL.has(runs.get(runId).state)) record(runId, { state: 'OUTCOME_UNKNOWN', reason: 'HOST_EXECUTION_ERROR' }); });
    return { status: 202, body: { success: true, data: view(runs.get(runId)) } };
  }
  function cancelRun(runId) { const r = runs.get(runId); if (r && !TERMINAL.has(r.state) && !r.cancelRequested) record(runId, { cancelRequested: true }); }

  let lastRaiseSpawnAt = 0;
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/r9/')) return false;
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); return true; };
    const who = role(req);
    if (!who) return json(401, { success: false, error: 'AUTHENTICATION_REQUIRED' });
    try {
      const p = url.pathname;
      // Mata Dewa: public feeds read by requester or owner; keys, own cameras and ALPR are Owner-only (enforced in the module).
      if (mataDewa && p.startsWith('/api/r9/mata-dewa/')) return await mataDewa.handle(req, res, url, json, { who, body });
      // Pandawa team discussions (pandawa-team.cjs): Owner writes with the CLI lease; requester reads are redacted.
      if (team && p.startsWith('/api/r9/pandawa/discussions')) return await team.handle(req, res, url, { who, json, body, sessions });
      // Router-grade provider admin (keys, rotation, tests, catalog, combos) and the DAMAR /v1 gateway admin: Owner only.
      if (providerAdmin && (p.startsWith('/api/r9/provider-admin/') || p === '/api/r9/gateway')) return await providerAdmin.handle(req, res, url, { who, json, body, enqueue });
      // OAuth account login for providers (OpenRouter PKCE): Owner only; the browser callback itself is served by core-host (state-validated).
      if (oauthLogin && p.startsWith('/api/r9/oauth')) return await oauthLogin.handleR9(req, res, url, { who, json, body });
      if (p === '/api/r9/provider/model-grant' ||p === '/api/r9/provider/model-grant/revoke') {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        if (!modelGrants) return json(503, { success: false, error: 'MODEL_GRANT_UNAVAILABLE' });
        if (!url.search && req.method === 'GET' && !p.endsWith('/revoke')) return json(200, { success: true, data: modelGrants.view() });
        if (url.search || req.method !== 'POST') return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        const input = await body(req);
        const data = await enqueue(() => {
          const { expectedVersion, ...grant } = input;
          if (!expectedVersion || expectedVersion !== registry.list().configurationVersion) throw Object.assign(Error('PROVIDER_CONFIGURATION_CHANGED'), { status: 409 });
          if (p.endsWith('/revoke')) {
            // provider (optional): revoke only that connection's grant.
            if (!['approval', 'approval,provider'].includes(Object.keys(grant).sort().join())) throw Object.assign(Error('MODEL_GRANT_REQUEST_INVALID'), { status: 400 });
            return modelGrants.revoke(grant.approval, grant.provider);
          }
          return modelGrants.grant(grant);
        });
        return json(200, { success: true, data });
      }
      if (p === '/api/r9/lifecycle' && req.method === 'GET' && !url.search) {
        return json(200, { success: true, data: { state: lifecycle?.status?.() || { state: 'UNMANAGED' }, outstanding: lifecycleCounts(), restartLimit: 3, restartWindowSeconds: 600 } });
      }
      // Core session logs for Control's Log page (Owner 2026-11-28): the data
      // always existed as journals in this session directory; this route
      // serves a bounded, cleaned tail of them so the page shows the real
      // record instead of claiming logs are unavailable. Owner only.
      if (p === '/api/r9/logs' && req.method === 'GET' && !url.search) {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        const entries = [];
        for (const f of ['agent-turns.jsonl', 'agent-turn-history.jsonl', 'discussions.jsonl', 'usage-receipts.jsonl', 'cli-sessions.jsonl']) {
          let rows = [];
          try { rows = readJsonl(path.join(directory, f)).slice(-60); } catch {}
          for (const r of rows) {
            const ts = typeof r.t === 'number' ? r.t : (r.t ? Date.parse(r.t) || 0 : 0);
            // A bounded structured projection rides along so Control can render a human line per record
            // instead of raw JSON; `text` stays for older clients.
            const row = {}; for (const [k, v] of Object.entries(r || {})) row[k] = typeof v === 'string' ? clean(v, 400) : (typeof v === 'number' || typeof v === 'boolean' || v === null ? v : undefined);
            entries.push({ file: f, t: ts, text: clean(JSON.stringify(r), 300), row });
          }
        }
        entries.sort((a, b) => a.t - b.t);
        return json(200, { success: true, data: { entries: entries.slice(-200) } });
      }
      // Damar Cyber (F9): Werkudara's real defensive record for the Presence
      // portal and the Control Cyber page. Two genuine sources only: this
      // Core's durable Pandawa run registry (Werkudara runs; a run whose
      // task carries the PATROLI marker is a patrol) and the DCD posture
      // projection read from the canonical daemon, which owns the single
      // detection engine. The desktop Core composes no second engine.
      // Owner only, like the other posture reads. Categories without real
      // records stay empty here and render as honest empty states.
      if (p === '/api/r9/cyber' && req.method === 'GET' && !url.search) {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        const wk = [...runs.values()].filter(r => r.worker === 'werkudara')
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const row = r => ({ ...view(r), task: clean(r.task, 300) });
        // Patrols are the continuous activity of this surface (Owner
        // 2026-11-28): a Core run whose task opens with the PATROLI marker
        // is a patrol; PATROLI SISTEM / PATROLI JARINGAN classify the kind
        // from the task text itself. Since the patrol-loop build the
        // canonical daemon also runs Werkudara patrols continuously on
        // its own timers (composition layer) and records them in its
        // durable journal; those records arrive inside the posture
        // projection (dcd.patroli, source 'daemon-otomatis') and merge
        // here by real timestamp. The patrol mode is derived from the
        // loop's reported state: 'berkala' only while the daemon reports
        // its loop running, otherwise 'atas-permintaan' for the manual
        // registry patrols. No cadence is invented on this side; the
        // schedule numbers come from the loop state itself.
        const patrolKind = r => { const m = /^\s*PATROLI\s+(SISTEM|JARINGAN)\b/i.exec(String(r.task || '')); return m ? m[1].toLowerCase() : (/^\s*PATROLI\b/i.test(String(r.task || '')) ? 'umum' : null); };
        const dcd = cyber ? await cyber.daemonPosture().catch(() => ({ available: false, reason: 'DAEMON_TIDAK_TERJANGKAU' }))
          : { available: false, reason: 'BINDING_TIDAK_TERSEDIA' };
        const daemonPatrols = (dcd.available && Array.isArray(dcd.patroli) ? dcd.patroli : [])
          .filter(r => r && typeof r === 'object' && ['sistem', 'jaringan', 'umum'].includes(r.kind));
        const kindOf = r => r.kind || patrolKind(r);
        const patrols = [...wk.filter(r => patrolKind(r)), ...daemonPatrols]
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const latestOf = kind => { const hit = patrols.find(r => kindOf(r) === kind); return hit ? row(hit) : null; };
        const loopState = dcd.available && dcd.patrolLoop && typeof dcd.patrolLoop === 'object' ? dcd.patrolLoop : null;
        const modePatroli = loopState && loopState.mode === 'berkala' ? 'berkala' : 'atas-permintaan';
        const jadwalPatroli = modePatroli === 'berkala' ? {
          sistemMenit: Number.isSafeInteger(loopState.sistem?.intervalMs) ? Math.round(loopState.sistem.intervalMs / 60000) : null,
          jaringanMenit: Number.isSafeInteger(loopState.jaringan?.intervalMs) ? Math.round(loopState.jaringan.intervalMs / 60000) : null,
          sistemBerikutnya: Number.isSafeInteger(loopState.sistem?.nextRunAt) ? loopState.sistem.nextRunAt : null,
          jaringanBerikutnya: Number.isSafeInteger(loopState.jaringan?.nextRunAt) ? loopState.jaringan.nextRunAt : null } : null;
        return json(200, { success: true, data: {
          werkudara: { runs: wk.slice(0, 20).map(row), totalRuns: wk.length,
            completed: wk.filter(r => r.state === 'COMPLETED').length,
            failed: wk.filter(r => r.state === 'FAILED').length,
            lastRunAt: wk.length ? wk[0].createdAt : null },
          patroli: patrols.slice(0, 12).map(r => ({ ...row(r), kind: kindOf(r), ...(r.source ? { source: r.source } : {}) })),
          patroliTerbaru: { sistem: latestOf('sistem'), jaringan: latestOf('jaringan'), umum: latestOf('umum') },
          modePatroli,
          jadwalPatroli,
          dcd, generatedAt: Date.now() } });
      }
      // Otomasi (F10): the daemon automation service's real record for the
      // Presence portal and the Control Otomasi page: the daily brief's
      // config state (enabled, time), the scheduler's running state, the
      // last processed day, and the brief outcomes the service published to
      // the daemon's telemetry buffer. One genuine source only: the
      // canonical daemon's own projection, read through the Core binding.
      // The desktop Core composes no second service and writes nothing:
      // config changes have no gated route yet (the daemon console rejects
      // legacy action ingress for automation), so this surface is a read
      // projection and the views say so. Owner only, like the other
      // posture reads.
      if (p === '/api/r9/otomasi' && req.method === 'GET' && !url.search) {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        const data = otomasi ? await otomasi.daemonStatus().catch(() => ({ available: false, reason: 'DAEMON_TIDAK_TERJANGKAU' }))
          : { available: false, reason: 'BINDING_TIDAK_TERSEDIA' };
        return json(200, { success: true, data: { ...data, generatedAt: Date.now() } });
      }
      if (p === '/api/r9/lifecycle/restart') {
        if (req.method !== 'POST' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        const input = await body(req, 1024);
        if (Object.keys(input).length) return json(400, { success: false, error: 'INVALID_RESTART_REQUEST' });
        if (!lifecycle?.reserve || !lifecycle?.commit) return json(503, { success: false, error: 'CORE_LIFECYCLE_UNAVAILABLE' });
        const outstanding = lifecycleCounts();
        if (!outstanding.jobStateAvailable || outstanding.activeTurns || outstanding.pendingPermissions || outstanding.activePandawaRuns || outstanding.queuedPandawaRuns || outstanding.activeDiscussions || outstanding.activeJobs)
          return json(409, { success: false, error: 'CORE_RESTART_BLOCKED_OUTSTANDING_WORK', data: outstanding });
        const requestId = await lifecycle.reserve();
        if (!requestId) return json(429, { success: false, error: 'CORE_RESTART_RATE_LIMIT_OR_SUPERVISOR_UNAVAILABLE' });
        res.once('finish', () => lifecycle.commit(requestId));
        return json(202, { success: true, data: { state: 'RESTART_ACCEPTED' } });
      }
      // Windows media session (Fase 3a): SMTC now-playing for the Notch music pill. Read = any
      // authenticated role; control = Owner only (it drives the owner's own desktop playback).
      if (p === '/api/r9/media') {
        if (req.method === 'GET' && !url.search) {
          return json(200, { success: true, data: media ? await media.getSession() : { available: false, reason: 'MEDIA_NOT_COMPOSED' } });
        }
        if (req.method === 'POST' && !url.search) {
          if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
          if (!media) return json(503, { success: false, error: 'MEDIA_NOT_COMPOSED' });
          const input = await body(req, 1024);
          try {
            const result = await media.control(input.action);
            return json(200, { success: true, data: result });
          } catch (e) {
            return json(400, { success: false, error: e && e.code ? e.code : 'MEDIA_CONTROL_FAILED' });
          }
        }
        return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
      }
      // Workspace sandbox policy for /sandbox (read-only description of the enforced boundary).
      if (req.method === 'GET' && p === '/api/r9/sandbox' && !url.search) return json(200, { success: true, data: sandbox() });
      // Idle Presence / Notch config (read-only; requester or owner). Written only by Owner via /settings action 'update' values.presence.
      if (p === '/api/r9/presence/settings' && settings?.presence) {
        if (req.method !== 'GET' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        return json(200, { success: true, data: settings.presence() });
      }
      // Show/focus Idle Presence (Control's surface button): drop a raise signal into the session directory -
      // the Presence main process watches it and brings its window forward - and, when no Presence is running,
      // start it through the canonical launcher (which itself refuses to spawn a second one). Owner only,
      // bound to the caller's attached session like every other Control action.
      if (p === '/api/r9/presence/raise') {
        if (req.method !== 'POST' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        const input = await body(req, 1024);
        sessions.requireAttached(input.cliSession, input.client);
        try { fs.writeFileSync(path.join(directory, 'presence-raise.json'), JSON.stringify({ at: Date.now() })); } catch {}
        if (Date.now() - lastRaiseSpawnAt > 10000) {
          lastRaiseSpawnAt = Date.now();
          try { require('node:child_process').spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'release', 'damar.cjs'), 'presence'], { detached: true, stdio: 'ignore' }).unref(); } catch {}
        }
        return json(200, { success: true, data: { raised: true } });
      }
      // First-run onboarding (Presence, Owner only). Save: the confirmed answers land in the same centralized
      // settings store Control reads; the completion flag is composed here server-side (never accepted from
      // the client) and a completed onboarding cannot be saved twice. Chat: one branch-A interview turn via
      // Core's onboarding service (fixed system prompt, granted live model only; 409 -> template fallback).
      if (p === '/api/r9/presence/onboarding' || p === '/api/r9/presence/onboarding/chat' || p === '/api/r9/presence/onboarding/probe') {
        if (req.method !== 'POST' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        if (!settings) return json(503, { success: false, error: 'SETTINGS_UNAVAILABLE' });
        const input = await body(req, 16384);
        if (p.endsWith('/chat')) {
          if (!onboardingChat) return json(503, { success: false, error: 'ONBOARDING_CHAT_UNAVAILABLE' });
          try { return json(200, { success: true, data: await onboardingChat.chat(input?.messages) }); }
          catch (e) { return json(e.status || 502, { success: false, error: e.message || 'ONBOARDING_CHAT_FAILED' }); }
        }
        // V2 step-0 probing: the service probes the active connection's catalog (capability-first
        // policy) and returns the brain/reflex pair; the Presence client then selects the brain.
        if (p.endsWith('/probe')) {
          if (!onboardingChat?.probeAll) return json(503, { success: false, error: 'ONBOARDING_PROBE_UNAVAILABLE' });
          try { return json(200, { success: true, data: await onboardingChat.probeAll() }); }
          catch (e) { return json(e.status || 502, { success: false, error: e.message || 'ONBOARDING_PROBE_FAILED' }); }
        }
        const allowed = ['displayName', 'salutation', 'voiceEnabled', 'language'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))
          || (input.displayName !== undefined && typeof input.displayName !== 'string')
          || (input.salutation !== undefined && typeof input.salutation !== 'string')
          || (input.voiceEnabled !== undefined && typeof input.voiceEnabled !== 'boolean')
          || (input.language !== undefined && !['id', 'en'].includes(input.language)))
          return json(400, { success: false, error: 'ONBOARDING_REQUEST_INVALID' });
        if (settings.presence().presence.onboardingCompleted === true) return json(409, { success: false, error: 'ONBOARDING_ALREADY_COMPLETED', data: settings.presence() });
        try {
          const presence = { onboardingCompleted: true };
          for (const k of ['displayName', 'salutation', 'voiceEnabled']) if (input[k] !== undefined) presence[k] = input[k];
          const values = { presence };
          if (input.language !== undefined) values.cli = { language: input.language };
          settings.update(values);
          return json(200, { success: true, data: settings.presence() });
        } catch (e) { if (e.status) return json(e.status, { success: false, error: e.message }); throw e; }
      }
      // DAMAR CLI appearance + last accepted provider/model (read-only; requester or owner). Owner writes: /settings values.cli.
      if (p === '/api/r9/cli/settings' && settings?.cli) {
        if (req.method !== 'GET' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        return json(200, { success: true, data: settings.cli() });
      }
      if (p === '/api/r9/settings' && settings) {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        if (req.method !== 'POST' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        const input = await body(req, 16384);
        if (!/^[a-f0-9]{64}$/.test(input.cliSession || '')) return json(400, { success: false, error: 'CLI_SESSION_REQUIRED' });
        sessions.requireAttached(input.cliSession, input.client);
        const root = sessions.get(input.cliSession).cwd;
        try {
          if (input.action === 'read') return json(200, { success: true, data: { ...settings.view(), plugins: settings.plugins(root), availableSkills: settings.skills(root).map(({ body, ...metadata }) => metadata) } });
          if (input.action === 'update') return json(200, { success: true, data: settings.update(input.values || {}) });
          if (input.action === 'trust-plugin') return json(200, { success: true, data: settings.trustPlugin(root, input.key, input.trusted === true) });
          return json(400, { success: false, error: 'ACTION_INVALID' });
        } catch (e) { if (e.status) return json(e.status, { success: false, error: e.message }); throw e; }
      }
      if (req.method === 'GET' && p === '/api/r9/pandawa/runs' && !url.search) return json(200, { success: true, data: { runs: [...runs.values()].slice(-32).map(view), workers: WORKERS, queued } });
      if (req.method === 'GET' && p === '/api/r9/pandawa/runs') {
        const s = url.searchParams.get('cliSession');
        if (!/^[a-f0-9]{64}$/.test(s || '') || [...url.searchParams.keys()].length !== 1) return json(400, { success: false, error: 'CLI_SESSION_REQUIRED' });
        return json(200, { success: true, data: { runs: runsFor(s).slice(-32), workers: WORKERS, queued } });
      }
      // Session history: the single local operator's own CLI credential (requester or owner) reads and appends.
      if (p === '/api/r9/sessions' || p.startsWith('/api/r9/sessions/')) {
        if (url.search) return json(400, { success: false, error: 'NO_QUERY_ALLOWED' });
        const m = /^\/api\/r9\/sessions(?:\/([a-f0-9]{64})(?:\/(attach|events|close))?)?$/.exec(p);
        if (!m) return json(404, { success: false, error: 'SESSION_NOT_FOUND' });
        const [, id, action] = m;
        if (req.method === 'GET' && !action) return json(200, { success: true, data: id ? sessions.get(id) : { sessions: sessions.list(), ledger: sessions.disclosure() } });
        if (req.method !== 'POST' || (!id && action) || (id && !action)) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        const input = await body(req, action === 'events' ? 262144 : 8192);
        if (!id) return json(201, { success: true, data: sessions.create(input) });
        return json(200, { success: true, data: sessions[action === 'events' ? 'append' : action](id, input) });
      }
      if (req.method === 'GET' && p === '/api/r9/usage') {
        const s = url.searchParams.get('cliSession');
        if (!/^[a-f0-9]{64}$/.test(s || '') || [...url.searchParams.keys()].length !== 1) return json(400, { success: false, error: 'CLI_SESSION_REQUIRED' });
        return json(200, { success: true, data: { ...usageFor(s), canonicalUsageToday: canonicalUsageToday() } });
      }
      if (req.method === 'GET' && p === '/api/r9/provider' && !url.search) { const l = registry.list(), a = registry.active(); return json(200, { success: true, data: { ...l, model: a.model, executable: a.executable, liveInference: l.liveInferenceAuthorized } }); }
      if (req.method === 'GET' && p === '/api/r9/provider/budget' && !url.search) return json(200, { success: true, data: budget?.view() || { mode: 'offline-test-fixture', attempts: 0, totalTokens: 0, blocked: false } });
      if (req.method === 'GET' && p === '/api/r9/models') {
        const id = url.searchParams.get('provider');
        if (!/^[a-z0-9-]{1,32}$/.test(id || '') || [...url.searchParams.keys()].length !== 1) return json(400, { success: false, error: 'PROVIDER_REQUIRED' });
        return json(200, { success: true, data: { provider: id, models: await registry.models(id), metadataOnly: true } });
      }
      // Session-bound agent services (Owner credential + the session lease): undo/redo checkpoints, interrupted turns.
      if ((p === '/api/r9/checkpoints' && checkpoints) || (p === '/api/r9/turns/interrupted' && turns) || (p === '/api/r9/memory' && memory)) {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        if (req.method !== 'POST' || url.search) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        const input = await body(req);
        if (!/^[a-f0-9]{64}$/.test(input.cliSession || '')) return json(400, { success: false, error: 'CLI_SESSION_REQUIRED' });
        sessions.requireAttached(input.cliSession, input.client);
        if (p === '/api/r9/memory') {
          if (!memory.validRoot(input.root)) return json(400, { success: false, error: 'WORKSPACE_INVALID' });
          if (input.action === 'list') return json(200, { success: true, data: memory.store.list(input.root) });
          try {
            if (input.action === 'add') return json(200, { success: true, data: memory.store.add(input.root, input.text) });
            if (input.action === 'forget') return json(200, { success: true, data: memory.store.forget(input.root, input.id) });
            if (input.action === 'clear') return json(200, { success: true, data: memory.store.clear(input.root) });   // privacy: delete all notes of the workspace
            if (input.action === 'export') return json(200, { success: true, data: memory.store.exportAll() });       // privacy: every workspace's notes
          } catch (e) { if (e.status) return json(e.status, { success: false, error: e.message }); throw e; }
          return json(400, { success: false, error: 'ACTION_INVALID' });
        }
        if (p === '/api/r9/turns/interrupted') {
          if (input.action === 'get') return json(200, { success: true, data: turns.interrupted(input.cliSession) });
          return json(200, { success: true, data: turns.resolveInterrupted(input.cliSession, input.turnId, input.action) });
        }
        if (input.action === 'list') return json(200, { success: true, data: checkpoints.list(input.cliSession) });
        if (!['undo', 'redo'].includes(input.kind)) return json(400, { success: false, error: 'KIND_INVALID' });
        if (input.action === 'preview') return json(200, { success: true, data: checkpoints.preview(input.cliSession, input.kind) });
        if (input.action === 'run') {
          try { return json(200, { success: true, data: await checkpoints.run(input.cliSession, input.kind, input.turnId) }); }
          catch (e) { if (e.status) return json(e.status, { success: false, error: e.message, files: e.files || undefined }); throw e; }
        }
        return json(400, { success: false, error: 'ACTION_INVALID' });
      }
      // Redacted activity of agent turns (requester or owner; command/prompt text only for owner). Read-only.
      if (turns && p === '/api/r9/activity') {
        if (req.method !== 'GET') return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        const keys = [...url.searchParams.keys()], from = url.searchParams.get('from') ?? '0';
        if (keys.some(k => k !== 'from') || !/^\d{1,9}$/.test(from)) return json(400, { success: false, error: 'FROM_INVALID' });
        return json(200, { success: true, data: turns.activity(Number(from), who) });
      }
      // Agent turns (Owner credential only): start, live events (SSE, replay from ?from=N), permission answer, cancel.
      if (turns && (p === '/api/r9/turns' || p.startsWith('/api/r9/turns/'))) {
        if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
        const m = /^\/api\/r9\/turns(?:\/(turn-[a-f0-9-]{36})(?:\/(events|permission|cancel))?)?$/.exec(p);
        if (!m) return json(404, { success: false, error: 'TURN_NOT_FOUND' });
        const [, id, action] = m;
        // Turn status for reconciliation (live turn or durable journal).
        if (req.method === 'GET' && id && !action) {
          if (url.search) return json(400, { success: false, error: 'QUERY_NOT_ALLOWED' });
          return json(200, { success: true, data: turns.status(id) });
        }
        if (req.method === 'GET' && action === 'events') {
          const keys = [...url.searchParams.keys()], from = url.searchParams.get('from') ?? '0';
          if (keys.some(k => k !== 'from') || !/^\d{1,5}$/.test(from)) return json(400, { success: false, error: 'FROM_INVALID' });
          turns.stream(id, Number(from), res); return true;
        }
        if (req.method !== 'POST' || url.search || action === 'events' || (id && !action)) return json(405, { success: false, error: 'METHOD_NOT_ALLOWED' });
        const input = await body(req, 16384);
        if (!id) return json(202, { success: true, data: turns.start({ cliSession: input.cliSession, client: input.client, text: input.text, cwd: input.cwd, owner: true }) });
        // `surface: 'notch'`: Owner decision from the desktop notch (no CLI lease); any other surface value is refused.
        if (action === 'permission') {
          if (input.surface !== undefined && input.surface !== 'notch') return json(400, { success: false, error: 'SURFACE_INVALID' });
          return json(200, { success: true, data: turns.answer(id, input.permissionId, input.decision, input.client, input.surface === 'notch' ? 'notch' : null) });
        }
        return json(200, { success: true, data: turns.cancel(id, ['CLI_EXITED'].includes(input.reason) ? input.reason : null) });
      }
      if (req.method !== 'POST') return json(404, { success: false, error: 'NOT_FOUND' });
      if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
      const input = await body(req);
      if (p === '/api/r9/provider') {
        const keys = Object.keys(input).sort().join();
        if (!['provider', 'model,provider', 'expectedVersion,model,provider'].includes(keys) || typeof input.provider !== 'string' || (input.model !== undefined && typeof input.model !== 'string') || (input.expectedVersion !== undefined && typeof input.expectedVersion !== 'string')) return json(400, { success: false, error: 'PROVIDER_SELECTION_INVALID' });
        if (queued >= MAX_QUEUE) return json(429, { success: false, error: 'QUEUE_FULL' });
        const selected = await enqueue(() => registry.select(input.provider, input.model, input.expectedVersion));
        try { if (selected.model) settings?.recordSelection?.(selected.id, selected.model); } catch {}  // remembered for the next session; never blocks the selection
        return json(200, { success: true, data: { active: selected.id, model: selected.model, executable: selected.executable, reason: selected.reason } });
      }
      if (p === '/api/r9/provider/revoke') {
        if (Object.keys(input).sort().join() !== 'provider' || typeof input.provider !== 'string') return json(400, { success: false, error: 'PROVIDER_REVOCATION_INVALID' });
        const result = await enqueue(() => registry.revoke(input.provider));
        return json(200, { success: true, data: result });
      }
      if (p === '/api/r9/connect') {
        const allowed = ['apiKey', 'baseUrl', 'provider', 'remember', 'model', 'expectedVersion', 'label', 'injectedTokens'];
        if (typeof input.provider !== 'string' || Object.keys(input).some(k => !allowed.includes(k))) return json(400, { success: false, error: 'CONNECT_REQUEST_INVALID' });
        const connected = await enqueue(() => registry.connect(input.provider, { label: input.label, baseUrl: input.baseUrl, apiKey: input.apiKey, remember: input.remember, model: input.model, expectedVersion: input.expectedVersion, injectedTokens: input.injectedTokens }));
        return json(200, { success: true, data: connected });
      }
      // Delete a user-defined provider connection (and its remembered key).
      if (p === '/api/r9/provider/remove') {
        const keys = Object.keys(input).sort().join();
        if (!['provider', 'expectedVersion,provider'].includes(keys) || typeof input.provider !== 'string') return json(400, { success: false, error: 'PROVIDER_REMOVAL_INVALID' });
        return json(200, { success: true, data: await enqueue(() => registry.remove(input.provider, input.expectedVersion)) });
      }
      if (p === '/api/r9/pandawa/runs') { const r = startRun(input); return json(r.status, r.body); }
      const cancel = /^\/api\/r9\/pandawa\/runs\/(run_[a-f0-9]{32})\/cancel$/.exec(p);
      if (cancel) {
        const r = runs.get(cancel[1]);
        if (!r) return json(404, { success: false, error: 'RUN_NOT_FOUND' });
        if (Object.keys(input).length) return json(400, { success: false, error: 'INVALID_BODY' });
        if (TERMINAL.has(r.state)) return json(409, { success: false, error: 'ALREADY_TERMINAL', data: view(r) });
        if (!r.cancelRequested) record(r.runId, { cancelRequested: true });
        return json(202, { success: true, data: { ...view(runs.get(r.runId)), interruptible: r.state === 'ACCEPTED', note: r.state === 'RUNNING' ? 'RUNNING: the provider call finishes, its result is discarded and the run ends CANCELLED' : 'CANCELLED_BEFORE_START_WHEN_DEQUEUED' } });
      }
      return json(404, { success: false, error: 'NOT_FOUND' });
    } catch (error) { if (res.headersSent) { res.end(); return true; } return json(error.status || 503, { success: false, error: error.status ? error.message : 'R9_UNAVAILABLE' }); }
  }
  handle.recordTurnUsage = recordTurnUsage;
  handle.sessions = sessions;
  handle.pandawa = { start: startRun, view: id => (runs.has(id) ? view(runs.get(id)) : null), cancel: cancelRun, workers: WORKERS };
  return handle;
}
module.exports = { createR9Routes, readJsonl, appendDurable, WORKERS };
