'use strict';

class QueryCache {
  constructor({ now = () => Date.now(), staleAfterMs = 30000, maxEntries = 100 } = {}) { this.now = now; this.staleAfterMs = staleAfterMs; this.maxEntries = maxEntries; this.records = new Map(); this.inflight = new Map(); }
  key(query) { return typeof query === 'string' ? query : JSON.stringify(query); }
  get(query) { const record = this.records.get(this.key(query)); if (!record) return null; return { ...record, stale: record.stale || this.now() - record.updatedAt > this.staleAfterMs }; }
  invalidate(query) { if (query === undefined) this.records.clear(); else this.records.delete(this.key(query)); }
  async fetch(query, loader, { force = false, signal } = {}) {
    const key = this.key(query); const cached = this.get(query); if (!force && cached && !cached.stale) return { ...cached, cacheHit: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const controller = new AbortController(); if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const work = Promise.resolve().then(() => { if (controller.signal.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' }); return loader({ signal: controller.signal }); }).then((data) => { const record = { key, data, updatedAt: this.now(), stale: false }; this.records.set(key, record); while (this.records.size > this.maxEntries) this.records.delete(this.records.keys().next().value); return { ...record, cacheHit: false }; }).catch((error) => { if (error.name !== 'AbortError') this.records.set(key, { key, data: null, updatedAt: this.now(), stale: true, error }); throw error; }).finally(() => this.inflight.delete(key));
    work.controller = controller;
    this.inflight.set(key, work); return work;
  }
  cancel(query) { const key = this.key(query); const work = this.inflight.get(key); if (work?.controller) work.controller.abort(); return Boolean(work); }
}

module.exports = { QueryCache };
