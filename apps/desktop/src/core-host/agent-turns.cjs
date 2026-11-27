'use strict';
// Agent turns for the CLI composer: one natural-language turn runs through Core's real agent loop
// (aiRuntimeService.stream -> model -> tools -> model ...) and is streamed to the CLI as server-sent events.
// The turn identity is passed in `exec` (channelType 'cli') with channel left undefined, because Core removes all tools
// on the 'cli' channel (Owner-approved, documented deviation). Role 'superadmin' is used only for owner-token requests.
// Permission requests from consequential workspace tools pause the turn until the Owner answers (or the turn is cancelled).
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const { createReasoningSplitter } = require('./reasoning-split.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
// The running turn of the current async call chain ({ id, signal }). Core's provider calls made inside a turn run in it,
// so the host can (a) abort the provider HTTP request when the turn is cancelled or loses its lease (Core's HttpClient
// takes no caller signal) and (b) tag loopback provider requests with the turn id, so token receipts are attributed
// per request even when several sessions run turns at once (see installTurnFetch).
const turnContext = new AsyncLocalStorage();
const TURN_HEADER = 'x-damar-turn';
// Explicit-approval classifier (Owner mandate, 2026-11-28). An owner-initiated
// request IS the mandate for the ordinary steps it needs; the permission
// broker stops for explicit approval ONLY for the two named categories:
// (1) actions touching credentials, (2) deletions. Everything else resolves
// 'once' here, while the Authority Gate inside the workspace tools still
// evaluates and records every operation (audit trail unchanged).
const GATE_CREDENTIAL_RE = /(credential|kredensial|password|kata\s*sandi|api[-_ ]?key|secret|vault|dpapi|cmdkey|\.ssh|credentials\.json|key[-_ ]?store|damar_token|access[-_ ]?token|refresh[-_ ]?token)/i;
const GATE_DELETE_RE = /(remove-item|rmdir|\brm\b|\bdel\b|erase|clear-content|git\s+clean|format-(volume|disk|partition)\b|delete\s+(file|folder|directory|all|item)|menghapus)/i;
function gateExplicit(card) {
  const text = [card?.tool, card?.run, card?.change, card?.scope].filter(Boolean).join(' ');
  if (GATE_CREDENTIAL_RE.test(text)) return true;
  if (/delete|remove|erase/i.test(String(card?.tool || ''))) return true;
  if ((card?.tool === 'workspace_shell' || card?.tool === 'workspace_run') && GATE_DELETE_RE.test(text)) return true;
  return false;
}
// Host-side composition (no Core file edited): wraps globalThis.fetch once. Inside a turn the turn's abort signal is
// linked into every request; the turn id header is added only for loopback URLs (offline fixtures / local proxies),
// never sent to a remote provider.
function installTurnFetch(isLoopback) {
  if (globalThis.fetch.__damarTurn) return;
  const real = globalThis.fetch;
  const wrapped = (input, init = {}) => {
    const t = turnContext.getStore(); if (!t) return real(input, init);
    const url = String(input?.url ?? input), headers = new Headers(init.headers ?? input?.headers);
    if (isLoopback(url)) headers.set(TURN_HEADER, t.id);
    return real(input, { ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, t.signal]) : t.signal });
  };
  wrapped.__damarTurn = true; globalThis.fetch = wrapped;
}
// What kind of provider failure ended a turn (the CLI words it in the Owner's language); null when not recognised.
// Only FAILED turns are classified; an Owner cancel ends CANCELLED, so an abort here is Core's own provider time limit.
function providerErrorKind(error) {
  const e = String(error || '');
  if (/\b402\b|quota|insufficient|billing|payment required|credit/i.test(e)) return 'QUOTA';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api key|authentication/i.test(e)) return 'AUTH';
  if (/\b429\b|rate.?limit|too many requests/i.test(e)) return 'RATE_LIMIT';
  if (/\b40[8]\b|\b504\b|timed? ?out|deadline exceeded|ETIMEDOUT|PROVIDER_(REQUEST|INACTIVITY)_TIMEOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT|operation was aborted|AbortError|tidak menjawab dalam \d+ detik/i.test(e)) return 'TIMEOUT';
  if (/\b5\d\d\b|unavailable|overloaded|EMPTY_PROVIDER_STREAM|ECONNREFUSED|ECONNRESET|ENOTFOUND|UND_ERR_SOCKET|fetch failed|bad gateway/i.test(e)) return 'UNAVAILABLE';
  return null;
}

