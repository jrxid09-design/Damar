'use strict';
// CLI side of the Core session ledger (/api/r9/sessions*). Opens or attaches one session, journals the transcript
// as displayed plus operation and model changes, keeps the attach lease alive, and closes it on exit.
// Nothing is stored locally; Core owns the record. Event ids make every retry idempotent.
const crypto = require('node:crypto');
const ID = /^[a-f0-9]{64}$/;
const newId = prefix => prefix + crypto.randomUUID().replace(/-/g, '');

const HEARTBEAT_MS = 5000, LEASE_WAIT_MS = 16000;   // Core's session lease is 15 s (cli-sessions.cjs)
class SessionHistory {
  constructor(client) {
    this.client = client; this.clientId = newId('cli_'); this.id = null;
    this.pending = []; this.chain = Promise.resolve(); this.timer = null; this.lastError = null;
  }
  async call(route, body) {
    const r = await this.client.r9(route, body ? { method: 'POST', body } : {});
    if (!r.ok || r.body?.success !== true) throw Object.assign(Error(typeof r.body?.error === 'string' ? r.body.error : 'SESSION_HTTP_' + r.status), { status: r.status });
    return r.body.data;
  }
  list() { return this.call('/api/r9/sessions'); }
  get(id) { if (!ID.test(id)) throw Error('INVALID_SESSION_ID'); return this.call('/api/r9/sessions/' + id); }
  // A unique prefix (8+ hex characters) resolves to the full id; anything else is rejected.
  async resolve(text) {
    const value = String(text || '').toLowerCase();
    if (!/^[a-f0-9]{8,64}$/.test(value)) throw Error('INVALID_SESSION_ID');
    const matches = (await this.list()).sessions.filter(s => s.sessionId.startsWith(value));
    if (!matches.length) throw Error('SESSION_NOT_FOUND');
    if (matches.length > 1) throw Error('SESSION_ID_AMBIGUOUS');
    return matches[0].sessionId;
  }
  async open(meta) { const d = await this.call('/api/r9/sessions', { client: this.clientId, ...meta }); this.bind(d.sessionId); return d; }
  // A window that just crashed still holds the lease until it expires (Core: 15 s); resume waits for that instead of
  // failing, telling the Owner how long. A window that is still alive keeps its lease, so the wait ends in the error.
  async attach(id, { onWait } = {}) {
    if (!ID.test(id)) throw Error('INVALID_SESSION_ID');
    const deadline = Date.now() + LEASE_WAIT_MS;
    for (;;) {
      try { const d = await this.call('/api/r9/sessions/' + id + '/attach', { client: this.clientId }); this.bind(id); return d; }
      catch (error) {
        if (error.message !== 'SESSION_ATTACHED_ELSEWHERE' || Date.now() >= deadline) throw error;
        onWait?.(Math.ceil((deadline - Date.now()) / 1000));
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  bind(id) {
    this.id = id; this.client.sessionId = id;  // runs, usage and holds are keyed by this session from now on
    clearInterval(this.timer);
    this.timer = setInterval(() => this.flush().catch(() => {}), HEARTBEAT_MS); this.timer.unref?.();  // lease heartbeat
  }
  record(event) { if (!this.id) return; this.pending.push({ eventId: newId('e_'), ...event }); this.flush().catch(() => {}); }
  flush() {
    const run = this.chain.then(async () => {
      while (this.id) {
        const events = this.pending.splice(0, 32);
        try { await this.call('/api/r9/sessions/' + this.id + '/events', { client: this.clientId, events }); this.lastError = null; }
        catch (error) { this.pending.unshift(...events); this.lastError = error.message; throw error; }
        if (!this.pending.length) return;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
  // Flush and release the lease. Returns the final summary, or null when nothing could be confirmed.
  async close() {
    clearInterval(this.timer); this.timer = null;
    if (!this.id) return null;
    const id = this.id;
    try { await this.flush(); } catch {}
    try { const summary = await this.call('/api/r9/sessions/' + id + '/close', { client: this.clientId }); this.id = null; return { ...summary, unsaved: this.pending.length }; }
    catch (error) { this.lastError = error.message; return null; }
  }
}
module.exports = { SessionHistory, ID };
