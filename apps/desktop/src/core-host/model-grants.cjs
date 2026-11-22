'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = (message, status = 403) => { throw Object.assign(Error(message), { status }); };
const LIMIT_KEYS = ['completions', 'maxTokens', 'totalTokens'], MAX_GRANT_MS = 366 * 86400000;
const { BASE_URL, CONNECTION_ID } = require('./provider-registry.cjs');

// Profile-scoped journal (directory = the provider profile, not the Core session). No provider credential is used here.
function createModelGrants({ directory, candidate, port, ownerAuthority, now = Date.now, witness = null }) {
  const scope = { directory: fs.realpathSync(directory), candidate: fs.realpathSync(candidate), port };
  if (!Number.isInteger(port) || typeof ownerAuthority !== 'string' || ownerAuthority.length < 32) fail('MODEL_GRANT_AUTHORITY_INVALID');
  const scopeId = crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const key = crypto.createHmac('sha256', ownerAuthority).update('damar-model-grants-v1:' + scopeId).digest();
  const file = path.join(directory, 'model-grants.jsonl');
  const sign = row => crypto.createHmac('sha256', key).update(JSON.stringify(row)).digest('hex');
  let broken = false;
  function replay() {
    if (broken) fail('MODEL_GRANT_STORE_UNAVAILABLE', 503);
    try {
      // One grant per connection id; a revoke record names its connection, or (legacy) clears them all.
      let revision = 0, previous = null, grant = null, grants = {};
      if (fs.existsSync(file)) {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error();
        const text = fs.readFileSync(file, 'utf8');
        if (text && !text.endsWith('\n')) throw Error();
        for (const line of text.split('\n').filter(Boolean)) {
          const { record, mac } = JSON.parse(line);
          if (typeof mac !== 'string' || mac !== sign(record) || record.scopeId !== scopeId || record.revision !== revision + 1 || record.previous !== previous) throw Error();
          revision = record.revision; previous = mac;
          if (record.action === 'grant') { grant = record.grant; grants[grant.provider] = { ...grant, revision: record.revision }; }
          else if (record.grant?.provider) { delete grants[record.grant.provider]; if (grant?.provider === record.grant.provider) grant = null; }
          else { grant = null; grants = {}; }
        }
      }
      const state = { revision, previous, grant, grants };
      if ((witness && !witness.verify(scopeId, { revision, digest: previous }, now())) || (revision && !witness)) fail('MODEL_GRANT_ROLLBACK_AUTHORITY_UNAVAILABLE', 503);
      return state;
    } catch (error) { broken = true; if (error.message === 'MODEL_GRANT_ROLLBACK_AUTHORITY_UNAVAILABLE') throw error; fail('MODEL_GRANT_STORE_UNAVAILABLE', 503); }
  }
  function view() {
    const state = replay();
    // `grant`/`effective`: the most recent grant (compatibility); `grants`: the current grant of every connection.
    return { scopeId, scope: { ...scope }, revision: state.revision, grant: state.grant,
      effective: !!state.grant && now() < state.grant.expiresAt,
      grants: Object.values(state.grants).map(g => ({ ...g, effective: now() < g.expiresAt })) };
  }
  function append(action, grant, approval) {
    const state = replay();
    if (!witness) fail('MODEL_GRANT_ROLLBACK_AUTHORITY_UNAVAILABLE', 503);
    const record = { scopeId, revision: state.revision + 1, previous: state.previous, action, at: now(), actor: 'owner', approval, grant };
    const mac = sign(record);
    // Advance the independent CAS authority first. A crash before journal fsync is a
    // mismatch, not permission to accept the old journal or replay the mutation.
    if (!witness.advance(scopeId, { revision: state.revision, digest: state.previous }, { revision: record.revision, digest: mac }, now())) fail('MODEL_GRANT_ROLLBACK_DETECTED', 503);
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ record, mac }) + '\n'); fs.fsyncSync(fd); }
    catch { broken = true; fail('MODEL_GRANT_AUDIT_FAILED', 503); }
    finally { fs.closeSync(fd); }
    return view();
  }
  const reference = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
  return Object.freeze({
    view,
    grant(input) {
      // Owner policy: one connection id + its base URL, one model or every model ('*'), up to a year, limits optional.
      const keys = Object.keys(input).sort().join();
      const route = CONNECTION_ID.test(input.provider || '') && typeof input.baseUrl === 'string' && BASE_URL.test(input.baseUrl);
      if (!['approval,baseUrl,expiresAt,model,provider', 'approval,baseUrl,expiresAt,limits,model,provider'].includes(keys) || !route || !(input.model === '*' || reference(input.model)) || !reference(input.approval)) fail('MODEL_GRANT_REQUEST_INVALID', 400);
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now() || input.expiresAt > now() + MAX_GRANT_MS) fail('MODEL_GRANT_EXPIRY_INVALID', 400);
      const l = input.limits ?? {};
      if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).some(k => !LIMIT_KEYS.includes(k)) || !Object.values(l).every(v => Number.isSafeInteger(v) && v > 0)) fail('MODEL_GRANT_LIMITS_INVALID', 400);
      return append('grant', { provider: input.provider, baseUrl: input.baseUrl, model: input.model, expiresAt: input.expiresAt, limits: { ...l } }, input.approval);
    },
    // Revoke one connection's grant, or every grant when no provider is named (legacy behaviour).
    revoke(approval, provider) {
      if (!reference(approval) || (provider !== undefined && !CONNECTION_ID.test(provider))) fail('MODEL_GRANT_REQUEST_INVALID', 400);
      return append('revoke', provider === undefined ? null : { provider }, approval);
    },
    authorization(provider, baseUrl, model) {
      const g = replay().grants[provider];
      if (!g || now() >= g.expiresAt || g.baseUrl !== baseUrl || !(g.model === '*' || g.model === model)) return null;
      // revision: the journal record that created this connection's grant (other connections' grants do not change it).
      // Unset limits fall back to the Core budget's own session caps.
      return { revision: g.revision, model: g.model, limits: Object.fromEntries(LIMIT_KEYS.map(k => [k, g.limits?.[k] ?? Number.MAX_SAFE_INTEGER])) };
    },
  });
}
// Profile-level journal key: grants live next to provider-connections.json and survive new Core sessions, so the
// journal MAC key cannot be the per-session Owner token. Created once (0600) beside the journal.
// ponytail: same-user file, the same ceiling as the user witness and DPAPI; upgrade = protected authority service.
function profileSecret(directory) {
  const file = path.join(directory, 'model-grants.key');
  fs.mkdirSync(directory, { recursive: true });
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) fail('MODEL_GRANT_STORE_UNAVAILABLE', 503);
  return value;
}
module.exports = { createModelGrants, profileSecret };
