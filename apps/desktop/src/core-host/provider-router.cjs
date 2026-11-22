'use strict';
// Provider router: per-request key rotation, cooldown/failover, combo fallback and concurrency for every live dispatch.
//  - Canonical path (CLI turns, Pandawa): installCanonical() wraps HttpClient.post/stream INSIDE the usage meter, so the
//    meter reserves/settles once per logical request against the Owner's selection, and this layer picks the key (and,
//    for a combo, the target) per attempt.
//  - Gateway / tests: dispatch() meters every upstream attempt separately through budget.run() (same ledger and caps)
//    and talks to the upstream with node:http/https (separate header and inactivity timeouts, like provider-deadlines).
// Failover only on retryable outcomes (401/403/408/429/5xx/network), bounded by MAX_ATTEMPTS; never an infinite retry.
// Concurrency: at most `maxConcurrency` in-flight requests per connection (queued, not refused; held until a stream ends).
const http = require('node:http'), https = require('node:https'), { Readable } = require('node:stream');
const { fetchModels } = require('./provider-registry.cjs');
const { retryable } = require('./provider-keys.cjs');
const { byteInputBound } = require('./provider-budget.cjs');
const MAX_ATTEMPTS = 6;
const statusOf = error => { const m = /^(\d{3})\b/.exec(String(error?.message || '')); return m ? Number(m[1]) : null; };
const metaStatus = code => code === 'PROVIDER_AUTH_REQUIRED' ? 401 : /^PROVIDER_METADATA_HTTP_(\d{3})$/.test(code) ? Number(code.slice(-3)) : 'network';

function withTarget(options, target, key) {
  const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([k]) => k.toLowerCase() !== 'authorization'));
  if (key) headers.authorization = 'Bearer ' + key.secret;
  let body = options.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  if (body && typeof body === 'object') body = { ...body, model: target.model };
  return { ...options, headers, body };
}
// One upstream POST over node:http/https. Resolves with the IncomingMessage once headers arrive; the header clock and
// the per-chunk inactivity clock are separate, so a long but live stream is never cut. No redirects are followed.
function upstreamRequest(rawUrl, { headers = {}, body, signal, stream = false }, { headerMs, idleMs }) {
  const url = new URL(rawUrl);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(stream ? { accept: 'text/event-stream' } : {}), ...headers } }, res => {
      clearTimeout(timer); res.setTimeout(idleMs, () => res.destroy(Error('PROVIDER_INACTIVITY_TIMEOUT'))); resolve(res);
    });
    const timer = setTimeout(() => req.destroy(Error('PROVIDER_REQUEST_TIMEOUT')), headerMs);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(payload);
  });
}
const readAll = async (res, max = 32 << 20) => { const chunks = []; let n = 0; for await (const c of res) { n += c.length; if (n > max) { res.destroy(); throw Error('PROVIDER_RESPONSE_TOO_LARGE'); } chunks.push(c); } return Buffer.concat(chunks).toString('utf8'); };
// Pass a web stream through and call `done` exactly once when it ends, errors or is cancelled.
function holdUntilDone(stream, done) {
  const reader = stream.getReader(); let released = false; const release = () => { if (!released) { released = true; done(); } };
  return new ReadableStream({
    async pull(c) { try { const p = await reader.read(); if (p.done) { release(); c.close(); } else c.enqueue(p.value); } catch (e) { release(); c.error(e); } },
    async cancel(r) { try { await reader.cancel(r); } finally { release(); } },
  });
}

