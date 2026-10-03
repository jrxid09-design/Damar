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
    if (this.inflight.has(key)) return this.inflight.get(key);
    const controller = new AbortController(); const forwardAbort = () => controller.abort();
    if (signal?.aborted) forwardAbort(); else signal?.addEventListener('abort', forwardAbort, { once: true });
    const work = Promise.resolve().then(() => { if (controller.signal.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' }); return loader({ signal: controller.signal }); }).then((data) => {
      if (controller.signal.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' });
      const record = { key, data, updatedAt: this.now(), stale: false }; this.store(key, record); return { ...record, cacheHit: false };
    }).catch((error) => { if (error.name !== 'AbortError') this.store(key, { key, data: null, updatedAt: this.now(), stale: true, error }); throw error; }).finally(() => { signal?.removeEventListener('abort', forwardAbort); this.inflight.delete(key); });
    work.controller = controller; work.cleanup = () => signal?.removeEventListener('abort', forwardAbort); this.inflight.set(key, work); return work;
  }
  cancel(query) { const work = this.inflight.get(this.key(query)); if (work?.controller) { work.controller.abort(); work.cleanup(); } return Boolean(work); }
}
module.exports = { QueryCache };
