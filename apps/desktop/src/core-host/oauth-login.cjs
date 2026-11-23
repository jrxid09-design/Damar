'use strict';
// OAuth account login for providers - the Control Dashboard "Login /
// Hubungkan Akun" flow. Only flows a provider OFFICIALLY offers to
// third-party applications are implemented. Today that is OpenRouter's
// documented OAuth PKCE (openrouter.ai/docs/guides/overview/auth/oauth):
// no client registration or secret; the user authorizes on OpenRouter and
// the exchange returns a user API key for the user's OWN account, billed to
// their own credits. Direct subscription OAuth for OpenAI/Anthropic is NOT
// implemented - Anthropic's terms prohibit third-party Claude.ai login
// outright, and OpenAI's Sign in with ChatGPT plan usage runs through a
// partner/open-source program (see docs/oauth-providers-design.md). The
// classic API-key route remains the official path for both.
//
// The returned key is a SECRET: it is stored only in the Core key vault
// (Windows DPAPI), never in settings files, never in logs, never in any
// API response (status carries identity metadata only). The authorization
// code and the PKCE verifier are single-use and never leave this module.

const crypto = require('node:crypto');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const fail = (msg, status, data) => Object.assign(Error(msg), { status, ...(data ? { data } : {}) });

const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    authUrl: 'https://openrouter.ai/auth',
    keysUrl: 'https://openrouter.ai/api/v1/auth/keys',
    keyInfoUrl: 'https://openrouter.ai/api/v1/key',
    vaultId: 'oauth-openrouter',
    keyLabel: 'DAMAR (OAuth login)',
  },
};
const PENDING_TTL_MS = 10 * 60 * 1000; // the provider's authorization-code lifetime