// routeOverride(): { connection, model } of a Pandawa member's assigned model for the current request (pandawa-team routeFor
// via cognitive.runScope), or null; the targets then come from that connection + model, still grant-checked.
function createProviderRouter({ registry, budget = null, timeouts = () => ({ providerRequestMs: 600000, inactivityMs: 600000 }), now = Date.now, routeOverride = () => null }) {
  const pool = registry.pool;
  // Per-connection concurrency: a FIFO of waiters; no request is refused for being concurrent.
  const slots = new Map();
  const limitOf = id => registry.limitsOf?.(id)?.maxConcurrency || pool.routing?.()?.maxConcurrency || 8;
  function acquire(id) {
    const s = slots.get(id) || { active: 0, queue: [] }; slots.set(id, s);
    const release = () => { s.active--; const next = s.queue.shift(); if (next) { s.active++; next(); } };
    if (s.active < limitOf(id)) { s.active++; return Promise.resolve(release); }
    return new Promise(ok => s.queue.push(() => ok(release)));
  }
  const concurrency = () => Object.fromEntries([...slots].map(([id, s]) => [id, { active: s.active, queued: s.queue.length, max: limitOf(id) }]));
  // perform(target, key) -> { ok, status?, value?, error? }. Tries targets in order, keys per target per strategy.
  async function attempt(targets, perform) {
    let last = null, n = 0;
    for (const t of targets) {
      const tried = new Set();
      while (n < MAX_ATTEMPTS) {
        const pooled = pool.size(t.id) > 0, key = pooled ? pool.pick(t.id, tried) : null;
        if (pooled && !key) break;                       // every key of this target is disabled or cooling down
        n++;
        const release = await acquire(t.id);
        const done = () => { release(); if (key) pool.done?.(t.id, key.kid); };
        let r;
        try { r = await perform(t, key); } catch (error) { done(); throw error; }
        // A stream holds its connection slot (and key) until it ends.
        if (r.ok && r.value instanceof ReadableStream) r.value = holdUntilDone(r.value, done); else done();
        const outcome = r.ok ? 'ok' : r.status ?? 'network';
        const failover = key ? pool.report(t.id, key.kid, outcome) : !r.ok && retryable(outcome);
        if (!r.ok) registry.persistHealth?.();
        if (r.ok || !failover) return { ...r, target: t, kid: key?.kid || null, attempts: n };
        last = { ...r, target: t, kid: key?.kid || null, attempts: n };
        if (!key) break;
        tried.add(key.kid);
      }
    }
    return last || { ok: false, status: 503, error: Object.assign(Error('NO_UPSTREAM_AVAILABLE'), { status: 503 }), attempts: n };
  }

  // transport: true (Core) sends non-stream provider calls with this module's node:http transport (header/inactivity clocks,
  // tolerant JSON for routers that append an SSE terminator to JSON bodies) instead of the canonical fetch client.
  function installCanonical(HttpClient, { transport = false } = {}) {
    for (const kind of ['post', 'stream']) {
      const original = HttpClient[kind];
      if (original.__damarRouter) continue;
      const wrapped = async function (url, options = {}) {
        const a = registry.active(), base = String(a.baseUrl || '').replace(/\/$/, '');
        if (a.kind !== 'live' || !base || !String(url).startsWith(base + '/')) return original.call(this, url, options);
        const o = routeOverride(), suffix = String(url).slice(base.length), targets = o ? registry.targets(o.connection, o.model) : registry.targets(a.id, a.model);
        if (!targets.length) throw Object.assign(Error('LIVE_INFERENCE_NOT_AUTHORIZED'), { code: 'LIVE_INFERENCE_NOT_AUTHORIZED' });
        const r = await attempt(targets, async (t, key) => {
          const u = t.baseUrl.replace(/\/$/, '') + suffix, o = withTarget(options, t, key);
          if (kind === 'post') { const res = transport ? { statusText: '', headers: {}, ...await sendJson(null)(u, o) } : await original.call(this, u, o); return { ok: !!res?.success, status: res?.status ?? 'network', value: res }; }
          try { return { ok: true, value: await original.call(this, u, o) }; } catch (error) { return { ok: false, status: statusOf(error) ?? 'network', error }; }
        });
        if (kind === 'stream' && !r.ok) throw r.error || Error(`${r.status} UPSTREAM_UNAVAILABLE`);
        return r.value ?? { success: false, status: r.status === 'network' ? 502 : r.status, error: r.error?.message || 'NO_UPSTREAM_AVAILABLE' };
      };
      wrapped.__damarRouter = true; HttpClient[kind] = wrapped;
    }
  }

  const clocks = () => { const t = timeouts(); return { headerMs: t.providerRequestMs, idleMs: t.inactivityMs }; };
  const sendJson = signal => async (url, options) => {
    let res;
    try { res = await upstreamRequest(url, { headers: options.headers, body: options.body, signal }, clocks()); }
    catch (error) { return { success: false, error: error.message }; }
    // Some routers append an SSE terminator to a non-stream JSON body ("{...}data: [DONE]"): tolerate it.
    const text = await readAll(res); let data = text; try { data = JSON.parse(text.replace(/\s*data:\s*\[DONE\]\s*$/, '')); } catch {}
    return { success: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, contentType: res.headers['content-type'] };
  };
  const sendStream = signal => async (url, options) => {
    const res = await upstreamRequest(url, { headers: options.headers, body: options.body, signal, stream: true }, clocks());
    if (res.statusCode < 200 || res.statusCode >= 300) { const detail = (await readAll(res, 1 << 20).catch(() => '')).slice(0, 4000); throw Object.assign(Error(`${res.statusCode} ${res.statusMessage}`), { detail }); }
    return Readable.toWeb(res);
  };
  const controlErrors = /BUDGET|METER|NOT_AUTHORIZED|BOUND_REQUIRED|ROUTE_MISMATCH|REQUEST_INVALID|STORE_UNAVAILABLE/;
  // Gateway / test dispatch: each attempt metered through budget.run with an explicit target.
  async function dispatch({ targets, path = '/chat/completions', body, stream = false, extra = {}, signal, fixedKey = null }) {
    if (!budget) throw Object.assign(Error('PROVIDER_USAGE_METER_UNAVAILABLE'), { status: 503 });
    if (!targets.length) throw Object.assign(Error('LIVE_MODEL_NOT_AUTHORIZED'), { status: 403 });
    const perform = async (t, key) => {
      const k = fixedKey || key;
      const p = { id: t.id, baseUrl: t.baseUrl, model: t.model, executable: true, limits: t.auth?.limits, injectedTokens: t.injectedTokens };
      const options = { body: { ...body, model: t.model, ...(stream ? { stream: true } : {}) }, headers: k ? { authorization: 'Bearer ' + k.secret } : {} };
      const url = t.baseUrl.replace(/\/$/, '') + path;
      try {
        if (stream) return { ok: true, value: await budget.run({ p, url, options, stream: true, send: sendStream(signal), extra }) };
        const r = await budget.run({ p, url, options, send: sendJson(signal), extra });
        return { ok: !!r.success, status: r.status ?? 'network', value: r };
      } catch (error) {
        if (controlErrors.test(error.message)) throw error;
        return { ok: false, status: statusOf(error) ?? 'network', error };
      }
    };
    if (fixedKey) {
      const t = targets[0], release = await acquire(t.id);
      try { const r = await perform(t, null); pool.report(t.id, fixedKey.kid, r.ok ? 'ok' : r.status ?? 'network'); registry.persistHealth?.(); return { ...r, target: t, kid: fixedKey.kid, attempts: 1 }; }
      finally { release(); }
    }
    return attempt(targets, perform);
  }

  // ---- Owner test buttons. Key tests read /models (no tokens); completion tests spend tokens and are metered. ----
  async function testKey(id, kid, { model } = {}) {
    const secret = registry.keySecret(id, kid); if (!secret) throw Object.assign(Error('KEY_NOT_FOUND'), { status: 404 });
    const base = registry.list().providers.find(p => p.id === id).baseUrl, t0 = now();
    let result;
    try { const ids = await fetchModels(base, secret); pool.report(id, kid, 'ok'); result = { kid, ok: true, latencyMs: now() - t0, models: ids.length }; }
    catch (error) { pool.report(id, kid, metaStatus(error.message)); result = { kid, ok: false, latencyMs: now() - t0, error: error.message }; }
    if (result.ok && model) result.completion = await testModel(id, model, { fixedKey: { kid, secret } });
    registry.persistHealth?.();
    return result;
  }
  async function testKeys(id) { return Promise.all(pool.view(id).keys.map(k => testKey(id, k.kid))); }
  // Tiny completion. If the provider reports more prompt tokens than Core's bound (hidden prompt text injected by a
  // router/gateway), it suggests a per-connection allowance; the Owner applies it (Control asks for confirmation).
  async function testModel(id, model, { fixedKey = null } = {}) {
    const t0 = now(), body = { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 };
    try {
      const targets = registry.targets(id, model);
      const r = await dispatch({ targets, body, extra: { source: 'provider-test' }, fixedKey });
      const usage = r.value?.data?.usage, t = targets[0];
      const tokens = usage ? { input: usage.prompt_tokens ?? null, output: usage.completion_tokens ?? null } : null;
      const bound = t ? byteInputBound({ ...body, model: t.model }, t) : null;
      const calibration = tokens?.input != null && bound != null && tokens.input > bound
        ? { promptTokens: tokens.input, bound, currentInjectedTokens: t.injectedTokens, suggestedInjectedTokens: Math.min(65536, Math.ceil((tokens.input - (bound - t.injectedTokens)) * 1.25 / 256) * 256) } : null;
      return { model, ok: r.ok, status: r.value?.status ?? r.status, latencyMs: now() - t0, spendsTokens: true, tokens, calibration,
        error: r.ok ? null : (r.error?.message || (typeof r.value?.data === 'object' ? r.value.data?.error?.message : null) || 'HTTP_' + r.status) };
    } catch (error) { return { model, ok: false, latencyMs: now() - t0, spendsTokens: true, tokens: null, calibration: null, error: error.message }; }
  }
  // The usage meter is created after installCanonical() (so it wraps this layer); it is attached here.
  const useBudget = b => { budget = b; };
  return { attempt, installCanonical, dispatch, testKey, testKeys, testModel, useBudget, concurrency, MAX_ATTEMPTS };
}
module.exports = { createProviderRouter, withTarget, upstreamRequest, MAX_ATTEMPTS };
