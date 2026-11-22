'use strict';
// DAMAR gateway: an OpenAI-compatible upstream for other agents and harnesses (opencode, Hermes, any client with a
// custom OpenAI base URL). Separate listener (default 127.0.0.1:29631) that serves ONLY /v1/*: the R9 admin API and
// Owner/requester tokens are unreachable through it, and a gateway key is not an R9 credential (the R9 handler only
// knows the Owner/requester tokens), so the two authorities never mix. An optional LAN bind affects only this port.
// Keys are DAMAR-issued, shown once, stored as SHA-256; per-key allowed models/combos, usage and optional limits.
// Every upstream call goes through the provider router (keys, cooldown, combos, grants) and the shared usage meter.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, bind: '127.0.0.1', port: 29631 });
const PATHS = Object.freeze({ '/v1/chat/completions': '/chat/completions', '/v1/completions': '/completions', '/v1/embeddings': '/embeddings' });
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const bad = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const LABEL = /^[^\x00-\x1f\x7f]{1,64}$/, MODEL = /^(\*|[A-Za-z0-9._:\/@+-]{1,160})$/;
function validSettings(v) {
  const s = { ...DEFAULT_SETTINGS, ...v };
  if (typeof s.enabled !== 'boolean' || !['127.0.0.1', '0.0.0.0'].includes(s.bind) || !Number.isInteger(s.port) || s.port < 1024 || s.port > 65535) bad('GATEWAY_SETTINGS_INVALID');
  return { enabled: s.enabled, bind: s.bind, port: s.port };
}
function validLimits(l = {}) {
  if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).some(k => !['requests', 'totalTokens', 'concurrency'].includes(k)) || !Object.values(l).every(v => Number.isSafeInteger(v) && v > 0) || (l.concurrency ?? 1) > 256) bad('GATEWAY_KEY_LIMITS_INVALID');
  return { ...l };
}
function validModels(m = ['*']) { if (!Array.isArray(m) || !m.length || m.length > 64 || !m.every(x => typeof x === 'string' && MODEL.test(x))) bad('GATEWAY_KEY_MODELS_INVALID'); return [...new Set(m)]; }

