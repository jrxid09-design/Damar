'use strict';
class SubscriptionManager {
  constructor({ readModelClient, onUpdate = () => {}, onStatus = () => {}, maxReconnects = 3 } = {}) {
    Object.assign(this, { readModelClient, onUpdate, onStatus, maxReconnects });
    this.closed = true; this.lastRevision = null; this.disposeActive = null;
  }
  attach({ snapshot, stream, apply = (value) => value } = {}) {
    this.disposeActive?.();
    const controller = new AbortController(); let active = true; let timer = null; let finishDelay = null; let revision = null;
    this.closed = false;
    const status = (...args) => { if (active) this.onStatus(...args); };
    const publish = (value, source) => { if (!active) return; revision = value.revision ?? revision; this.lastRevision = revision; this.onUpdate(value, { source }); };
    const dispose = () => {
      if (!active) return;
      active = false; controller.abort(); clearTimeout(timer); finishDelay?.();
      if (this.disposeActive === dispose) { this.closed = true; this.disposeActive = null; }
    };
    this.disposeActive = dispose;
    const start = async () => {
      status('snapshot_loading'); if (!active) return;
      const initial = await snapshot({ signal: controller.signal }); if (!active) return;
      publish(initial, 'snapshot'); status('connected'); if (!active || !stream) return;
      let reconnects = 0;
      while (active) {
        try {
          for await (const event of stream({ signal: controller.signal, after: revision })) {
            if (!active) break;
            if (event.revision && revision && event.revision <= revision) continue;
            if (event.gap) {
              status('resync_required'); if (!active) break;
              const fresh = await snapshot({ signal: controller.signal }); if (!active) break;
              publish(fresh, 'resync'); continue;
            }
            const next = event.revision ?? revision;
            const value = apply(event, next); if (!active) break;
            revision = next; this.lastRevision = next; publish(value, 'stream');
          }
          break;
        } catch (error) {
          if (!active) break;
          status('disconnected', error); if (!active) break;
          if (++reconnects > this.maxReconnects) { status('failed', error); break; }
          status('reconnecting', { attempt: reconnects }); if (!active) break;
          await new Promise((resolve) => { finishDelay = resolve; timer = setTimeout(resolve, Math.min(1000 * reconnects, 3000)); });
          timer = null; finishDelay = null;
        }
      }
    };
    start().catch((error) => status('failed', error));
    return dispose;
  }
}
module.exports = { SubscriptionManager };
