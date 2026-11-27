'use strict';
// Durable CLI session history on the SAME Core ledger contract as Pandawa runs and usage receipts (r9-routes):
// one append-only JSONL file in the Core data directory, one fsync'd row per event, copied by --recover-from.
// Session ids are random 64-hex values that double as the `cliSession` key of runs and usage receipts; they are
// never used to build a file path. Usage and Pandawa activity are joined from their own ledgers, never copied.
const crypto = require('node:crypto'), fs = require('node:fs');

const ID = /^[a-f0-9]{64}$/, TOKEN = /^[A-Za-z0-9_-]{8,64}$/, STATE = /^[A-Z_]{2,40}$/;
const PROVIDER = /^[a-z0-9-]{1,32}$/, MODEL = /^[A-Za-z0-9._:\/@+-]{1,128}$/;
const OP_DONE = new Set(['COMPLETED', 'FAILED', 'CANCELLED_CONFIRMED', 'OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN_HELD', 'DENIED', 'REJECTED']);
const RUN_DONE = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN']);
// One CLI window holds a session at a time. Its heartbeat (every 5 s) renews the lease; three missed beats free the
// session for `damar resume` after a crash (was 45 s with a 15 s beat: same fencing, a third of the wait).
const LEASE_MS = 15000, MAX_MESSAGES = 2000, MAX_SESSIONS = 512, MAX_EVENTS = 32;
// Credential-shaped text never enters history (defence in depth: the CLI already masks free-text arguments).
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/g;
const text = (s, n) => String(s ?? '').replace(SECRET, '[REDACTED]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ').slice(0, n);
const line = (s, n) => text(s, n).replace(/[\r\n\t]+/g, ' ').trim();

// Reads the session ledger without discarding history: a torn final line (crash mid-append) is ignored and any
// other unreadable line is reported (never rewritten, never silently dropped from the disclosure).
function readLedger(file) {
  if (!fs.existsSync(file)) return { rows: [], corruptLines: [], tornTail: false };
  const raw = fs.readFileSync(file, 'utf8'), lines = raw.split('\n'), rows = [], corruptLines = [];
  const tornTail = raw.length > 0 && !raw.endsWith('\n');
  lines.forEach((l, i) => {
    if (!l) return;
    try { const v = JSON.parse(l); if (v && typeof v === 'object' && ID.test(v.sessionId || '') && typeof v.type === 'string') rows.push(v); else throw 0; }
    catch { if (!(tornTail && i === lines.length - 1)) corruptLines.push(i + 1); }
  });
  return { rows, corruptLines, tornTail };
}

