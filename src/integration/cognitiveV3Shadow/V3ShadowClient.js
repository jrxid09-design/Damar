'use strict';
/**
 * Process-isolated, opt-in shadow observer for the Python V3 cognitive runtime.
 * No sockets, tool access, privileged writes, or production authority.
 * This is a staging adapter; do not wire into canonicalRuntimeComposition until
 * independent review and explicit owner integration acceptance.
 */
const { spawn } = require('node:child_process');
const PROTOCOL = 'damar-v3-shadow-stdio/1';
const MAX_LINE = 64 * 1024;
const MAX_REQUEST = 16 * 1024;
const READ_MODEL_FIELDS = new Set([
  'schema_version','mode','production','authority','engine_state','freshness',
  'source','model_availability','timestamp','event_count','paid_llm_calls','protected_effects'
]);
const ENGINE_STATES = new Set([
  'BOOTSTRAPPING','OFFLINE_MOCK','READY_READONLY','ATTENDING','REFLECTING',
  'CONSOLIDATING_IDLE','PAUSED','DEGRADED','LOCKED','STOPPED'
]);
const FRESHNESS_STATES = new Set([
  'UNKNOWN','CURRENT','STALE','UNTRUSTED','CONFLICTING','REVOKED'
]);

function safeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      Object.keys(snapshot).length !== READ_MODEL_FIELDS.size ||
      Object.keys(snapshot).some(key => !READ_MODEL_FIELDS.has(key)) ||
      snapshot.schema_version !== '1.0.0' ||
      snapshot.mode !== 'OFFLINE_MOCK' || snapshot.production !== false ||
      snapshot.authority !== 'NONE' || snapshot.protected_effects !== 0 ||
      snapshot.paid_llm_calls !== 0 ||
      snapshot.model_availability !== 'MISSING' ||
      snapshot.source !== 'standalone_cognitive_runtime' ||
      !ENGINE_STATES.has(snapshot.engine_state) ||
      !FRESHNESS_STATES.has(snapshot.freshness) ||
      !Number.isSafeInteger(snapshot.event_count) || snapshot.event_count < 0 ||
      typeof snapshot.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.timestamp))) return false;
  return true;
}

function safeResult(op, result) {
  if (op === 'snapshot') return safeSnapshot(result);
  if (op === 'observe') return result && typeof result === 'object' &&
    Object.keys(result).sort().join(',') === 'disposition,event_id,snapshot' &&
    ['COMMITTED','DUPLICATE'].includes(result.disposition) &&
    typeof result.event_id === 'string' && result.event_id.length > 0 &&
    safeSnapshot(result.snapshot);
  return op === 'shutdown' && result && typeof result === 'object' &&
    Object.keys(result).length === 1 && result.detached === true;
}


function safeMeta(message) {
  return message?.protocol === PROTOCOL && message.mode === 'OFFLINE_MOCK' &&
    message.production === false && message.authority === 'NONE';
}

class V3ShadowClient {
  constructor({ executable, args, cwd, env, timeoutMs = 5000 } = {}) {
    if (typeof executable !== 'string' || !executable || !Array.isArray(args) ||
        args.some(x => typeof x !== 'string') || !cwd || !env ||
        env.DAMAR_V3_SHADOW_ONLY !== '1') {
      throw new Error('SHADOW_CONFIGURATION_REQUIRED');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
      throw new Error('INVALID_TIMEOUT');
    }
    this.options = { executable, args: [...args], cwd, env: { ...env }, timeoutMs };
    this.child = null;
    this.ready = false;
    this.closed = false;
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = '';
  }

  async start() {
    if (this.child || this.closed) throw new Error('ALREADY_STARTED');
    const { executable, args, cwd, env, timeoutMs } = this.options;
    this.child = spawn(executable, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stderr.on('data', () => {}); // deliberately do not surface private diagnostics
    this.child.stdout.on('data', chunk => this._receive(chunk));
    this.child.on('error', () => this._fail('CHILD_UNAVAILABLE'));
    this.child.on('exit', () => this._fail('CHILD_EXITED'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.startPending = null;
        reject(new Error('START_TIMEOUT'));
        this._fail('START_TIMEOUT');
      }, timeoutMs);
      this.startPending = {
        resolve: () => { clearTimeout(timer); resolve(this); },
        reject: error => { clearTimeout(timer); reject(error); }
      };
      if (this.closed) this._fail('CHILD_UNAVAILABLE');
    });
  }

  _receive(chunk) {
    if (this.closed) return;
    this.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE * 2) {
      this._fail('FRAME_TOO_LARGE'); return;
    }
    for (let newline; (newline = this.buffer.indexOf('\n')) >= 0;) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
        this._fail('FRAME_TOO_LARGE'); return;
      }
      let message;
      try { message = JSON.parse(line); } catch { this._fail('INVALID_FRAME'); return; }
      if (!safeMeta(message)) { this._fail('UNSAFE_RUNTIME_STATE'); return; }
      if (!this.ready) {
        if (message.kind !== 'ready') { this._fail('INVALID_HANDSHAKE'); return; }
        this.ready = true;
        const pending = this.startPending;
        this.startPending = null;
        pending?.resolve();
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending || typeof message.ok !== 'boolean') { this._fail('UNSOLICITED_RESPONSE'); return; }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        if (!safeResult(pending.op, message.result)) {
          pending.reject(new Error('UNSAFE_RESPONSE'));
          this._fail('UNSAFE_RESPONSE');
          return;
        }
        pending.resolve(message.result);
      } else {
        const code = typeof message.error === 'string' ? message.error : 'SHADOW_ERROR';
        pending.reject(new Error(code));
        if (code === 'UNSAFE_RUNTIME_STATE') { this._fail(code); return; }
      }
    }
  }

  _fail(code) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.startPending) {
      this.startPending.reject(new Error(code));
      this.startPending = null;
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(code));
    }
    this.pending.clear();
    try { this.child?.kill(); } catch {}
  }

  request(op, payload) {
    if (!this.ready || this.closed) return Promise.reject(new Error('SHADOW_NOT_READY'));
    if (!['snapshot', 'observe', 'shutdown'].includes(op)) {
      return Promise.reject(new Error('UNKNOWN_OPERATION'));
    }
    if (this.pending.size >= 8) return Promise.reject(new Error('BACKPRESSURE'));
    const id = String(++this.nextId);
    const message = { id, op };
    if (payload !== undefined) message.payload = payload;
    const encoded = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST) {
      return Promise.reject(new Error('REQUEST_TOO_LARGE'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RESPONSE_TIMEOUT'));
        this._fail('RESPONSE_TIMEOUT');
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op });
      this.child.stdin.write(encoded, error => {
        if (error) this._fail('CHILD_WRITE_FAILURE');
      });
    });
  }

  snapshot() { return this.request('snapshot'); }
  observe(category, count = 1) { return this.request('observe', { category, count }); }
  async close() {
    if (this.closed) return;
    try { if (this.ready) await this.request('shutdown'); }
    finally { this._fail('CLIENT_CLOSED'); }
  }
}

module.exports = { V3ShadowClient, PROTOCOL, safeSnapshot };
