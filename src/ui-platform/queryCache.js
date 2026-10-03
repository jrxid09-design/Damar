'use strict';

class QueryCache {
  constructor({ now = () => Date.now(), staleAfterMs = 30000 } = {}) { this.now = now; this.staleAfterMs = staleAfterMs; this.records = new Map(); this.inflight = new Map(); }
  key(query) { return typeof query === 'string' ? query : JSON.stringify(query); }
  get(query) { const record = this.records.get(this.key(query)); if (!record) return null; return { ...record, stale: record.stale || this.now() - record.updatedAt > this.staleAfterMs }; }
  invalidate(query) { if (query === undefined) this.records.clear(); else this.records.delete(this.key(query)); }
  async fetch(query, loader, { force = false } = {}) {
    const key = this.key(query); const cached = this.get(query); if (!force && cached && !cached.stale) return { ...cached, cacheHit: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const work = Promise.resolve().then(loader).then((data) => { const record = { key, data, updatedAt: this.now(), stale: false }; this.records.set(key, record); return { ...record, cacheHit: false }; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work); return work;
  }
}

module.exports = { QueryCache };
