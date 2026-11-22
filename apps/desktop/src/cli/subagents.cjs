'use strict';
// CLI side of the Core Pandawa run + provider/model contract. Core owns lifecycle, receipts, provider state and
// authority; the CLI holds a durable dispatch record (uncertain POST -> reconcile by readback, never replay) and
// reports successful provider/model selections for the private profile (`persist`).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const STATES = new Set(['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN']);
const DEFINITIVE = new Set([400, 401, 403, 404, 409, 413, 415, 424, 429]);
const safe = (v, n) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ').slice(0, n) : null;
const code = v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : null;
// Beginner-facing next steps for Core refusals. Text only; never changes behaviour.
// Client pre-check mirroring Core's model grant: '*' authorizes every model, otherwise the granted id.
// No list from Core means no pre-check; Core still decides.
const modelAuthorized = (row, model) => { const list = row && Array.isArray(row.authorizedModels) ? row.authorizedModels : null;
  if (!list || !model) return true;
  return list.some(m => m === '*' || m === model); };
const HINTS = Object.freeze({
  LIVE_INFERENCE_NOT_AUTHORIZED: 'This connection has no model grant yet. Allow it with: provider allow <provider-id> (every model, 30 days), or in DAMAR Control > Providers > Grant',
  LIVE_MODEL_NOT_AUTHORIZED: 'No model grant covers this model. Allow it with: provider allow <provider-id>, or in DAMAR Control > Providers > Grant',
  PROVIDER_NOT_CONNECTED: 'Connect a provider first: connect <name-or-preset> [base-url] [--key-env VARIABLE], e.g. connect openai --key-env OPENAI_API_KEY or connect ollama',
  NO_PROVIDER_CONNECTED: 'No provider is connected yet. Connect one: connect (shows presets), e.g. connect openai --key-env OPENAI_API_KEY or connect ollama',
  PROVIDER_URL_REQUIRED: 'A new connection needs its base URL: connect <name> https://<host>/v1 [--key-env VARIABLE]',
  CONNECTION_ID_INVALID: 'Connection names use lowercase letters, digits and dashes (max 32), e.g. my-router',
  PROVIDER_UNREACHABLE: 'The provider endpoint did not answer. Check the URL and that the service is running, then retry connect.',
  PROVIDER_METADATA_TIMEOUT: 'The provider took longer than 8 s to list models. Retry, or pick another provider with: connect',
  PROVIDER_AUTH_REQUIRED: 'The provider needs an API key: set it in an environment variable, then connect <provider-id> --key-env <VARIABLE>',
  MODEL_NOT_OFFERED_BY_PROVIDER: 'That model is not offered by the provider. See the valid list with: model list',
  PROVIDER_URL_NOT_ALLOWED: 'Use https:// for remote providers; plain http:// only for this computer (127.0.0.1, localhost, [::1]); no user:password in the URL.',
  UNKNOWN_PROVIDER: 'See your connections and the presets with: connect',
  INVALID_API_KEY_FORMAT: 'The API key must be one token without spaces (max 512 characters).',
  QUEUE_FULL: 'Core is busy (8 queued runs). Wait for runs to finish: subagent list',
  REQUEST_ID_CONFLICT: 'This request id was already used with different content; nothing was replayed.',
  OWNER_REQUIRED: 'This action needs Owner approval.',
});
function rejected(namespace, r, extra = {}) {
  const error = code(r.body?.error);
  return { state: 'REJECTED', namespace, httpStatus: r.status, error, ...(HINTS[error] ? { hint: HINTS[error] } : {}), ...extra };
}
function runView(r) {
  if (!r || !/^run_[a-f0-9]{32}$/.test(r.runId) || !STATES.has(r.state)) throw Error('UNRECOGNIZED_SUBAGENT_READBACK');
  return { runId: r.runId, requestId: safe(r.requestId, 64), worker: safe(r.worker, 16), state: r.state, cancelRequested: r.cancelRequested === true,
    reason: safe(r.reason, 48), provider: safe(r.provider, 32), model: safe(r.model, 48), outputPreview: safe(r.outputPreview, 240), error: safe(r.error, 120), attempts: Number.isSafeInteger(r.attempts) ? r.attempts : null };
}
const holdDir = client => path.join(client.sessionDirectory, 'cli-subagent-intents');
function retryWait(ms, signal) {
  if (signal?.aborted) return Promise.reject(Error('SUBAGENT_RECONCILE_CANCELLED'));
  return new Promise((resolve, reject) => {
    const done = fn => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); fn(); };
    const abort = () => done(() => reject(Error('SUBAGENT_RECONCILE_CANCELLED')));
    const timer = setTimeout(() => done(resolve), ms);
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
async function list(client, signal) {
  // Only this CLI session's runs (cross-session isolation); Core filters by the session key.
  const r = await client.r9('/api/r9/pandawa/runs?cliSession=' + client.sessionId, { signal });
  if (!r.ok || r.body?.success !== true || !Array.isArray(r.body.data?.runs)) throw Error('UNRECOGNIZED_SUBAGENT_READBACK');
  return r.body.data.runs.map(runView);
}
async function providers(client, signal) {
  const r = await client.r9('/api/r9/provider', { signal });
  const d = r.body?.data;
  if (!r.ok || !Array.isArray(d?.providers) || typeof d.liveInferenceAuthorized !== 'boolean') throw Error('UNRECOGNIZED_PROVIDER_READBACK');
  return { active: safe(d.active, 32), model: safe(d.model, 128), executable: d.executable === true,
    presets: (Array.isArray(d.presets) ? d.presets : []).map(p => ({ id: safe(p.id, 32), label: safe(p.label, 80), baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '', keyRequired: p.keyRequired === true })),
    onboarding: code(d.onboarding), providers: d.providers.map(p => ({ id: safe(p.id, 32), label: safe(p.label, 80), grantStatus: safe(p.grantStatus, 24), kind: safe(p.kind, 16), configurationVersion: safe(p.configurationVersion, 100), authorizedModels: Array.isArray(p.authorizedModels) ? p.authorizedModels.filter(m => typeof m === 'string') : null, baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : null, configured: p.configured === true, executable: p.executable === true, reason: code(p.reason), hasKey: p.hasKey === true, keyRemembered: p.keyRemembered === true, model: safe(p.model, 128) })),
    unavailable: (d.unavailable || []).map(p => ({ id: safe(p.id, 32), reason: code(p.reason) })) };
}
async function models(client, id, signal) {
  const r = await client.r9('/api/r9/models?provider=' + id, { signal });
  if (!r.ok) return { error: rejected('model', r) };
  if (!Array.isArray(r.body?.data?.models)) throw Error('UNRECOGNIZED_MODEL_READBACK');
  return { models: r.body.data.models.map(m => safe(m, 128)).filter(Boolean) };
}
const providerLabel = p => `${p.id}  ${p.kind === 'live' ? (p.label || '') + '  ' : ''}${p.kind !== 'live' ? 'ready (offline, zero cost)' : p.grantStatus === 'granted' ? 'granted: ' + (p.authorizedModels || []).join(', ') : p.grantStatus === 'needs-new-grant' ? 'needs a new grant (URL changed or expired): provider allow ' + p.id : 'needs a grant: provider allow ' + p.id}`;
const presetLabel = p => `+ ${p.id}  add ${p.label}${p.baseUrl ? '  ' + p.baseUrl : ''}${p.keyRequired ? '  (needs --key-env)' : ''}`;
async function select(client, provider, model, signal, expectedVersion) {
  const r = await client.r9('/api/r9/provider', { method: 'POST', role: 'owner', body: { provider, ...(model ? { model } : {}), ...(expectedVersion ? { expectedVersion } : {}) }, signal });
  if (!r.ok) return rejected('provider', r);
  const d = r.body.data;
  return { state: 'SELECTED', namespace: 'provider', provider: safe(d.active, 32), model: safe(d.model, 128), executable: d.executable === true,
    ...(d.executable ? {} : { notice: HINTS.LIVE_INFERENCE_NOT_AUTHORIZED }), persist: { provider: safe(d.active, 32), model: safe(d.model, 128) }, next: 'model pick  (choose another model)' };
}
async function dispatch(client, p, { signal, confirmOwner, env = process.env }) {
  if (p.action === 'provider' && p.op === 'status') {
    const s = await providers(client, signal);
    return { state: 'READ_ONLY', namespace: 'provider', ...s, liveInference: false };
  }
  if (p.action === 'connect' && p.op === 'pick') {
    const s = await providers(client, signal);
    // Existing connections first, then presets not added yet (a preset only prefills the URL; nothing connects by itself).
    const presets = s.presets.filter(p => p.id !== 'custom' && !s.providers.some(x => x.id === p.id));
    return { state: 'PICK', namespace: 'provider', pick: { kind: 'provider', title: s.providers.length ? 'Connect a provider' : 'Connect a provider (none connected yet)', choices: [...s.providers.map(providerLabel), ...presets.map(presetLabel)], ids: [...s.providers.map(x => x.id), ...presets.map(x => x.id)], index: Math.max(0, s.providers.findIndex(x => x.id === s.active)) },
      providers: s.providers, presets: s.presets, help: 'Up/Down + Enter to connect, Esc to cancel. Presets needing a key: connect <preset> --key-env VARIABLE. Any other endpoint: connect <name> <base-url> [--key-env VARIABLE]. A live connection runs once a grant covers the model: provider allow <id>.' };
  }
  if (p.action === 'model' && (p.op === 'pick' || p.op === 'list')) {
    const s = await providers(client, signal), id = p.provider || s.active;
    const m = await models(client, id, signal);
    if (m.error) return m.error;
    const current = id === s.active ? s.model : s.providers.find(x => x.id === id)?.model;
    if (p.op === 'list') return { state: 'READ_ONLY', namespace: 'model', provider: id, models: m.models, current, metadataOnly: true };
    return { state: 'PICK', namespace: 'model', pick: { kind: 'model', title: 'Choose a model for ' + id, provider: id, choices: m.models.slice(0, 32), index: Math.max(0, m.models.indexOf(current)) }, provider: id, total: m.models.length, help: 'Up/Down + Enter to select, Esc to cancel (nothing changes).' };
  }
  if (p.action === 'model' && p.op === 'use') {
    const s = await providers(client, signal);
    if (!await confirmOwner({ action: 'model use', planId: s.active + '/' + p.model, version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
    return select(client, s.active, p.model, signal);
  }
  if (p.action === 'provider' && ['allow', 'rename', 'remove'].includes(p.op)) {
    const s = await providers(client, signal), row = s.providers.find(x => x.id === p.provider);
    if (!row || row.kind !== 'live') return { state: 'REJECTED', namespace: 'provider', error: 'UNKNOWN_PROVIDER', hint: HINTS.UNKNOWN_PROVIDER };
    const plan = { allow: `allow every model of ${p.provider} (${row.baseUrl}) for ${p.days} days`, rename: `rename ${p.provider} to "${p.label}"`, remove: `remove ${p.provider} and its remembered key` }[p.op];
    if (!await confirmOwner({ action: 'provider ' + p.op, planId: plan, version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
    const call = { allow: ['/api/r9/provider/model-grant', { approval: 'cli-owner-' + Date.now(), provider: p.provider, baseUrl: row.baseUrl, model: '*', expiresAt: Date.now() + p.days * 86400000, expectedVersion: row.configurationVersion }],
      rename: ['/api/r9/connect', { provider: p.provider, label: p.label, expectedVersion: row.configurationVersion }],
      remove: ['/api/r9/provider/remove', { provider: p.provider, expectedVersion: row.configurationVersion }] }[p.op];
    const r = await client.r9(call[0], { method: 'POST', role: 'owner', body: call[1], signal });
    if (!r.ok) return rejected('provider', r);
    return { state: { allow: 'ALLOWED', rename: 'RENAMED', remove: 'REMOVED' }[p.op], namespace: 'provider', provider: p.provider, ...(p.op === 'allow' ? { model: '*', days: p.days, next: 'model pick ' + p.provider } : {}) };
  }
  if (p.action === 'provider' && p.op === 'use') {
    if (!await confirmOwner({ action: 'provider use', planId: p.provider + (p.model ? '/' + p.model : ''), version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
    return select(client, p.provider, p.model, signal);
  }
  if (p.action === 'connect' && p.op === 'connect') {
    let apiKey;
    if (p.keyEnv) { apiKey = env[p.keyEnv]; if (typeof apiKey !== 'string' || !apiKey) return { state: 'REJECTED', namespace: 'connect', error: 'KEY_ENV_EMPTY', hint: `Environment variable ${p.keyEnv} is not set in this CLI process.` }; }
    let baseUrl = p.baseUrl, label;
    if (!p.provider.startsWith('offline-fixture-') && !baseUrl) {
      // A new connection named after a preset takes the preset's URL and label (prefill only).
      const s = await providers(client, signal), preset = s.presets.find(x => x.id === p.provider && x.baseUrl);
      if (!s.providers.some(x => x.id === p.provider)) {
        if (!preset) return { state: 'REJECTED', namespace: 'connect', error: 'PROVIDER_URL_REQUIRED', hint: HINTS.PROVIDER_URL_REQUIRED };
        baseUrl = preset.baseUrl; label = preset.label;
        if (preset.keyRequired && !apiKey) return { state: 'REJECTED', namespace: 'connect', error: 'PROVIDER_AUTH_REQUIRED', hint: `${preset.label} needs an API key: connect ${p.provider} --key-env <VARIABLE>` };
      }
    }
    if (!await confirmOwner({ action: 'connect provider', planId: p.provider, version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
    if (!p.provider.startsWith('offline-fixture-')) {
      const body = { provider: p.provider, ...(baseUrl ? { baseUrl } : {}), ...(label ? { label } : {}), ...(apiKey ? { apiKey } : {}) };
      const r = await client.r9('/api/r9/connect', { method: 'POST', role: 'owner', body, signal });
      if (!r.ok) return rejected('connect', r);
      // A live connection has no model until the Owner picks one (never the first listed).
      const d = r.body?.data || {}, keyStored = apiKey ? 'Core memory only (re-enter after Core restart); never displayed' : 'none';
      return { state: 'CONNECTED', namespace: 'connect', provider: p.provider, models: d.models ?? null, keyStored,
        next: (d.grantStatus === 'granted' ? '' : 'provider allow ' + p.provider + '  then  ') + 'model pick ' + p.provider };
    }
    const s = await select(client, p.provider, undefined, signal);
    return s.state === 'SELECTED' ? { ...s, namespace: 'connect', keyStored: apiKey ? 'Core memory only (re-enter after Core restart); never displayed' : 'none' } : s;
  }
  if (p.op === 'list') return { state: 'READ_ONLY', namespace: 'subagent', runs: await list(client, signal), authority: 'Core Pandawa lifecycle readback' };
  if (p.op === 'reconcile') {
    const file = path.join(holdDir(client), p.requestId + '.json');
    let run = null;
    const deadline = Date.now() + 1500;
    do {
      run = (await list(client, signal)).find(r => r.requestId === p.requestId) || null;
      if (run || !fs.existsSync(file) || Date.now() >= deadline) break;
      await retryWait(Math.min(100, deadline - Date.now()), signal);
    } while (true);
    if (!run) return { state: fs.existsSync(file) ? 'NOT_FOUND_HELD' : 'NO_HOLD', namespace: 'subagent', requestId: p.requestId, replay: 'never automatic' };
    fs.rmSync(file, { force: true });
    return { state: 'RECONCILED', namespace: 'subagent', run };
  }
  if (p.op === 'cancel') {
    if (!await confirmOwner({ action: 'subagent cancel', planId: p.runId, version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
    const r = await client.r9(`/api/r9/pandawa/runs/${p.runId}/cancel`, { method: 'POST', role: 'owner', body: {}, signal });
    if (!r.ok) return rejected('subagent', r, { run: r.body?.data ? runView(r.body.data) : null });
    return { state: 'CANCEL_REQUESTED', namespace: 'subagent', run: runView(r.body.data), interruptible: r.body.data.interruptible === true };
  }
  // run
  if (!await confirmOwner({ action: 'subagent run', planId: p.worker, version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
  const requestId = 'req_' + crypto.randomUUID().replace(/-/g, '');
  fs.mkdirSync(holdDir(client), { recursive: true });
  const file = path.join(holdDir(client), requestId + '.json');
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, requestId, worker: p.worker, digest: crypto.createHash('sha256').update(p.task).digest('hex'), createdAt: Date.now() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let r;
  try { r = await client.r9('/api/r9/pandawa/runs', { method: 'POST', role: 'owner', body: { requestId, cliSession: client.sessionId, worker: p.worker, task: p.task }, signal }); }
  catch { return { state: 'OUTCOME_UNKNOWN_HELD', namespace: 'subagent', requestId, next: 'subagent reconcile ' + requestId }; }
  if (r.ok) { fs.rmSync(file, { force: true }); return { state: r.body.duplicate ? 'DUPLICATE' : 'ACCEPTED', namespace: 'subagent', run: runView(r.body.data) }; }
  if (DEFINITIVE.has(r.status)) fs.rmSync(file, { force: true });
  return DEFINITIVE.has(r.status) ? rejected('subagent', r, { requestId }) : { state: 'OUTCOME_UNKNOWN_HELD', namespace: 'subagent', httpStatus: r.status, requestId };
}
function pendingHolds(client) {
  const d = holdDir(client);
  return fs.existsSync(d) ? fs.readdirSync(d).filter(n => /^req_[a-f0-9]{32}\.json$/.test(n)).map(n => n.slice(0, -5)) : [];
}
// Settings Control Center: one Owner confirmation, then (live providers) connect with the typed loopback URL / key in
// the Core POST body (never a command argument, log or transcript line), then select provider + model in Core.
async function applyProvider(client, { provider, model, baseUrl, apiKey, remember }, { confirmOwner, signal } = {}) {
  const { receipt, reconcile } = require('./provider-apply-receipt.cjs');
  const pending = await reconcile(client);
  if (pending) {
    receipt(client, {provider:pending.provider, model:pending.model, phase:'RECONCILED'});
    return { state: 'REJECTED', error: 'PROVIDER_APPLY_RECONCILED_REVIEW_STATE', reconciliation: pending };
  }
  const s = await providers(client, signal), row = s.providers.find(p => p.id === provider);
  if (!row) return { state: 'REJECTED', namespace: 'provider', error: 'UNKNOWN_PROVIDER' };
  if (require('./provider-endpoint.cjs').sameEndpoint(provider, baseUrl, row.baseUrl)) baseUrl = undefined;
   if (row.kind === 'live' && !modelAuthorized(row, model)) return { state: 'REJECTED', namespace: 'provider', error: 'LIVE_MODEL_NOT_AUTHORIZED' };
  if (!await confirmOwner({ action: 'settings apply provider', planId: provider + (model ? '/' + model : ''), version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
  let connected = false, version = row.configurationVersion;
  receipt(client, { provider, model, phase: 'PREPARED' });
  try {
   if (row.kind === 'live' && (baseUrl !== undefined || apiKey !== undefined || remember !== undefined)) {
      const r = await client.r9('/api/r9/connect', { method: 'POST', role: 'owner', body: { provider, ...(version ? {expectedVersion:version} : {}), ...(baseUrl !== undefined ? { baseUrl } : {}), ...(model ? { model } : {}), ...(apiKey !== undefined ? { apiKey, remember: true } : {}), ...(apiKey === undefined && typeof remember === 'boolean' ? { remember } : {}) }, signal });
     if (!r.ok) { receipt(client, {provider, model, phase: DEFINITIVE.has(r.status) ? 'REJECTED' : 'UNKNOWN'}); return DEFINITIVE.has(r.status) ? rejected('connect', r) : {state:'OUTCOME_UNKNOWN',error:'PROVIDER_APPLY_OUTCOME_UNKNOWN'}; }
     connected = true; version = r.body?.data?.configurationVersion;
     receipt(client, {provider, model, phase: model ? 'CONNECTED' : 'COMPLETE'});
    // A credential-only Apply establishes connection and metadata, but does not select a model.
    // The Owner must choose one explicitly in a later Apply before live dispatch becomes executable.
    if (!model) return { state: 'CONNECTED', provider, model: null, executable: false, models: r.body?.data?.models ?? null };
  }
   receipt(client, {provider, model, phase: 'SELECTING'});
   const selected = await select(client, provider, model, signal, version);
   receipt(client, {provider, model, phase: selected.state === 'SELECTED' ? 'COMPLETE' : connected ? 'PARTIAL' : 'UNKNOWN'});
   if (selected.state !== 'SELECTED' && row.kind === 'live' && (apiKey !== undefined || baseUrl !== undefined)) return { ...selected, configurationSaved: true };
   return selected;
  } catch {
    receipt(client, {provider, model, phase: connected ? 'PARTIAL' : 'UNKNOWN'});
    let reconciliation = null; try { reconciliation = await reconcile(client); } catch {}
    return {state:'OUTCOME_UNKNOWN', error:'PROVIDER_APPLY_OUTCOME_UNKNOWN', configurationSaved:connected, reconciliation};
  }
}
async function revokeProvider(client, provider, { confirmOwner, signal } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider || '') || provider.startsWith('offline-fixture-')) throw Error('UNKNOWN_PROVIDER');
  if (!await confirmOwner({ action: 'revoke provider credential', planId: provider, version: 1 })) throw Error('OWNER_CONFIRMATION_CANCELLED');
  const r = await client.r9('/api/r9/provider/revoke', { method: 'POST', role: 'owner', body: { provider }, signal });
  if (!r.ok) throw Error(r.body?.error || 'PROVIDER_REVOCATION_FAILED');
  return r.body.data;
}
module.exports = { modelAuthorized, dispatch, runView, pendingHolds, HINTS, select, providers, models, applyProvider, revokeProvider };
