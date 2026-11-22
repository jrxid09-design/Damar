'use strict';
// Isolated Core provider registry: the Owner's provider connections, the models they offer (metadata only), what is
// selected, and whether the selection may execute. Nothing is built in and nothing is a default: a connection is
// user-defined { id, label, baseUrl, kind: 'openai-compatible' } plus an optional key, and a fresh install has none
// (onboarding: "Connect a provider"). Offline fixtures exist only in isolated tests (DAMAR_CORE_TEST_FIXTURES=1).
// A live connection dispatches only while an Owner model grant covers its id + base URL + model (model-grants.cjs).
// API keys live in Core memory; a key the Owner asks to remember is DPAPI-encrypted per connection id (key-store.cjs).
// URL policy: plain HTTP only to this machine (127.0.0.1, localhost, [::1]); HTTPS to any host; no credentials in the URL.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createKeyPool, validRouting, STRATEGIES, ROUTING_DEFAULTS, suffixOf } = require('./provider-keys.cjs');
const BASE_URL = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])|https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
// Connection ids: lowercase slug, no '--' (used by bulk-key ids `<id>--<kid>`), max 32; `combos` is the virtual combo provider.
const CONNECTION_ID = /^(?!combos$)[a-z0-9](?:[a-z0-9]|-(?!-)){0,31}$/;
const LABEL = /^[^\x00-\x1f\x7f]{1,64}$/;
const safeModel = v => typeof v === 'string' && /^[A-Za-z0-9._:\/@+-]{1,128}$/.test(v);
const DEFAULT_INJECTED_TOKENS = 4096, MAX_CONNECTIONS = 32, SCHEMA_VERSION = 2;
// Static list used only to prefill the "add connection" form; never connected automatically.
// Base URLs checked against each vendor's documentation on 2026-11-21. Unverified: LM Studio's port (1234 is the
// documented example, not a guaranteed default; the server reuses the last port used).
const PRESETS = Object.freeze([
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.ai/v1', keyRequired: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyRequired: true },
  { id: 'mistral', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', keyRequired: true },
  { id: 'gemini', label: 'Google Gemini (OpenAI-compatible)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true },
  { id: 'anthropic', label: 'Anthropic (OpenAI-compatible)', baseUrl: 'https://api.anthropic.com/v1', keyRequired: true },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', keyRequired: true },
  { id: 'ollama', label: 'Ollama (this computer)', baseUrl: 'http://127.0.0.1:11434/v1', keyRequired: false },
  { id: 'lmstudio', label: 'LM Studio (this computer)', baseUrl: 'http://127.0.0.1:1234/v1', keyRequired: false },
  { id: 'custom', label: 'Custom (any OpenAI-compatible endpoint)', baseUrl: '', keyRequired: false },
].map(Object.freeze));
const fail = (message, status) => { throw Object.assign(Error(message), { status }); };

async function fetchModels(baseUrl, apiKey) {
  let r;
  try { r = await fetch(baseUrl.replace(/\/$/, '') + '/models', { redirect: 'error', signal: AbortSignal.timeout(8000), headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} }); }
  catch (error) { fail(error.name === 'TimeoutError' ? 'PROVIDER_METADATA_TIMEOUT' : 'PROVIDER_UNREACHABLE', 424); }
  if (r.status === 401 || r.status === 403) fail('PROVIDER_AUTH_REQUIRED', 424);
  if (!r.ok) fail('PROVIDER_METADATA_HTTP_' + r.status, 424);
  const text = await r.text(); if (text.length > 1 << 20) fail('PROVIDER_METADATA_TOO_LARGE', 424);
  let body; try { body = JSON.parse(text); } catch { fail('PROVIDER_METADATA_INVALID', 424); }
  if (!Array.isArray(body?.data)) fail('PROVIDER_METADATA_INVALID', 424);
  const ids = [...new Set(body.data.slice(0, 512).map(m => m?.id).filter(safeModel))];
  // Endpoint-declared image input (`capabilities.vision`), used to enable the image bridge.
  ids.vision = new Set(body.data.slice(0, 512).filter(m => safeModel(m?.id) && m?.capabilities?.vision === true).map(m => m.id));
  return ids;
}

const validConnection = c => !!c && CONNECTION_ID.test(c.id) && !c.id.startsWith('offline-fixture-') && LABEL.test(c.label || '') &&
  typeof c.baseUrl === 'string' && BASE_URL.test(c.baseUrl) && Number.isSafeInteger(c.injectedTokens) && c.injectedTokens >= 0 && c.injectedTokens <= 65536;
const KID = /^[a-f0-9]{6}$/, COMBO_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
// Optional router fields, sanitized on load and on every write (invalid parts are dropped, never trusted).
const routerFields = c => ({
  strategy: STRATEGIES.includes(c.strategy) ? c.strategy : 'round-robin',
  ...(Number.isSafeInteger(c.maxConcurrency) && c.maxConcurrency >= 1 && c.maxConcurrency <= 256 ? { maxConcurrency: c.maxConcurrency } : {}),
  keys: (Array.isArray(c.keys) ? c.keys : []).filter(k => k && KID.test(k.kid)).slice(0, 256).map(k => ({ kid: k.kid, enabled: k.enabled !== false, addedAt: typeof k.addedAt === 'string' ? k.addedAt : null })),
  models: [...new Set((Array.isArray(c.models) ? c.models : []).filter(safeModel))].slice(0, 256),
  aliases: Object.fromEntries(Object.entries(c.aliases && typeof c.aliases === 'object' ? c.aliases : {}).filter(([a, m]) => safeModel(a) && safeModel(m)).slice(0, 64)),
});
const record = c => ({ id: c.id, label: c.label, baseUrl: c.baseUrl, kind: 'openai-compatible', injectedTokens: c.injectedTokens, ...routerFields(c) });
function validCombo(c) {
  if (!c || !COMBO_ID.test(c.id) || (c.label !== undefined && !LABEL.test(c.label)) || !['fallback', 'round-robin'].includes(c.strategy ?? 'fallback') ||
    !Array.isArray(c.targets) || !c.targets.length || c.targets.length > 8 || !c.targets.every(t => t && CONNECTION_ID.test(t.connection) && safeModel(t.model))) return null;
  return { id: c.id, label: c.label || c.id, strategy: c.strategy ?? 'fallback', targets: c.targets.map(t => ({ connection: t.connection, model: t.model })) };
}

const readJson = file => { try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; } };
function writeConnections(file, connections, extra = {}) {
  if (!file) return;
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...extra, connections: connections.map(record) }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) { throw Object.assign(Error('PROVIDER_ROUTE_STORE_FAILED'), { cause: error, status: 500 }); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
// Returns { connections, combos, routing, migration:null }. Pre-v2 state is converted once by the Owner-only script
// scripts/owner/migrate-legacy-providers.cjs (not shipped), never by the product.
function loadConnections(file) {
  const stored = readJson(file);
  if (stored?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(stored.connections)) return { connections: [], combos: [], routing: ROUTING_DEFAULTS, migration: null };
  const seen = new Set();
  let routing = ROUTING_DEFAULTS; try { routing = validRouting(stored.routing); } catch {}
  return { connections: stored.connections.map(c => ({ ...c, injectedTokens: c?.injectedTokens ?? DEFAULT_INJECTED_TOKENS }))
    .filter(c => validConnection(c) && !seen.has(c.id) && seen.add(c.id)).slice(0, MAX_CONNECTIONS).map(c => ({ ...c, ...routerFields(c) })),
    combos: (Array.isArray(stored.combos) ? stored.combos : []).map(validCombo).filter(Boolean).slice(0, 64), routing, migration: null };
}
// Sentinel base URL of the virtual `combos` provider: the canonical runtime is pointed here and the provider router
// (provider-router.cjs) maps each request to the combo's real targets. Port 9 (discard) is never actually dialled.
const COMBO_BASE = 'http://127.0.0.1:9/damar-combos/v1';

function createProviderRegistry({ fixtures = [], applyFixture, applyLive, keyStore = null, routeFile = null, modelGrants = null, now = Date.now }) {
  const entries = new Map();
  const liveLedger = [];
  for (const f of fixtures) entries.set(f.id, { id: f.id, label: 'Offline fixture ' + f.id.slice(-1).toUpperCase() + ' (deterministic, zero cost)', kind: 'offline-fixture', baseUrl: () => f.baseUrl(), executable: true, fixture: f, model: f.model });
  const keys = new Map();          // primary key per connection (the legacy single key; DPAPI id = connection id)
  const secrets = new Map();       // bulk keys: `${id}--${kid}` -> secret (DPAPI id = the same string)
  const modelCache = new Map();    // connection id -> last /models ids
  const addLive = c => { const e = { id: c.id, label: c.label, kind: 'live', url: c.baseUrl, baseUrl: () => e.url, injectedTokens: c.injectedTokens, executable: false, reason: 'LIVE_INFERENCE_NOT_AUTHORIZED', model: null, ledger: liveLedger,
    strategy: c.strategy || 'round-robin', maxConcurrency: c.maxConcurrency, keyMeta: c.keys || [], extraModels: c.models || [], aliases: c.aliases || {} }; entries.set(c.id, e); return e; };
  const loaded = loadConnections(routeFile);
  const healthFile = routeFile ? path.join(path.dirname(routeFile), 'provider-health.json') : null;
  const pool = createKeyPool({ now, routing: loaded.routing, health: readJson(healthFile) || {} });
  let combos = loaded.combos;
  const live = () => [...entries.values()].filter(e => e.kind === 'live' && !e.virtual);
  // Rebuild one connection's rotation pool: the primary key (if any) first, then enabled-or-not bulk keys.
  const syncPool = id => { const e = entries.get(id); if (!e || e.virtual) return;
    pool.set(id, [...(keys.has(id) ? [{ kid: 'primary', secret: keys.get(id), enabled: true }] : []),
      ...e.keyMeta.filter(k => secrets.has(id + '--' + k.kid)).map(k => ({ kid: k.kid, secret: secrets.get(id + '--' + k.kid), enabled: k.enabled }))], e.strategy); };
  for (const c of loaded.connections) {
    const e = addLive(c); const k = keyStore?.load(c.id); if (k) keys.set(c.id, k);
    for (const m of e.keyMeta) { const s = keyStore?.load(c.id + '--' + m.kid); if (s) secrets.set(c.id + '--' + m.kid, s); }
    syncPool(c.id);
  }
  const syncCombos = () => { if (combos.length && !entries.has('combos')) entries.set('combos', { id: 'combos', label: 'Combos (virtual models with fallback)', kind: 'live', virtual: true, url: COMBO_BASE, baseUrl: () => COMBO_BASE, injectedTokens: DEFAULT_INJECTED_TOKENS, executable: false, reason: 'LIVE_INFERENCE_NOT_AUTHORIZED', model: null, ledger: liveLedger });
    if (!combos.length) entries.delete('combos'); };
  syncCombos();
  const persist = (list = live()) => writeConnections(routeFile, list.map(e => ({ id: e.id, label: e.label, baseUrl: e.url, injectedTokens: e.injectedTokens, strategy: e.strategy, maxConcurrency: e.maxConcurrency, keys: e.keyMeta, models: e.extraModels, aliases: e.aliases })),
    { combos, routing: pool.routing() });
  let healthTimer = null;
  const persistHealth = () => { if (!healthFile || healthTimer) return; healthTimer = setTimeout(() => { healthTimer = null;
    try { const tmp = healthFile + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(pool.healthSnapshot()), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, healthFile); } catch {} }, 500); healthTimer.unref?.(); };
  const epoch = crypto.randomUUID();
  let revision = 0;
  const configurationVersion = () => epoch + ':' + revision + (modelGrants ? ':g' + modelGrants.view().revision : '');
  const resolveModel = (id, model) => entries.get(id)?.aliases?.[model] || model;
  const grantAuth = (id, url, model) => modelGrants?.authorization(id, url, resolveModel(id, model)) || null;
  // Combo targets that are connected and covered by their connection's grant, in combo order.
  const comboTargets = comboId => { const c = combos.find(x => x.id === comboId); if (!c) return [];
    return c.targets.map(t => { const ce = entries.get(t.connection); if (!ce || ce.virtual || ce.kind !== 'live') return null;
      const auth = grantAuth(t.connection, ce.baseUrl(), t.model); return auth ? { id: t.connection, baseUrl: ce.baseUrl(), model: resolveModel(t.connection, t.model), injectedTokens: ce.injectedTokens, auth } : null; }).filter(Boolean); };
  const authorization = (id, url, model) => {
    if (id !== 'combos') return grantAuth(id, url, model);
    const t = comboTargets(model); return t.length ? { revision: t.map(x => x.auth.revision).join('+'), limits: t[0].auth.limits } : null;
  };
  const executable = e => e.executable && (e.kind !== 'live' || !!authorization(e.id, e.baseUrl(), e.model) && e.grantRevision === authorization(e.id, e.baseUrl(), e.model).revision);
  let active = fixtures[0]?.id || live()[0]?.id || null;
  const modelCapabilities = new Map();
  const anyKey = id => keys.get(id) || entries.get(id)?.keyMeta?.filter(k => k.enabled).map(k => secrets.get(id + '--' + k.kid)).find(Boolean) || null;
  const hasAnyKey = id => keys.has(id) || !!entries.get(id)?.keyMeta?.some(k => secrets.has(id + '--' + k.kid));
  // Metadata with an explicit key, or (key undefined) with the connection's keys in order until one is accepted.
  const fetchFor = async (id, url, key) => {
    const candidates = key !== undefined ? [key] : [keys.get(id), ...(entries.get(id)?.keyMeta || []).filter(k => k.enabled).map(k => secrets.get(id + '--' + k.kid))].filter(Boolean);
    let ids, last;
    for (const k of candidates.length ? candidates : [null]) { try { ids = await fetchModels(url, k); break; } catch (e) { if (e.message !== 'PROVIDER_AUTH_REQUIRED') throw e; last = e; } }
    if (!ids) throw last; modelCache.set(id, [...ids]); return ids; };
  // Selectable model ids of a connection: its /models list + Owner-added models + aliases (combos: the combo ids).
  const withCatalog = (e, ids) => { if (e.virtual) { const out = combos.map(c => c.id); out.vision = new Set(); return out; }
    const out = [...new Set([...ids, ...e.extraModels, ...Object.keys(e.aliases)])]; out.vision = ids.vision || new Set(); return out; };
  // The connection's current grant ('*' = every model it offers); a grant for an old base URL or past expiry needs renewal.
  const grantOf = e => (e.kind === 'live' && !e.virtual && modelGrants?.view().grants?.find(g => g.provider === e.id)) || null;
  const view = e => { const g = grantOf(e), granted = e.virtual ? combos.some(c => comboTargets(c.id).length) : !!g && g.effective && g.baseUrl === e.baseUrl();
    return { id: e.id, label: e.label, kind: e.kind, ...(e.kind === 'live' ? { protocol: 'openai-compatible', injectedTokens: e.injectedTokens } : {}), ...(e.virtual ? { virtual: true } : {}), configurationVersion: configurationVersion(),
      baseUrl: e.baseUrl(), configured: !!e.baseUrl(), executable: executable(e),
      authorizedModels: e.virtual ? combos.filter(c => comboTargets(c.id).length).map(c => c.id) : granted ? [g.model] : [],
      grant: !e.virtual && granted ? { model: g.model, expiresAt: g.expiresAt } : null, grantStatus: e.kind !== 'live' ? 'not-required' : granted ? 'granted' : g ? 'needs-new-grant' : 'none',
      reason: executable(e) ? null : e.reason || 'LIVE_MODEL_NOT_AUTHORIZED', hasKey: hasAnyKey(e.id), keyRemembered: !!keyStore?.has(e.id), model: e.model,
      ...(e.kind === 'live' && !e.virtual ? { strategy: e.strategy, maxConcurrency: e.maxConcurrency || pool.routing().maxConcurrency, keys: pool.view(e.id).keys.map(({ kid, suffix, enabled, status, health }) => ({ kid, suffix, enabled, status, lastOk: health.lastOk, lastError: health.lastError, cooldownUntil: health.cooldownUntil || null })),
        extraModels: [...e.extraModels], aliases: { ...e.aliases } } : {}),
      capabilities: { imageInput: modelCapabilities.get(`${e.id}/${e.model}`) || 'unverified' } }; };
  const get = id => { const e = entries.get(id); if (!e) fail('UNKNOWN_PROVIDER', 400); return e; };
  const getLive = id => { const e = get(id); if (e.kind !== 'live' || e.virtual) fail('FIXTURE_HAS_NO_CREDENTIAL', 400); return e; };
  const checkVersion = v => { if (v !== undefined && v !== configurationVersion()) fail('PROVIDER_CONFIGURATION_CHANGED', 409); };
  const changed = () => { revision++; persist(); };
  const NONE = () => ({ id: null, baseUrl: null, model: null, executable: false, limits: undefined, reason: 'NO_PROVIDER_CONNECTED', kind: 'none', ledger: liveLedger, injectedTokens: DEFAULT_INJECTED_TOKENS, capabilities: { imageInput: 'unverified' } });
  const validKey = k => typeof k === 'string' && k.length > 0 && k.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(k);
  let rr = 0;
  return {
    migration: loaded.migration,
    pool, persistHealth, resolveModel, comboTargets, COMBO_BASE,
    list: () => { const selected = entries.get(active); return { active, configurationVersion: configurationVersion(), providers: [...entries.values()].map(view), presets: PRESETS,
      combos: combos.map(c => ({ ...c, available: comboTargets(c.id).map(t => t.id + '/' + t.model) })), routing: pool.routing(),
      onboarding: entries.size ? null : 'CONNECT_A_PROVIDER', liveInferenceAuthorized: selected?.kind === 'live' && executable(selected) === true }; },
    active: () => { const e = entries.get(active); if (!e) return NONE();
      return { id: e.id, baseUrl: e.baseUrl(), model: e.model, executable: executable(e), limits: authorization(e.id, e.baseUrl(), e.model)?.limits, reason: executable(e) ? null : e.reason || 'LIVE_MODEL_NOT_AUTHORIZED', kind: e.kind, ...(e.virtual ? { virtual: true } : {}), ledger: e.fixture?.ledger || e.ledger || [], injectedTokens: e.injectedTokens ?? DEFAULT_INJECTED_TOKENS, capabilities: { imageInput: modelCapabilities.get(`${e.id}/${e.model}`) || 'unverified' } }; },
    // Routing targets for one selection: a connection (+ alias resolution) or a combo (fallback order; round-robin
    // combos rotate the starting target). Only grant-covered targets are returned.
    targets(id, model) {
      if (id === 'combos') { const t = comboTargets(model), c = combos.find(x => x.id === model);
        if (c?.strategy === 'round-robin' && t.length > 1) { const s = rr++ % t.length; return [...t.slice(s), ...t.slice(0, s)]; } return t; }
      const e = entries.get(id); if (!e || e.kind !== 'live' || e.virtual) return [];
      const auth = grantAuth(id, e.baseUrl(), model); return auth ? [{ id, baseUrl: e.baseUrl(), model: resolveModel(id, model), injectedTokens: e.injectedTokens, auth }] : [];
    },
    // Gateway catalog: `<connection>/<model>` for every grant-covered model of every connection, plus combos.
    catalog() {
      const out = [];
      for (const e of live()) for (const m of withCatalog(e, modelCache.get(e.id) || [])) if (grantAuth(e.id, e.baseUrl(), m)) out.push({ id: e.id + '/' + m, owned_by: e.id, connection: e.id, model: m });
      for (const c of combos) if (comboTargets(c.id).length) out.push({ id: c.id, owned_by: 'combos', connection: 'combos', model: c.id });
      return out;
    },
    // Pandawa team hook (pandawa-team.cjs): dispatch target for one connection + model; a live one is executable only
    // under an Owner model grant for that id + base URL + model. The key never leaves Core.
    // Combos resolve to their first grant-covered target; aliases resolve to the real model (use `model` from here);
    // the key comes from the connection's rotation pool (healthy, enabled keys first).
    target: (id, model) => {
      if (id === 'combos') { const t = comboTargets(model)[0]; if (!t) return null; return { id: t.id, kind: 'live', baseUrl: t.baseUrl, apiKey: pool.pick(t.id)?.secret || anyKey(t.id), model: t.model, executable: true, ledger: liveLedger, via: 'combos/' + model }; }
      const e = entries.get(id); if (!e || !e.baseUrl() || !safeModel(model) || e.virtual) return null;
      return { id, kind: e.kind, baseUrl: e.baseUrl(), apiKey: e.kind === 'live' ? pool.pick(id)?.secret || anyKey(id) : null, model: resolveModel(id, model), executable: e.kind !== 'live' || !!authorization(id, e.baseUrl(), model), ledger: e.fixture?.ledger || e.ledger }; },
    async models(id) { const e = get(id); if (!e.baseUrl()) fail('PROVIDER_NOT_CONNECTED', 409); if (e.virtual || e.kind !== 'live') return e.virtual ? withCatalog(e, []) : fetchModels(e.baseUrl(), null);
      return withCatalog(e, await fetchFor(id, e.baseUrl())); },
    // Add a connection (unknown id + baseUrl) or change one (label, URL, key, allowance). The URL's /models metadata is
    // fetched before anything is accepted; nothing is changed on failure.
    async connect(id, { label, baseUrl, apiKey, remember, model, expectedVersion, injectedTokens } = {}) {
      checkVersion(expectedVersion);
      if (typeof id !== 'string' || !CONNECTION_ID.test(id)) fail('CONNECTION_ID_INVALID', 400);
      const existing = entries.get(id);
      if (existing?.kind === 'offline-fixture' || (!existing && id.startsWith('offline-fixture-'))) fail('FIXTURE_NEEDS_NO_CONNECTION', 400);
      if (!existing && baseUrl === undefined) fail('PROVIDER_URL_REQUIRED', 400);
      if (!existing && live().length >= MAX_CONNECTIONS) fail('TOO_MANY_CONNECTIONS', 409);
      if (label !== undefined && (typeof label !== 'string' || !LABEL.test(label.trim()))) fail('CONNECTION_LABEL_INVALID', 400);
      if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !BASE_URL.test(baseUrl))) fail('PROVIDER_URL_NOT_ALLOWED', 400);
      if (injectedTokens !== undefined && (!Number.isSafeInteger(injectedTokens) || injectedTokens < 0 || injectedTokens > 65536)) fail('INJECTED_TOKENS_INVALID', 400);
      const url = baseUrl ?? existing.baseUrl();
      if (model !== undefined && !authorization(id, url, model)) fail('LIVE_MODEL_NOT_AUTHORIZED', 403);
      if (apiKey !== undefined && !validKey(apiKey)) fail('INVALID_API_KEY_FORMAT', 400);
      if (remember !== undefined && typeof remember !== 'boolean') fail('CONNECT_REQUEST_INVALID', 400);
      // Rename / allowance changes on an existing connection touch no endpoint (no /models fetch).
      const metadataOnly = !!existing && baseUrl === undefined && apiKey === undefined && model === undefined && remember === undefined;
      const models = metadataOnly ? null : withCatalog(existing || { extraModels: [], aliases: {} }, await fetchFor(id, url, apiKey));
      checkVersion(expectedVersion);
      if (model !== undefined && !authorization(id, url, model)) fail('LIVE_MODEL_NOT_AUTHORIZED', 403);
      if (model !== undefined && !models.includes(model)) fail('MODEL_NOT_OFFERED_BY_PROVIDER', 409);
      if (remember === true && !(apiKey ?? keys.get(id))) fail('NO_KEY_TO_REMEMBER', 400);
      if (remember === true && !keyStore) fail('KEY_STORE_UNAVAILABLE', 503);
      if (!existing && entries.has(id)) fail('PROVIDER_CONFIGURATION_CHANGED', 409);
      const nextLabel = label !== undefined ? label.trim() : existing?.label || PRESETS.find(p => p.id === id)?.label || id;
      const nextTokens = injectedTokens ?? existing?.injectedTokens ?? DEFAULT_INJECTED_TOKENS;
      const pending = existing ? { ...existing, label: nextLabel, url, injectedTokens: nextTokens } : { id, label: nextLabel, url, injectedTokens: nextTokens, strategy: 'round-robin', keyMeta: [], extraModels: [], aliases: {} };
      persist([...live().filter(e => e.id !== id), pending]);
      revision++;
      const e = existing || addLive({ id, label: nextLabel, baseUrl: url, injectedTokens: nextTokens });
      Object.assign(e, { label: nextLabel, url, injectedTokens: nextTokens });
      // Remember (DPAPI) before the key is used, so a failed save changes nothing; remember:false forgets it.
      if (remember === true) keyStore.save(id, apiKey ?? keys.get(id));
      if (remember === false) keyStore?.forget(id);
      if (apiKey !== undefined) keys.set(id, apiKey);
      syncPool(id);
      if (!active) active = id;
      return { ...view(e), models: models ? models.length : null };
    },
    async revoke(id) {
      const e = getLive(id);
      revision++;
      keyStore?.forget(id); keys.delete(id); syncPool(id); e.executable = false; e.reason = 'CREDENTIAL_REVOKED';
      if (active === id && typeof applyLive === 'function') await applyLive({ id, baseUrl: e.baseUrl(), apiKey: null, model: e.model, revoked: true });
      return view(e);
    },
    // Delete a connection, its remembered keys and its model grant.
    async remove(id, expectedVersion) {
      checkVersion(expectedVersion);
      const e = getLive(id);
      // The connection's grant goes with it (journaled first; a failed revoke changes nothing).
      if (modelGrants?.view().grants?.some(g => g.provider === id)) modelGrants.revoke('owner-remove-connection', id);
      persist(live().filter(x => x.id !== id));
      revision++;
      keyStore?.forget(id); keys.delete(id); for (const k of e.keyMeta) { keyStore?.forget(id + '--' + k.kid); secrets.delete(id + '--' + k.kid); }
      pool.drop(id); entries.delete(id); e.executable = false;
      if (active === id) {
        active = fixtures[0]?.id || null;
        if (typeof applyLive === 'function') await applyLive({ id, baseUrl: e.baseUrl(), apiKey: null, model: null, revoked: true });
      }
      return { removed: id, active };
    },
    // ---- router-grade key management (secrets are write-only; views carry a masked suffix and health) ----
    addKeys(id, text) {
      const e = getLive(id);
      if (typeof text !== 'string' || text.length > 256 * 600) fail('KEY_IMPORT_INVALID', 400);
      if (!keyStore) fail('KEY_STORE_UNAVAILABLE', 503);
      const known = new Set([keys.get(id), ...e.keyMeta.map(k => secrets.get(id + '--' + k.kid))].filter(Boolean));
      const added = [], result = { added, duplicates: 0, invalid: 0 };
      for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
        if (!validKey(line)) { result.invalid++; continue; }
        if (known.has(line)) { result.duplicates++; continue; }
        if (e.keyMeta.length >= 256) fail('TOO_MANY_KEYS', 409);
        let kid; do kid = crypto.randomBytes(3).toString('hex'); while (e.keyMeta.some(k => k.kid === kid) || kid === 'primary');
        keyStore.save(id + '--' + kid, line); secrets.set(id + '--' + kid, line); known.add(line);
        e.keyMeta.push({ kid, enabled: true, addedAt: new Date(now()).toISOString() }); added.push({ kid, suffix: suffixOf(line) });
      }
      changed(); syncPool(id);
      return result;
    },
    setKey(id, kid, { enabled }) {
      const e = getLive(id), k = e.keyMeta.find(x => x.kid === kid);
      if (!k || typeof enabled !== 'boolean') fail('KEY_NOT_FOUND', 404);
      k.enabled = enabled; changed(); syncPool(id); return pool.view(id);
    },
    deleteKey(id, kid) {
      const e = getLive(id);
      if (kid === 'primary') { keyStore?.forget(id); keys.delete(id); revision++; syncPool(id); return pool.view(id); }
      if (!e.keyMeta.some(x => x.kid === kid)) fail('KEY_NOT_FOUND', 404);
      e.keyMeta = e.keyMeta.filter(x => x.kid !== kid); keyStore?.forget(id + '--' + kid); secrets.delete(id + '--' + kid);
      changed(); syncPool(id); return pool.view(id);
    },
    setStrategy(id, strategy) { const e = getLive(id); if (!STRATEGIES.includes(strategy)) fail('KEY_STRATEGY_INVALID', 400); e.strategy = strategy; changed(); syncPool(id); return pool.view(id); },
    setRouting(v) { const r = pool.setRouting({ ...pool.routing(), ...v }); changed(); return r; },
    // Per-connection max in-flight requests (the router queues the rest); null = the routing default.
    setLimits(id, { maxConcurrency }) { const e = getLive(id);
      if (maxConcurrency !== null && (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 256)) fail('CONCURRENCY_INVALID', 400);
      e.maxConcurrency = maxConcurrency ?? undefined; changed(); return { maxConcurrency: e.maxConcurrency || pool.routing().maxConcurrency }; },
    limitsOf: id => { const e = entries.get(id); return { maxConcurrency: e?.maxConcurrency || pool.routing().maxConcurrency }; },
    // The secret for one key, for Core-internal tests only (never returned by any route).
    keySecret(id, kid) { getLive(id); return kid === 'primary' ? keys.get(id) || null : secrets.get(id + '--' + kid) || null; },
    // ---- catalog: Owner-added models and aliases ----
    editCatalog(id, { addModel, removeModel, alias, removeAlias } = {}) {
      const e = getLive(id);
      if (addModel !== undefined) { if (!safeModel(addModel)) fail('MODEL_ID_INVALID', 400); if (!e.extraModels.includes(addModel)) e.extraModels.push(addModel); }
      if (removeModel !== undefined) e.extraModels = e.extraModels.filter(m => m !== removeModel);
      if (alias !== undefined) { if (!alias || !safeModel(alias.name) || !safeModel(alias.model) || alias.name === alias.model) fail('MODEL_ALIAS_INVALID', 400); e.aliases[alias.name] = alias.model; }
      if (removeAlias !== undefined) delete e.aliases[removeAlias];
      changed(); return { extraModels: [...e.extraModels], aliases: { ...e.aliases } };
    },
    // ---- combos: named virtual models over (connection, model) targets ----
    setCombo(input) {
      const c = validCombo(input); if (!c) fail('COMBO_INVALID', 400);
      if (!combos.some(x => x.id === c.id) && combos.length >= 64) fail('TOO_MANY_COMBOS', 409);
      combos = [...combos.filter(x => x.id !== c.id), c]; syncCombos(); changed(); return c;
    },
    deleteCombo(comboId) {
      if (!combos.some(x => x.id === comboId)) fail('COMBO_NOT_FOUND', 404);
      combos = combos.filter(x => x.id !== comboId); syncCombos(); changed();
      if (active === 'combos' && !entries.has('combos')) active = fixtures[0]?.id || live()[0]?.id || null;
      return { removed: comboId };
    },
    // Select provider + model. The model must exist in the provider's live metadata (or catalog / combos).
    async select(id, model, expectedVersion) {
      checkVersion(expectedVersion);
      const e = get(id);
      if (!e.baseUrl()) fail('PROVIDER_NOT_CONNECTED', 409);
      // Remote (https) endpoints need a key; local http endpoints (Ollama, LM Studio) may run without one.
      if (e.kind === 'live' && !e.virtual && typeof applyLive === 'function' && !hasAnyKey(id) && !/^http:\/\//.test(e.baseUrl())) fail('PROVIDER_AUTH_REQUIRED', 409);
      const models = e.virtual ? withCatalog(e, []) : e.kind === 'live' ? withCatalog(e, await fetchFor(id, e.baseUrl())) : await fetchModels(e.baseUrl(), null);
      // Live models are never inferred from list order. Requiring an explicit metadata-backed id
      // prevents a credential Apply from silently authorizing whichever model the endpoint lists first.
      const chosen = model ?? (e.kind === 'live' ? null : (models.includes(e.model) ? e.model : models[0]));
      if (e.kind === 'live' && !chosen) fail('LIVE_MODEL_SELECTION_REQUIRED', 409);
      checkVersion(expectedVersion);
      const grant = e.kind === 'live' ? authorization(id, e.baseUrl(), chosen) : null;
      if (e.kind === 'live' && !grant) fail('LIVE_MODEL_NOT_AUTHORIZED', 403);
      if (!chosen || !models.includes(chosen)) fail('MODEL_NOT_OFFERED_BY_PROVIDER', 409);
      revision++;
      if (e.kind === 'offline-fixture') await applyFixture(e.fixture, chosen);
      else if (typeof applyLive === 'function') {
        await applyLive({ id, baseUrl: e.baseUrl(), apiKey: e.virtual ? null : anyKey(id), model: chosen });
        // Only a model covered by the connection's current grant may cross the dispatch boundary.
        e.grantRevision = grant.revision;
        e.executable = !!authorization(id, e.baseUrl(), chosen) && grant.revision === authorization(id, e.baseUrl(), chosen).revision;
        e.reason = e.executable ? null : 'LIVE_INFERENCE_NOT_AUTHORIZED';
      }
      e.model = chosen; active = id;
      if (models.vision?.has(chosen)) modelCapabilities.set(`${id}/${chosen}`, 'verified');
      return view(e);
    },
  };
}
module.exports = { createProviderRegistry, fetchModels, loadConnections, writeConnections, validConnection, validCombo, BASE_URL, CONNECTION_ID, PRESETS, DEFAULT_INJECTED_TOKENS, COMBO_BASE };