function createOAuthLogin({ keyStore, fetch, now = Date.now, registrySync = null, log = () => {} } = {}) {
  if (!keyStore) throw new Error('keyStore required');
  const doFetch = fetch || globalThis.fetch;
  const P = PROVIDERS.openrouter;
  let pending = null;   // { verifier, state, at } - one flow at a time
  let identity = null;  // non-secret key metadata { label, usage, limit, isFreeTier }
  let connState = keyStore.has(P.vaultId) ? 'connected' : 'disconnected';
  let lastOutcome = null;
  let syncNote = null;

  function start({ callbackUrl } = {}) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/oauth\/openrouter\/callback$/.test(callbackUrl || '')) throw fail('OAUTH_CALLBACK_INVALID', 400);
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    pending = { verifier, state, at: now() };
    const u = new URL(P.authUrl);
    u.searchParams.set('callback_url', callbackUrl);
    u.searchParams.set('code_challenge', b64url(sha256(verifier)));
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    u.searchParams.set('key_label', P.keyLabel);
    log('oauth.start', { provider: 'openrouter' });
    return { authorizeUrl: u.toString(), expiresInSec: PENDING_TTL_MS / 1000 };
  }

  async function fetchIdentity(key) {
    try {
      const res = await doFetch(P.keyInfoUrl, { headers: { authorization: 'Bearer ' + key } });
      if (res.status === 401 || res.status === 403) return { invalid: true };
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const d = (data && data.data) || {};
      return { label: typeof d.label === 'string' ? d.label.slice(0, 80) : null, usage: typeof d.usage === 'number' ? d.usage : null, limit: typeof d.limit === 'number' ? d.limit : null, isFreeTier: !!d.is_free_tier };
    } catch { return null; }
  }

  async function handleCallback({ code, state, error } = {}) {
    if (error) { pending = null; lastOutcome = 'denied'; log('oauth.denied', { provider: 'openrouter' }); return { ok: false, error: 'OAUTH_DENIED' }; }
    if (!pending || !state || state !== pending.state) { lastOutcome = 'state-mismatch'; return { ok: false, error: 'OAUTH_STATE_MISMATCH' }; }
    if (now() - pending.at > PENDING_TTL_MS) { pending = null; lastOutcome = 'expired'; return { ok: false, error: 'OAUTH_CODE_EXPIRED' }; }
    if (typeof code !== 'string' || !code) return { ok: false, error: 'OAUTH_CODE_MISSING' };
    const { verifier } = pending;
    pending = null; // single-use, whatever happens next
    const res = await doFetch(P.keysUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier }) });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok || !data || typeof data.key !== 'string') {
      lastOutcome = 'exchange-failed';
      throw fail('OAUTH_EXCHANGE_FAILED', 502, { providerMessage: String((data && (data.error?.message || data.error)) || ('HTTP ' + res.status)).slice(0, 120) });
    }
    keyStore.save(P.vaultId, data.key);
    connState = 'connected'; lastOutcome = 'connected';
    const idn = await fetchIdentity(data.key);
    if (idn && idn.invalid) { connState = 'invalid'; identity = null; } else identity = idn;
    if (registrySync) {
      try { const r = await registrySync.connect(data.key); syncNote = r && r.synced ? 'synced' : (r && r.note) || 'not-synced'; }
      catch { syncNote = 'sync-failed'; }
    }
    log('oauth.connected', { provider: 'openrouter' });
    return { ok: true };
  }

  async function checkIdentity() {
    const key = keyStore.load(P.vaultId);
    if (!key) { connState = 'disconnected'; identity = null; return status(); }
    const idn = await fetchIdentity(key);
    if (idn && idn.invalid) { connState = 'invalid'; identity = null; }
    else if (idn) { identity = idn; connState = 'connected'; }
    return status();
  }

  function status() {
    return { connections: [{ id: 'openrouter', label: P.label, status: connState, identity, sync: syncNote, lastOutcome }] };
  }

  async function disconnect() {
    keyStore.forget(P.vaultId);
    if (registrySync) { try { await registrySync.disconnect(); } catch {} }
    identity = null; pending = null; connState = 'disconnected'; lastOutcome = 'disconnected'; syncNote = null;
    log('oauth.disconnected', { provider: 'openrouter' });
    return { ok: true };
  }

  async function handleR9(req, res, url, { who, json }) {
    if (who !== 'owner') return json(403, { success: false, error: 'OWNER_REQUIRED' });
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/api/r9/oauth') return json(200, { success: true, data: status() });
      if (req.method === 'POST' && p === '/api/r9/oauth/openrouter/start') {
        const host = req.headers.host || '127.0.0.1';
        return json(200, { success: true, data: start({ callbackUrl: 'http://' + host + '/oauth/openrouter/callback' }) });
      }
      if (req.method === 'POST' && p === '/api/r9/oauth/openrouter/check') return json(200, { success: true, data: await checkIdentity() });
      if (req.method === 'POST' && p === '/api/r9/oauth/openrouter/disconnect') return json(200, { success: true, data: await disconnect() });
    } catch (e) {
      if (e.status) return json(e.status, { success: false, error: e.message, ...(e.data ? { data: e.data } : {}) });
      throw e;
    }
    return json(404, { success: false, error: 'NOT_FOUND' });
  }

  // The OAuth callback arrives from the user's browser WITHOUT DAMAR
  // credentials - by design: the single-use, 10-minute `state` value is the
  // CSRF proof, exactly as in every localhost OAuth flow.
  async function handleCallbackHttp(req, res, url) {
    const q = url.searchParams;
    let result;
    try { result = await handleCallback({ code: q.get('code') || undefined, state: q.get('state') || undefined, error: q.get('error') || undefined }); }
    catch (e) { result = { ok: false, error: e.message || 'OAUTH_FAILED' }; }
    const msg = result.ok
      ? 'Terhubung. Akun OpenRouter sekarang terhubung ke DAMAR — kembali ke Control Dashboard.'
      : 'Login tidak selesai (' + result.error + '). Kembali ke Control Dashboard dan coba lagi.';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>DAMAR OAuth</title><body style="font-family:system-ui;background:#0b0b0d;color:#e8e3d8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:20px"><h2>DAMAR</h2><p>' + msg + '</p></div>');
    return result;
  }

  return { start, handleCallback, handleCallbackHttp, handleR9, status, disconnect, checkIdentity, apiKey: () => keyStore.load(P.vaultId), _pendingState: () => (pending ? pending.state : null) };
}

module.exports = { createOAuthLogin, PROVIDERS };
