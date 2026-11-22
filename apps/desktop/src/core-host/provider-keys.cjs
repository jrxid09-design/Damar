'use strict';
// Per-connection API-key pool: rotation strategy, per-key health and cooldown. Pure (no I/O); the registry owns the
// secrets (DPAPI key store) and the router reports every upstream outcome here. Secrets never leave pick().
const STRATEGIES = Object.freeze(['round-robin', 'fill-first', 'lru']);
const ROUTING_DEFAULTS = Object.freeze({ cooldownMs: 30000, maxCooldownMs: 600000, maxConcurrency: 8, maxPerKey: 8 });
// Statuses that move on to the next key / target. Other 4xx (bad request, unknown model) are the caller's problem.
const retryable = status => status === 'network' || status === 401 || status === 403 || status === 408 || status === 429 || (Number.isInteger(status) && status >= 500);
function validRouting(v) {
  const r = { ...ROUTING_DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
  if (!Number.isSafeInteger(r.cooldownMs) || r.cooldownMs < 1000 || r.cooldownMs > 3600000) throw Object.assign(Error('ROUTING_SETTINGS_INVALID'), { status: 400 });
  if (!Number.isSafeInteger(r.maxCooldownMs) || r.maxCooldownMs < r.cooldownMs || r.maxCooldownMs > 86400000) throw Object.assign(Error('ROUTING_SETTINGS_INVALID'), { status: 400 });
  for (const k of ['maxConcurrency', 'maxPerKey']) if (!Number.isSafeInteger(r[k]) || r[k] < 1 || r[k] > 256) throw Object.assign(Error('ROUTING_SETTINGS_INVALID'), { status: 400 });
  return { cooldownMs: r.cooldownMs, maxCooldownMs: r.maxCooldownMs, maxConcurrency: r.maxConcurrency, maxPerKey: r.maxPerKey };
}
const suffixOf = secret => '…' + String(secret).slice(-4);

function createKeyPool({ now = Date.now, routing = ROUTING_DEFAULTS, health = {} } = {}) {
  let settings = validRouting(routing);
  const pools = new Map();   // connection id -> { strategy, cursor, keys: [{ kid, secret, suffix, enabled, health }] }
  const blank = () => ({ lastOk: null, lastError: null, lastErrorAt: null, cooldownUntil: 0, failures: 0, lastUsed: 0, uses: 0 });
  const pool = id => pools.get(id) || { strategy: 'round-robin', cursor: 0, keys: [] };
  return {
    STRATEGIES,
    routing: () => ({ ...settings }),
    setRouting(v) { settings = validRouting(v); return { ...settings }; },
    // entries: [{ kid, secret, enabled }]; health survives a re-set (and a restart via the persisted snapshot).
    set(id, entries, strategy = 'round-robin') {
      if (!STRATEGIES.includes(strategy)) throw Object.assign(Error('KEY_STRATEGY_INVALID'), { status: 400 });
      const old = pool(id);
      pools.set(id, { strategy, cursor: old.cursor, keys: entries.map(e => ({ kid: e.kid, secret: e.secret, suffix: suffixOf(e.secret), enabled: e.enabled !== false,
        health: old.keys.find(k => k.kid === e.kid)?.health || { ...blank(), ...(health[id]?.[e.kid] || {}) } })) });
    },
    drop(id) { pools.delete(id); },
    size: id => pool(id).keys.length,
    // Next usable key per strategy, skipping disabled and cooling-down keys (and `exclude`d ones already tried).
    pick(id, exclude = new Set()) {
      const p = pool(id), t = now();
      const ready = p.keys.filter(k => k.enabled && k.health.cooldownUntil <= t && !exclude.has(k.kid));
      // Soft per-key concurrency: prefer keys below maxPerKey; when all are busy, still use one (the connection queue is the hard cap).
      const free = ready.filter(k => (k.inFlight || 0) < settings.maxPerKey), usable = free.length ? free : ready;
      if (!usable.length) return null;
      let k;
      if (p.strategy === 'fill-first') k = usable[0];
      else if (p.strategy === 'lru') k = usable.reduce((a, b) => (b.health.lastUsed < a.health.lastUsed ? b : a));
      else { k = usable[p.cursor % usable.length]; p.cursor = (p.cursor + 1) % Math.max(1, usable.length); }
      k.health.lastUsed = t; k.health.uses++; k.inFlight = (k.inFlight || 0) + 1;
      return { kid: k.kid, secret: k.secret };
    },
    done(id, kid) { const k = pool(id).keys.find(x => x.kid === kid); if (k && k.inFlight > 0) k.inFlight--; },
    // outcome: 'ok' | HTTP status | 'network'. Returns whether the caller should fail over.
    report(id, kid, outcome) {
      const k = pool(id).keys.find(x => x.kid === kid); const t = now();
      if (!k) return retryable(outcome);
      if (outcome === 'ok') { Object.assign(k.health, { lastOk: t, failures: 0, cooldownUntil: 0 }); return false; }
      k.health.lastError = String(outcome); k.health.lastErrorAt = t;
      if (!retryable(outcome)) return false;
      k.health.failures++;
      // Auth failures park the key for the maximum; rate limits / 5xx / network back off exponentially.
      const wait = outcome === 401 || outcome === 403 ? settings.maxCooldownMs : Math.min(settings.maxCooldownMs, settings.cooldownMs * 2 ** (k.health.failures - 1));
      k.health.cooldownUntil = t + wait;
      return true;
    },
    // Metadata only (never secrets).
    view(id) { const p = pool(id), t = now(); return { strategy: p.strategy, keys: p.keys.map(k => ({ kid: k.kid, suffix: k.suffix, enabled: k.enabled,
      status: !k.enabled ? 'disabled' : k.health.cooldownUntil > t ? 'cooldown' : k.health.lastError && !k.health.lastOk ? 'error' : k.health.lastOk ? 'ok' : 'untested', inFlight: k.inFlight || 0, health: { ...k.health } })) }; },
    healthSnapshot() { return Object.fromEntries([...pools].map(([id, p]) => [id, Object.fromEntries(p.keys.map(k => [k.kid, { ...k.health }]))])); },
  };
}
module.exports = { createKeyPool, retryable, validRouting, STRATEGIES, ROUTING_DEFAULTS, suffixOf };