function createSessionStore({ file, appendDurable, runsFor, usageFor, turnHistoryFor = null, now = Date.now }) {
  const sessions = new Map(), seen = new Set(), leases = new Map();
  const apply = ev => {
    if (ev.eventId) seen.add(ev.eventId);
    if (ev.type === 'OPENED') {
      sessions.set(ev.sessionId, { sessionId: ev.sessionId, title: ev.title, cwd: ev.cwd, createdAt: ev.t, updatedAt: ev.t, provider: ev.provider || null,
        model: ev.model || null, messages: [], operations: new Map(), closed: false, closedAt: null, lastClient: ev.client || null });
      return;
    }
    const s = sessions.get(ev.sessionId); if (!s) return;
    s.updatedAt = ev.t;
    if (ev.type === 'MESSAGE') { s.messages.push({ t: ev.t, role: ev.role, text: ev.text }); if (s.messages.length > MAX_MESSAGES) s.messages.shift(); }
    else if (ev.type === 'MODEL') { s.provider = ev.provider; s.model = ev.model; }
    else if (ev.type === 'OPERATION') { const prev = s.operations.get(ev.operationId); s.operations.set(ev.operationId, { operationId: ev.operationId, command: ev.command || prev?.command || null, state: ev.state, reason: ev.reason || null, startedAt: prev?.startedAt ?? ev.t, updatedAt: ev.t }); }
    else if (ev.type === 'TITLE') s.title = ev.title;
    else if (ev.type === 'ATTACHED') { s.closed = false; s.lastClient = ev.client; }
    else if (ev.type === 'CLOSED') { s.closed = true; s.closedAt = ev.t; }
  };
  const write = ev => { const row = { t: now(), ...ev }; appendDurable(file, row); apply(row); return row; };
  const loaded = readLedger(file);
  for (const ev of loaded.rows) apply(ev);
  // No replay after a Core restart: an operation that was still open has an unknown outcome and is never re-run.
  for (const s of sessions.values()) for (const op of s.operations.values())
    if (!OP_DONE.has(op.state)) write({ type: 'OPERATION', sessionId: s.sessionId, operationId: op.operationId, state: 'OUTCOME_UNKNOWN', reason: 'CORE_RESTARTED_DURING_OPERATION' });

  const leaseOf = id => { const l = leases.get(id); return l && l.until > now() ? l : null; };
  // Surfaces that hold their conversation in the agent-turn journal (Presence) keep no MESSAGE rows in this
  // ledger; their transcript is bound from agent-turn-history at read time so Control can show the full record.
  const boundConversation = s => s.messages.length ? s.messages : (turnHistoryFor ? turnHistoryFor(s.sessionId) : []);
  const summary = s => {
    const ops = [...s.operations.values()].sort((a, b) => a.updatedAt - b.updatedAt), runs = runsFor(s.sessionId), usage = usageFor(s.sessionId);
    return { sessionId: s.sessionId, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt, provider: s.provider, model: s.model,
      messages: boundConversation(s).length, closed: s.closed, attached: !!leaseOf(s.sessionId), lastOperation: ops.at(-1) || null,
      openOperations: ops.filter(o => !OP_DONE.has(o.state)), unresolvedOperations: ops.filter(o => /^OUTCOME_UNKNOWN/.test(o.state)),
      subagentRuns: runs.length, activeSubagentRuns: runs.filter(r => !RUN_DONE.has(r.state)).length,
      tokens: { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens, complete: usage.complete } };
  };
  const detail = s => ({ ...summary(s), conversation: boundConversation(s), operations: [...s.operations.values()], subagents: runsFor(s.sessionId), usage: usageFor(s.sessionId) });
  const fail = (status, error) => Object.assign(Error(error), { status });
  const clientOf = input => { if (!TOKEN.test(input.client || '')) throw fail(400, 'CLIENT_ID_REQUIRED'); return input.client; };
  const own = (id, client) => {
    const s = sessions.get(id); if (!s) throw fail(404, 'SESSION_NOT_FOUND');
    const l = leaseOf(id); if (!l || l.client !== client) throw fail(409, 'SESSION_NOT_ATTACHED');
    l.until = now() + LEASE_MS; return s;
  };
  const event = (id, e) => {
    if (!e || typeof e !== 'object' || !TOKEN.test(e.eventId || '')) throw fail(400, 'EVENT_ID_REQUIRED');
    const base = { sessionId: id, eventId: e.eventId };
    if (e.type === 'MESSAGE' && ['user', 'assistant'].includes(e.role) && typeof e.text === 'string') return { ...base, type: 'MESSAGE', role: e.role, text: text(e.text, 16384) };
    if (e.type === 'MODEL' && PROVIDER.test(e.provider || '') && MODEL.test(e.model || '')) return { ...base, type: 'MODEL', provider: e.provider, model: e.model };
    if (e.type === 'OPERATION' && TOKEN.test(e.operationId || '') && STATE.test(e.state || '')) return { ...base, type: 'OPERATION', operationId: e.operationId, state: e.state, command: line(e.command, 40) || null, reason: line(e.reason, 80) || null };
    if (e.type === 'TITLE' && typeof e.title === 'string' && line(e.title, 80)) return { ...base, type: 'TITLE', title: line(e.title, 80) };
    throw fail(400, 'INVALID_SESSION_EVENT');
  };

  return {
    disclosure: () => ({ corruptLines: loaded.corruptLines, tornTail: loaded.tornTail }),
    list: () => [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200).map(summary),
    get: id => { const s = sessions.get(id); if (!s) throw fail(404, 'SESSION_NOT_FOUND'); return detail(s); },
    // Agent turns run only for the CLI that holds the session's lease (and refresh it).
    // Non-renewing fence check: does this client still hold a live lease (running work stops when it does not)?
    holds: (id, client) => { const l = leaseOf(id); return !!l && l.client === client; },
    requireAttached(id, client) { const s = own(id, clientOf({ client })); if (s.closed) throw fail(409, 'SESSION_CLOSED'); return true; },
    create(input) {
      const client = clientOf(input);
      if (sessions.size >= MAX_SESSIONS) throw fail(429, 'SESSION_LIMIT');
      if (typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 260) throw fail(400, 'CWD_REQUIRED');
      if ((input.provider !== undefined || input.model !== undefined) && !(PROVIDER.test(input.provider || '') && MODEL.test(input.model || ''))) throw fail(400, 'INVALID_MODEL');
      const sessionId = crypto.randomBytes(32).toString('hex');
      write({ type: 'OPENED', sessionId, eventId: 'open_' + sessionId.slice(0, 24), client, title: line(input.title, 80) || 'Session', cwd: line(input.cwd, 260),
        ...(input.provider ? { provider: input.provider, model: input.model } : {}) });
      leases.set(sessionId, { client, until: now() + LEASE_MS });
      return detail(sessions.get(sessionId));
    },
    attach(id, input) {
      const client = clientOf(input), s = sessions.get(id);
      if (!s) throw fail(404, 'SESSION_NOT_FOUND');
      const l = leaseOf(id);
      if (l && l.client !== client) throw fail(409, 'SESSION_ATTACHED_ELSEWHERE');
      // The previous CLI is gone (exit, closed terminal or crash): its CLI-owned operations cannot still be running.
      if (!l) for (const op of s.operations.values())
        if (!OP_DONE.has(op.state)) write({ type: 'OPERATION', sessionId: id, operationId: op.operationId, state: 'OUTCOME_UNKNOWN', reason: 'PREVIOUS_CLI_DETACHED' });
      leases.set(id, { client, until: now() + LEASE_MS });
      write({ type: 'ATTACHED', sessionId: id, eventId: 'attach_' + crypto.randomUUID().replace(/-/g, ''), client });
      return detail(s);
    },
    append(id, input) {
      const client = clientOf(input); own(id, client);
      if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) throw fail(400, 'EVENTS_REQUIRED');
      const rows = input.events.map(e => event(id, e));  // validate all before writing any
      let accepted = 0, duplicates = 0;
      for (const row of rows) { if (seen.has(row.eventId)) { duplicates++; continue; } write(row); accepted++; }
      return { accepted, duplicates };
    },
    close(id, input) {
      const client = clientOf(input), s = own(id, client);
      write({ type: 'CLOSED', sessionId: id, eventId: 'close_' + crypto.randomUUID().replace(/-/g, ''), client });
      leases.delete(id);
      return summary(s);
    },
  };
}
module.exports = { createSessionStore, readLedger, ID };
