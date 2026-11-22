'use strict';
class QueryCache {
  constructor({ now = () => Date.now(), staleAfterMs = 30000, maxEntries = 100, failedTtlMs = 5000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(failedTtlMs) || failedTtlMs < 0) throw new TypeError('invalid cache bounds');
    Object.assign(this, { now, staleAfterMs, maxEntries, failedTtlMs }); this.records = new Map(); this.inflight = new Map();
  }
  key(query) { return typeof query === 'string' ? query : JSON.stringify(query); }
  prune() { for (const [key, record] of this.records) if (record.error && this.now() - record.updatedAt >= this.failedTtlMs) this.records.delete(key); }
  store(key, record) {
    this.prune(); this.records.delete(key); this.records.set(key, record);
    while (this.records.size > this.maxEntries) {
      // Prefer evicting failures so a failure storm cannot displace successes.
      const failed = [...this.records].find(([, value]) => value.error);
      this.records.delete(failed ? failed[0] : this.records.keys().next().value);
    }
  }
  get(query) { this.prune(); const record = this.records.get(this.key(query)); if (!record) return null; return { ...record, stale: record.stale || this.now() - record.updatedAt > this.staleAfterMs }; }
  invalidate(query) { if (query === undefined) this.records.clear(); else this.records.delete(this.key(query)); }
  async fetch(query, loader, { force = false, signal } = {}) {
    const key = this.key(query); const cached = this.get(query); if (!force && cached && !cached.stale) return { ...cached, cacheHit: true };
    if (signal?.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' });
    if (this.inflight.has(key)) return this.consume(key, this.inflight.get(key), signal);
    const controller = new AbortController();
    const eligible = () => !controller.signal.aborted && this.inflight.get(key) === work;
    const work = Promise.resolve().then(() => { if (controller.signal.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' }); return loader({ signal: controller.signal }); }).then((data) => {
      if (!eligible()) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' });
      const record = { key, data, updatedAt: this.now(), stale: false }; this.store(key, record); return { ...record, cacheHit: false };
    }).catch((error) => { if (eligible() && error.name !== 'AbortError') this.store(key, { key, data: null, updatedAt: this.now(), stale: true, error }); throw error; }).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); });
    work.controller = controller; work.consumers = new Set(); this.inflight.set(key, work); return this.consume(key, work, signal);
  }
  consume(key, work, signal) {
    // Caller cancellation releases only this consumer. The final consumer ends
    // shared commit authority; cancel(query) explicitly ends all consumers.
    return new Promise((resolve, reject) => {
      let active = true;
      const cleanup = () => { active = false; signal?.removeEventListener('abort', cancel); work.consumers.delete(cancel); };
      const cancel = () => {
        if (!active) return;
        cleanup(); reject(Object.assign(new Error('query cancelled'), { name: 'AbortError' }));
        if (!work.consumers.size) { work.controller.abort(); if (this.inflight.get(key) === work) this.inflight.delete(key); }
      };
      work.consumers.add(cancel); signal?.addEventListener('abort', cancel, { once: true });
      work.then(value => { if (active) { cleanup(); resolve(value); } }, error => { if (active) { cleanup(); reject(error); } });
    });
  }
  cancel(query) {
    const key = this.key(query), work = this.inflight.get(key);
    if (work) { work.controller.abort(); this.inflight.delete(key); for (const cancel of [...work.consumers]) cancel(); }
    return Boolean(work);
  }
}
module.exports = { QueryCache };
