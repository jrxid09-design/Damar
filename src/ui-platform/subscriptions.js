'use strict';

class SubscriptionManager {
  constructor({ readModelClient, onUpdate = () => {}, onStatus = () => {}, maxReconnects = 3 } = {}) { this.readModelClient = readModelClient; this.onUpdate = onUpdate; this.onStatus = onStatus; this.maxReconnects = maxReconnects; this.closed = false; this.lastRevision = null; }
  attach({ snapshot, stream, apply = (value) => value } = {}) {
    const controller = new AbortController(); this.closed = false;
    const start = async () => { this.onStatus('snapshot_loading'); const initial = await snapshot(); this.lastRevision = initial.revision ?? null; this.onUpdate(initial, { source: 'snapshot' }); this.onStatus('connected');
      if (!stream) return;
      try { for await (const event of stream({ signal: controller.signal, after: this.lastRevision })) { if (this.closed) break; const revision = event.revision ?? null; if (revision && this.lastRevision && revision <= this.lastRevision) continue; if (event.gap) { this.onStatus('resync_required'); const fresh = await snapshot(); this.lastRevision = fresh.revision ?? null; this.onUpdate(fresh, { source: 'resync' }); continue; } this.lastRevision = revision ?? this.lastRevision; this.onUpdate(apply(event, this.lastRevision), { source: 'stream' }); } }
      catch (error) { if (!this.closed) this.onStatus('disconnected', error); }
    };
    start(); return () => { this.closed = true; controller.abort(); this.onStatus('closed'); };
  }
}

module.exports = { SubscriptionManager };