function createGateway({ file, registry, router, budget, now = Date.now }) {
  let state = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, keys: [] };
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (v?.schemaVersion === 1) state = { schemaVersion: 1, settings: validSettings(v.settings), keys: Array.isArray(v.keys) ? v.keys.filter(k => k && /^[a-f0-9]{64}$/.test(k.hash)) : [] }; } catch {}
  const save = () => { const tmp = file + '.' + crypto.randomUUID() + '.tmp'; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); };
  let server = null, listening = null;
  // Per gateway key in-flight requests (default 8, `limits.concurrency`); over the cap -> 429 so clients back off.
  const active = new Map(), DEFAULT_KEY_CONCURRENCY = 8;
  const meta = k => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt, revokedAt: k.revokedAt || null, models: [...k.models], limits: { ...k.limits }, usage: { ...k.usage } });
  const byToken = token => { if (!token) return null; const h = sha(token); return state.keys.find(k => !k.revokedAt && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(h))) || null; };
  const allowed = (k, model) => k.models.includes('*') || k.models.includes(model);
  // `combo-id`, or `<connection>/<model>`: grant-covered routing targets (empty when unknown or not granted).
  const targetsFor = model => { const combo = registry.list().combos?.some(c => c.id === model); if (combo) return registry.targets('combos', model);
    const i = model.indexOf('/'); return i > 0 ? registry.targets(model.slice(0, i), model.slice(i + 1)) : []; };
  const oaiError = (res, status, message, code, type = status === 401 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error') => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { message, type, code } }));
  };
  const statusFor = m => /BUDGET_EXHAUSTED/.test(m) ? 429 : /NOT_AUTHORIZED/.test(m) ? 403 : /BOUND_REQUIRED|REQUEST_INVALID|MISMATCH/.test(m) ? 400 : 503;
  async function readBody(req, max = 16 << 20) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) bad('BODY_TOO_LARGE', 413); chunks.push(c); }
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { bad('INVALID_JSON'); }
  }
  function record(k, requestId) {
    const rows = (budget?.ledger || []).filter(r => r.gatewayRequest === requestId);
    k.usage.requests++; k.usage.lastUsed = new Date(now()).toISOString();
    for (const r of rows) { k.usage.inputTokens += r.promptTokens || 0; k.usage.outputTokens += r.completionTokens || 0; }
    try { save(); } catch {}
  }
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://gateway');
    if (!url.pathname.startsWith('/v1/')) return oaiError(res, 404, 'Not found. The DAMAR gateway serves /v1/* only.', 'not_found');
    const h = req.headers.authorization || '', k = byToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
    if (!k) return oaiError(res, 401, 'Invalid or missing DAMAR gateway key.', 'invalid_api_key');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const data = registry.catalog().filter(m => allowed(k, m.id)).map(m => ({ id: m.id, object: 'model', created: 0, owned_by: m.owned_by }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ object: 'list', data }));
      }
      const upstreamPath = PATHS[url.pathname];
      if (req.method !== 'POST' || !upstreamPath) return oaiError(res, 404, 'Unsupported endpoint.', 'not_found');
      const body = await readBody(req);
      if (typeof body.model !== 'string' || !MODEL.test(body.model) || body.model === '*') return oaiError(res, 400, 'A model is required.', 'model_required');
      if (!allowed(k, body.model)) return oaiError(res, 403, 'This gateway key may not use that model.', 'model_not_allowed');
      if (k.limits.requests && k.usage.requests >= k.limits.requests) return oaiError(res, 429, 'Gateway key request limit reached.', 'key_limit_reached');
      if (k.limits.totalTokens && k.usage.inputTokens + k.usage.outputTokens >= k.limits.totalTokens) return oaiError(res, 429, 'Gateway key token limit reached.', 'key_limit_reached');
      const cap = k.limits.concurrency || DEFAULT_KEY_CONCURRENCY;
      if ((active.get(k.id) || 0) >= cap) return oaiError(res, 429, `Gateway key concurrency limit (${cap}) reached; retry shortly.`, 'concurrency_limit_reached');
      active.set(k.id, (active.get(k.id) || 0) + 1); res.once('close', () => active.set(k.id, Math.max(0, (active.get(k.id) || 1) - 1)));
      const targets = targetsFor(body.model);
      if (!targets.length) return oaiError(res, 404, 'Unknown model, or no Owner model grant covers it.', 'model_not_found');
      const stream = body.stream === true && upstreamPath !== '/embeddings';
      // The usage meter needs provider-reported usage on streams too.
      const sent = stream ? { ...body, stream_options: { ...(body.stream_options || {}), include_usage: true } } : body;
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const requestId = crypto.randomUUID();
      let r;
      try { r = await router.dispatch({ targets, path: upstreamPath, body: sent, stream, extra: { source: 'gateway', gatewayKey: k.id, gatewayRequest: requestId }, signal: controller.signal }); }
      catch (error) { record(k, requestId); return oaiError(res, error.status || statusFor(error.message), error.message, error.message); }
      if (!r.ok) {
        record(k, requestId);
        const status = r.value?.status || (r.status === 'network' ? 502 : Number(r.status) || 502);
        const upstream = r.value?.data && typeof r.value.data === 'object' ? r.value.data : null;
        if (upstream?.error) { res.writeHead(status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(upstream)); }
        return oaiError(res, status, r.error?.message || 'Upstream refused the request.', 'upstream_error');
      }
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-damar-upstream': r.target.id });
        // Clients (opencode and others) expect the SSE terminator: append `data: [DONE]` when the upstream omits it.
        let tail = '', complete = false; const dec = new TextDecoder();
        try { for await (const chunk of r.value) { tail = (tail + dec.decode(chunk, { stream: true })).slice(-64); if (!res.write(chunk)) await new Promise(ok => res.once('drain', ok)); } complete = true; }
        catch { /* upstream ended the stream early; no terminator is invented for a broken stream */ }
        finally { if (complete && !/data:\s*\[DONE\]\s*$/.test(tail)) res.write((/\n\n$/.test(tail) || !tail ? '' : '\n\n') + 'data: [DONE]\n\n'); res.end(); record(k, requestId); }
        return;
      }
      record(k, requestId);
      res.writeHead(r.value.status || 200, { 'content-type': 'application/json', 'x-damar-upstream': r.target.id });
      return res.end(typeof r.value.data === 'string' ? r.value.data : JSON.stringify(r.value.data));
    } catch (error) { return oaiError(res, error.status || 500, error.message, error.message); }
  }
  async function stop() { if (!server) return; const s = server; server = null; listening = null; await new Promise(ok => s.close(() => ok())); s.closeAllConnections?.(); }
  async function start() {
    await stop();
    if (!state.settings.enabled) return null;
    const s = http.createServer((req, res) => { handle(req, res).catch(() => oaiError(res, 500, 'Gateway error.', 'internal')); });
    await new Promise((ok, fail) => { s.once('error', fail); s.listen(state.settings.port, state.settings.bind, ok); });
    server = s; listening = { address: state.settings.bind, port: s.address().port }; return listening;
  }
  function snippets(model) {
    const port = listening?.port || state.settings.port, host = state.settings.bind === '0.0.0.0' ? '<this-pc-lan-ip>' : '127.0.0.1';
    const base = `http://${host}:${port}/v1`, m = model || registry.catalog()[0]?.id || '<model-id>';
    return { baseUrl: base, model: m,
      opencode: JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { damar: { npm: '@ai-sdk/openai-compatible', name: 'DAMAR', options: { baseURL: base, apiKey: '{env:DAMAR_API_KEY}' }, models: { [m]: { name: m } } } }, model: 'damar/' + m }, null, 2),
      // Hermes Agent: ~/.hermes/config.yaml (or $HERMES_HOME/config.yaml), provider "custom" = any OpenAI-compatible endpoint.
      hermes: `# ~/.hermes/config.yaml  (Hermes Agent)\nmodel:\n  default: "${m}"\n  provider: "custom"\n  base_url: "${base}"\n  api_key: "<your DAMAR gateway key>"`,
      continue: `# ~/.continue/config.yaml  (Continue.dev)\nmodels:\n  - name: DAMAR ${m}\n    provider: openai\n    model: ${m}\n    apiBase: ${base}\n    apiKey: <your DAMAR gateway key>`,
      cline: `Cline / Roo Code: Settings > API Provider: "OpenAI Compatible"\nBase URL: ${base}\nAPI Key: <your DAMAR gateway key>\nModel ID: ${m}`,
      aider: `aider --openai-api-base ${base} --openai-api-key <your DAMAR gateway key> --model openai/${m}`,
      librechat: `# librechat.yaml\nendpoints:\n  custom:\n    - name: "DAMAR"\n      apiKey: "\${DAMAR_API_KEY}"\n      baseURL: "${base}"\n      models:\n        default: ["${m}"]\n        fetch: true\n      titleConvo: true\n      modelDisplayLabel: "DAMAR"`,
      openwebui: `Open WebUI: Admin Settings > Connections > OpenAI API > +\nURL: ${base}\nKey: <your DAMAR gateway key>\n# or environment: OPENAI_API_BASE_URL=${base}  OPENAI_API_KEY=<your DAMAR gateway key>${host === '127.0.0.1' ? '\n# Open WebUI in Docker: use http://host.docker.internal:' + port + '/v1 and turn on LAN mode' : ''}`,
      generic: `curl ${base}/chat/completions -H "Authorization: Bearer $DAMAR_API_KEY" -H "Content-Type: application/json" -d '{"model":"${m}","messages":[{"role":"user","content":"hi"}]}'` };
  }
  const admin = {
    view: () => ({ settings: { ...state.settings }, listening, keys: state.keys.map(meta), snippets: snippets() }),
    async setSettings(v) { const next = validSettings({ ...state.settings, ...v }); const prev = state.settings; state.settings = next;
      try { await start(); } catch (error) { state.settings = prev; await start().catch(() => {}); bad('GATEWAY_BIND_FAILED', 409); } save(); return admin.view(); },
    createKey({ label, models, limits } = {}) {
      if (typeof label !== 'string' || !LABEL.test(label.trim())) bad('GATEWAY_KEY_LABEL_INVALID');
      if (state.keys.filter(k => !k.revokedAt).length >= 64) bad('TOO_MANY_GATEWAY_KEYS', 409);
      const key = 'dmr-' + crypto.randomBytes(32).toString('base64url');
      const k = { id: crypto.randomBytes(4).toString('hex'), label: label.trim(), hash: sha(key), prefix: key.slice(0, 8) + '…' + key.slice(-4), createdAt: new Date(now()).toISOString(), revokedAt: null,
        models: validModels(models), limits: validLimits(limits), usage: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsed: null } };
      state.keys.push(k); save();
      return { ...meta(k), key, shownOnce: true };
    },
    updateKey(id, { label, models, limits } = {}) {
      const k = state.keys.find(x => x.id === id && !x.revokedAt); if (!k) bad('GATEWAY_KEY_NOT_FOUND', 404);
      if (label !== undefined) { if (typeof label !== 'string' || !LABEL.test(label.trim())) bad('GATEWAY_KEY_LABEL_INVALID'); k.label = label.trim(); }
      if (models !== undefined) k.models = validModels(models);
      if (limits !== undefined) k.limits = validLimits(limits);
      save(); return meta(k);
    },
    revokeKey(id) { const k = state.keys.find(x => x.id === id && !x.revokedAt); if (!k) bad('GATEWAY_KEY_NOT_FOUND', 404); k.revokedAt = new Date(now()).toISOString(); save(); return meta(k); },
  };
  return { handle, start, stop, admin, snippets, address: () => listening };
}
module.exports = { createGateway, DEFAULT_SETTINGS };