const MAX_EVENTS = 4000, HISTORY_TURNS = 50; // kept per session; cognitive.historyTurns (default 20) decides how many are replayed
const SESSION = /^[a-f0-9]{64}$/, CLIENT = /^[A-Za-z0-9_-]{8,80}$/;

// Model context is per authenticated session: a turn names its Core session ledger id and the CLI client that holds the
// session's lease (authorize() checks both); only that session's completed turns are sent to the model. The history is
// durable (historyFile, append-only), so a Core restart or a later `damar resume` continues the same conversation.
// Interrupted work: every turn is journaled (START, completed STEPs, END). A turn ended by the CLI exiting, by its
// client disconnecting while a permission card waits, or by a Core restart is INTERRUPTED; on resume the CLI offers
// /continue, which starts a NEW turn that states the original request and the steps already completed (approvals are
// never replayed: every consequential step asks again).
function createAgentTurns({ aiRuntime, isProtectedRoot, recordUsage, activeProvider, offeredTools = () => undefined, authorize = () => {}, holds = () => true, historyFile = null, appendDurable = null, readJsonl = null, journalFile = null, projectMemory = null, deadlines = null, settings = null }) {
  const journal = new Map();       // turnId -> { turnId, session, text, steps: [], status, resolved }
  const note = row => { const r = { t: Date.now(), ...row }; try { if (journalFile && appendDurable) appendDurable(journalFile, r); } catch {} applyJournal(r); };
  function applyJournal(r) {
    if (r.type === 'START') journal.set(r.turnId, { turnId: r.turnId, session: r.session, text: r.text, steps: [], status: 'RUNNING', resolved: null, t: r.t });
    const j = journal.get(r.turnId); if (!j) return;
    if (r.type === 'STEP' && j.steps.length < 40) j.steps.push(r.step);
    if (r.type === 'END') { j.status = r.status; j.reason = r.reason || null; j.error = typeof r.error === 'string' ? r.error : null; }
    if (r.type === 'RESOLVED') j.resolved = r.how;
  }
  if (journalFile && readJsonl) {
    for (const r of readJsonl(journalFile)) applyJournal(r);
    for (const j of journal.values()) if (j.status === 'RUNNING') note({ type: 'END', turnId: j.turnId, status: 'INTERRUPTED', reason: 'CORE_RESTARTED_DURING_TURN' });
  }
  const HEARTBEAT_MS = deadlines?.view().heartbeatMs ?? 2000;
  const turns = new Map();          // turnId -> turn
  const bySession = new Map();      // turn session key -> turnId of the running turn
  const history = new Map();        // cliSession -> [{ role, content }]
  const answers = new Map();        // turnId -> final assistant text (bounded), for status reconciliation
  const keepAnswer = (turnId, text) => { answers.set(turnId, String(text).slice(0, 16384)); if (answers.size > 512) answers.delete(answers.keys().next().value); };
  if (historyFile && readJsonl) for (const row of readJsonl(historyFile)) {
    if (!SESSION.test(row?.session || '') || !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string') continue;
    const h = history.get(row.session) || []; h.push({ role: row.role, content: row.content }); history.set(row.session, h.slice(-HISTORY_TURNS * 2));
    if (row.role === 'assistant' && typeof row.turnId === 'string') keepAnswer(row.turnId, row.content);
  }

  const keyOf = cliSession => 'cli-' + cliSession.slice(0, 40);

  // Redacted cross-turn activity feed (GET /api/r9/activity): kind, file basename and diff counts only; command and
  // prompt text only for the owner role. Bounded ring with a monotonic sequence number.
  const activityLog = []; let activitySeq = 0;
  const base = p => (typeof p === 'string' && p ? path.basename(p.replace(/\s+\(.*\)$/, '')).slice(0, 120) : null);
  function noteActivity(turn, e) {
    let a = null;
    if (e.type === 'tool' && ['READ', 'GLOB', 'GREP'].includes(e.badge)) a = { kind: 'read', file: e.badge === 'READ' ? base(e.target) : null, detail: e.target };
    else if (e.type === 'tool' && ['RUN', 'VERIFY'].includes(e.badge)) a = { kind: 'run', detail: e.target };
    else if (e.type === 'tool' && e.badge === 'SHELL') a = { kind: 'shell', detail: e.target };
    else if (e.type === 'diff') a = { kind: 'edit', file: base(e.path), added: e.diff?.added ?? null, removed: e.diff?.removed ?? null, detail: e.path };
    else if (e.type === 'permission') a = { kind: 'permission', permissionId: e.id, tool: e.card?.tool || null, file: ['workspace_write', 'workspace_edit'].includes(e.card?.tool) ? base(e.card.run) : null, added: e.card?.diff?.added ?? null, removed: e.card?.diff?.removed ?? null, detail: e.card?.run };
    else if (e.type === 'permission_answer') a = { kind: 'permission_answer', permissionId: e.id, decision: e.decision, surface: e.surface || 'cli' };
    else if (e.type === 'final') a = { kind: 'final', status: e.status };
    if (!a) return;
    activityLog.push({ seq: activitySeq++, turnId: turn.id, file: null, added: null, removed: null, at: e.t, ...a, detail: typeof a.detail === 'string' ? a.detail.slice(0, 200) : null });
    if (activityLog.length > 1000) activityLog.shift();
  }
  function push(turn, event) {
    if (turn.events.length >= MAX_EVENTS) return;
    if (event.type === 'tool' || event.type === 'diff' || event.type === 'run')
      note({ type: 'STEP', turnId: turn.id, step: event.type === 'diff' ? `${event.badge} ${event.path}` : event.type === 'run' ? `ran ${event.target} (exit ${event.exitCode})` : `${event.badge} ${event.target}` });
    const e = { seq: turn.events.length, t: Date.now(), ...event };
    turn.events.push(e);
    noteActivity(turn, e);
    for (const l of turn.listeners) l(e);
  }

  // Context handed to workspace tools for the running turn of a session key.
  const broker = {
    context(sessionKey) {
      const turn = turns.get(bySession.get(sessionKey));
      if (!turn || turn.status !== 'RUNNING' || turn.abort.signal.aborted) return null;   // nothing runs after a cancel or a lost lease
      return {
        root: turn.root, cliSession: turn.cliSession, turnId: turn.id, signal: turn.abort.signal, sessionEndsAt: turn.sessionEndsAt,
        emit: event => push(turn, event),
        requestPermission: card => new Promise(resolve => {
          if (turn.abort.signal.aborted) return resolve('deny');
          const profile = settings?.autonomy() || 'ask';
          if (profile === 'read-only') return resolve('deny');
          // Mandat Owner (2026-11-28): an owner-initiated request is itself
          // the mandate for its ordinary steps, so the broker no longer stops
          // per step. Only the two explicit categories in gateExplicit()
          // (credentials, deletions) still raise a permission card. This
          // supersedes the former per-profile card flow and the memory-consent
          // card: a project memory note is neither category, so it now runs
          // under the mandate like any other ordinary step.
          if (!gateExplicit(card)) return resolve('once');
          const id = 'perm-' + crypto.randomUUID();
          turn.pending.set(id, resolve);
          push(turn, { type: 'permission', id, card });
          turn.abort.signal.addEventListener('abort', () => { if (turn.pending.delete(id)) resolve('deny'); }, { once: true });
        }),
      };
    },
  };

  async function run(turn) {
    // Project memory of this workspace (Owner-approved notes), routed skills and the bounded session history (cognitive.cjs).
    const cog = require('./cognitive.cjs').contextFor({ settings, projectMemory, root: turn.root, text: turn.text, history: history.get(turn.cliSession) || [], skills: settings?.route(turn.root, turn.text) || [] });
    const msgs = cog.messages; push(turn, cog.trace);
    const provider = activeProvider(), ledgerStart = provider?.ledger?.length ?? 0;
    let text = '', sawModelEvent = false;
    // Session fencing: work runs only while the starting CLI holds the session lease. When the lease expires (the CLI
    // stopped heartbeating) or another client attached, the turn is interrupted (LEASE_LOST): no further model call,
    // tool or permission card for the stale client.
    const fence = setInterval(() => { if (turn.status === 'RUNNING' && !turn.abort.signal.aborted && !holds(turn.cliSession, turn.client)) { turn.interruptReason = 'LEASE_LOST'; push(turn, { type: 'cancel_requested', reason: 'LEASE_LOST' }); turn.abort.abort(); } }, 1000);
    fence.unref?.();
    const execution = setTimeout(() => { if (turn.status === 'RUNNING' && !turn.abort.signal.aborted) { turn.executionExpired = true; turn.abort.abort(); } }, deadlines?.view().executionMs ?? 1800000);
    execution.unref?.();
    const split = createReasoningSplitter();
    const emitText = ({ answer, reasoning }) => {
      if (reasoning) push(turn, { type: 'reasoning', text: reasoning });
      if (answer) { text += answer; push(turn, { type: 'delta', text: answer }); }
    };
    try {
      // Explicit candidates (Core's G1 path): still filtered by Core's disclosure/authorization gate, never a bypass.
      const stream = turnContext.run({ id: turn.id, signal: turn.abort.signal }, () => aiRuntime.stream({ messages: msgs, role: turn.role, sessionId: turn.key, signal: turn.abort.signal, tools: offeredTools(),
        exec: { role: turn.role, channelType: 'cli', channelId: turn.cliSession.slice(0, 64), sessionId: turn.key } }));
      // A cancel or a lost lease ends the wait at once, even while the provider is silent (the request is aborted too).
      const it = stream[Symbol.asyncIterator](), stopped = new Promise(r => { if (turn.abort.signal.aborted) r({ stop: true }); turn.abort.signal.addEventListener('abort', () => r({ stop: true }), { once: true }); });
      for (;;) {
        const next = turnContext.run({ id: turn.id, signal: turn.abort.signal }, () => it.next()); next.catch(() => {});
        const step = await Promise.race([next, stopped]);
        if (step.stop || step.done || turn.abort.signal.aborted) { if (!step.done) it.return?.().catch?.(() => {}); break; }
        const chunk = step.value;
        if (chunk?.delta || chunk?.reasoning || chunk?.toolCalls?.length) sawModelEvent = true;
        // Reasoning (the provider's own field, or <think> inline in the content) is its own event, never the answer.
        if (typeof chunk?.reasoning === 'string' && chunk.reasoning) push(turn, { type: 'reasoning', text: chunk.reasoning });
        if (chunk?.delta) emitText(split.feed(chunk.delta));
        if (Array.isArray(chunk?.toolCalls) && chunk.toolCalls.length && !chunk.done) for (const c of chunk.toolCalls) push(turn, { type: 'tool_call', name: c.name ?? c.function?.name ?? null });
      }
      emitText(split.flush());
    } catch (error) {
      turn.error = String(error?.code || error?.message || error).slice(0, 200);
    }
    // An aborted provider request settles in the ledger (CLIENT_ABORTED) a moment after the abort.
    if (turn.abort.signal.aborted) await new Promise(r => setTimeout(r, 250));
    if (turn.executionExpired) turn.error = 'Turn execution deadline exceeded';
    if (!turn.abort.signal.aborted && !turn.error && !sawModelEvent) turn.error = 'EMPTY_PROVIDER_STREAM';
    turn.status = turn.executionExpired ? 'FAILED' : turn.abort.signal.aborted ? (turn.interruptReason ? 'INTERRUPTED' : 'CANCELLED') : turn.error ? 'FAILED' : 'COMPLETED';
    if (turn.status !== 'FAILED') turn.error = null;
    // Token receipts from the provider's own ledger for this turn, keyed by the CLI session (no estimation): only the
    // tool-bearing requests tagged with this turn's id (concurrent turns of other sessions never claim each other's).
    const entries = (provider?.ledger?.slice(ledgerStart) || []).filter(e => e.turnId === turn.id && e.tools > 0);
    try { recordUsage({ turnId: turn.id, cliSession: turn.cliSession, entries }); } catch {}
    // Only a completed turn becomes context; a cancelled or failed turn is never replayed to the model.
    if (turn.status === 'COMPLETED') {
      const rows = [{ role: 'user', content: turn.text }, { role: 'assistant', content: text || '(no text)' }];
      try { if (historyFile && appendDurable) for (const r of rows) appendDurable(historyFile, { session: turn.cliSession, turnId: turn.id, ...r }); }
      catch { turn.historyPersisted = false; }
      keepAnswer(turn.id, text || '');
      const h = history.get(turn.cliSession) || [];
      h.push(...rows);
      history.set(turn.cliSession, h.slice(-HISTORY_TURNS * 2));
    }
    clearInterval(fence);
    clearTimeout(execution);
    for (const resolve of turn.pending.values()) resolve('deny');
    turn.pending.clear();
    note({ type: 'END', turnId: turn.id, status: turn.status, reason: turn.interruptReason || null, error: turn.error ? String(turn.error).slice(0, 300) : null });
    push(turn, { type: 'final', status: turn.status, text, error: turn.error || null, errorKind: turn.status === 'FAILED' ? providerErrorKind(turn.error) : null,
      usage: { inputTokens: entries.reduce((n, e) => n + (e.promptTokens || 0), 0), outputTokens: entries.reduce((n, e) => n + (e.completionTokens || 0), 0), modelCalls: entries.length } });
    bySession.delete(turn.key);
  }

  const api = {
    broker,
    activity(from, role) {
      const rows = activityLog.filter(a => a.seq >= from).slice(0, 200);
      return { next: activitySeq, events: role === 'owner' ? rows : rows.map(({ detail, ...a }) => a) };
    },
    // External activity rows (Pandawa discussions: kind 'discussion', ids/round/state only, never text).
    noteActivity(a) { activityLog.push({ seq: activitySeq++, turnId: null, file: null, added: null, removed: null, at: Date.now(), detail: null, ...a }); if (activityLog.length > 1000) activityLog.shift(); },
    counts() { const live = [...turns.values()].filter(t => t.status === 'RUNNING'); return { running: live.length, pendingPermissions: live.reduce((n, t) => n + t.pending.size, 0) }; },
    start({ cliSession, client, text, cwd, owner }) {
      if (!SESSION.test(cliSession || '')) throw Object.assign(Error('CLI_SESSION_REQUIRED'), { status: 400 });
      if (!CLIENT.test(client || '')) throw Object.assign(Error('CLIENT_ID_REQUIRED'), { status: 400 });
      authorize(cliSession, client);   // the session exists and this CLI holds its lease (else 404 / 409)
      const selectedProvider = activeProvider();
      if (!selectedProvider?.executable) throw Object.assign(Error(selectedProvider?.reason || 'LIVE_INFERENCE_NOT_AUTHORIZED'), { status: 409 });
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw Object.assign(Error('TEXT_REQUIRED'), { status: 400 });
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw Object.assign(Error('WORKSPACE_INVALID'), { status: 400 });
      if (isProtectedRoot(cwd)) throw Object.assign(Error('PROTECTED_WORKSPACE'), { status: 403 });
      const key = keyOf(cliSession);
      if (bySession.has(key)) throw Object.assign(Error('TURN_ALREADY_RUNNING'), { status: 409 });
      const turn = { id: 'turn-' + crypto.randomUUID(), cliSession, client, key, text, root: fs.realpathSync.native(cwd), role: owner ? 'superadmin' : 'user',
        status: 'RUNNING', events: [], listeners: new Set(), pending: new Map(), abort: new AbortController(), sessionEndsAt: Date.now() + 12 * 3600 * 1000, error: null };
      turns.set(turn.id, turn); bySession.set(key, turn.id);
      note({ type: 'START', turnId: turn.id, session: cliSession, text: text.slice(0, 2000) });
      setImmediate(() => run(turn));
      return { turnId: turn.id, workspace: turn.root };
    },
    get: id => turns.get(id) || null,
    // Core is stopping: running turns end INTERRUPTED (CORE_STOPPED) and are journaled before the providers close.
    async shutdown() {
      const live = [...turns.values()].filter(t => t.status === 'RUNNING');
      for (const t of live) { t.interruptReason = 'CORE_STOPPED'; push(t, { type: 'cancel_requested', reason: 'CORE_STOPPED' }); t.abort.abort(); }
      for (let i = 0; i < 40 && live.some(t => t.status === 'RUNNING' || !t.events.some(e => e.type === 'final')); i++) await new Promise(r => setTimeout(r, 50));
    },
    // The latest unresolved interrupted turn of a session (for /continue after resume), with its completed steps.
    interrupted(session) {
      const last = [...journal.values()].filter(j => j.session === session).at(-1);
      return last && last.status === 'INTERRUPTED' && !last.resolved ? { turnId: last.turnId, text: last.text, steps: last.steps, reason: last.reason } : null;
    },
    resolveInterrupted(session, turnId, how) {
      const j = journal.get(turnId);
      if (!j || j.session !== session || j.status !== 'INTERRUPTED' || j.resolved) throw Object.assign(Error('NOTHING_TO_RESOLVE'), { status: 409 });
      if (!['continued', 'dismissed'].includes(how)) throw Object.assign(Error('RESOLUTION_INVALID'), { status: 400 });
      note({ type: 'RESOLVED', turnId, how });
      return { turnId, how, text: j.text, steps: j.steps };
    },
    // surface: 'notch' = an Owner-authenticated decision from the desktop notch (the route has already required the Owner
    // credential); it needs no CLI lease. The permission must still be pending on this turn; the first decision wins.
    answer(id, permissionId, decision, client, surface = null) {
      const turn = turns.get(id); if (!turn) throw Object.assign(Error('TURN_NOT_FOUND'), { status: 404 });
      // Only the CLI that started the turn and still holds the lease may answer its card (a stale window cannot approve).
      if (surface !== 'notch' && (client !== turn.client || !holds(turn.cliSession, client))) throw Object.assign(Error('SESSION_NOT_ATTACHED'), { status: 409 });
      const resolve = turn.pending.get(permissionId); if (!resolve) throw Object.assign(Error('PERMISSION_NOT_PENDING'), { status: 409 });
      if (!['once', 'session', 'deny'].includes(decision)) throw Object.assign(Error('DECISION_INVALID'), { status: 400 });
      turn.pending.delete(permissionId); resolve(decision);
      push(turn, { type: 'permission_answer', id: permissionId, decision, ...(surface === 'notch' ? { surface } : {}) });
      return { decision };
    },
    cancel(id, reason = null) {
      const turn = turns.get(id); if (!turn) throw Object.assign(Error('TURN_NOT_FOUND'), { status: 404 });
      if (turn.status === 'RUNNING') { if (reason === 'CLI_EXITED' || reason === 'CLIENT_DISCONNECTED') turn.interruptReason = reason; push(turn, { type: 'cancel_requested' }); turn.abort.abort(); }
      return { status: turn.status };
    },
    // Status for reconciliation after a lost stream: the live turn, or (after a Core restart) the durable journal.
    // `final` is present once the turn has ended; a client that missed the stream is given the answer from it.
    status(id) {
      const turn = turns.get(id);
      if (turn) return { turnId: id, status: turn.status, live: true, lastSeq: turn.events.length - 1, final: turn.events.find(e => e.type === 'final') || null };
      const j = journal.get(id); if (!j) throw Object.assign(Error('TURN_NOT_FOUND'), { status: 404 });
      const ended = j.status !== 'RUNNING';
      return { turnId: id, status: j.status, live: false, lastSeq: null, steps: j.steps.slice(-40),
        final: ended ? { type: 'final', status: j.status, text: answers.get(id) ?? null, error: j.error || j.reason || null, recovered: true } : null };
    },
    // Server-sent events: replay from `from`, then live until the final event. Headers are flushed at once and a
    // heartbeat comment is written every HEARTBEAT_MS, so a long silent model call never leaves the connection idle
    // (Core's server closes sockets idle for 5 s by design; that limit stays as the slow-client guard).
    stream(id, from, res) {
      const turn = turns.get(id); if (!turn) throw Object.assign(Error('TURN_NOT_FOUND'), { status: 404 });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.flushHeaders?.();
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, HEARTBEAT_MS);
      heartbeat.unref?.();
      res.on('close', () => clearInterval(heartbeat));
      const send = e => { res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); if (e.type === 'final') { clearInterval(heartbeat); turn.listeners.delete(send); res.end(); } };
      for (const e of turn.events.slice(Math.max(0, from))) { send(e); if (e.type === 'final') return; }
      turn.listeners.add(send);
      // The CLI went away (terminal closed, crash) while a permission card waits: nobody can answer it, so the turn is
      // interrupted after a short grace period (a reconnecting client resumes the stream with ?from=N).
      res.on('close', () => { turn.listeners.delete(send); setTimeout(() => { if (turn.status === 'RUNNING' && !turn.listeners.size && turn.pending.size) api.cancel(id, 'CLIENT_DISCONNECTED'); }, 5000).unref?.(); });
    },
  };
  return api;
}
module.exports = { providerErrorKind, createAgentTurns, installTurnFetch, turnContext, TURN_HEADER };
