'use strict';
const { performance } = require('node:perf_hooks');
class InterruptController {
  constructor({ acknowledge, dispatch, escalate, now = () => performance.now(), windowMs = 700 }) {
    if (!Number.isFinite(windowMs) || windowMs < 100 || windowMs > 1500) throw Error('INVALID_ESC_WINDOW');
    Object.assign(this, { acknowledge, dispatch, escalate, now, windowMs });
    this.state = 'IDLE'; this.operation = null; this.first = null; this.escalated = false;
  }
  start({ id, kind }) {
    if (this.operation || !['read', 'remote-mutation', 'owned-local'].includes(kind) || typeof id !== 'string' || !id) throw Error('INVALID_OPERATION_TRANSITION');
    this.operation = { id, kind }; this.state = 'RUNNING'; this.first = null; this.escalated = false;
  }
  escape({ repeat = false } = {}) {
    if (!this.operation) return { action: 'EDITOR_ONLY', state: this.state };
    const at = this.now();
    if (this.first === null) {
      this.first = at; this.state = 'INTERRUPT_REQUESTED';
      this.acknowledge({ operationId: this.operation.id, at, state: this.state });
      // Visible acknowledgement precedes dispatch and never waits for downstream cancellation.
      this.state = 'CANCELLING';
      const operation = this.operation;
      try {
        Promise.resolve(this.dispatch(operation)).catch(() => { if (this.operation === operation) this.unknown(operation.id); });
      } catch { if (this.operation === operation) this.unknown(operation.id); }
      return { action: 'DISPATCH', state: this.state };
    }
    if (!repeat && at - this.first <= this.windowMs && !this.escalated && this.operation.kind === 'owned-local') {
      this.escalated = true;
      const operation = this.operation;
      try { Promise.resolve(this.escalate(operation)).catch(() => { if (this.operation === operation) this.unknown(operation.id); }); }
      catch { if (this.operation === operation) this.unknown(operation.id); }
      return { action: 'ESCALATE_OWNED_ONLY', state: this.state };
    }
    return { action: 'IDEMPOTENT', state: this.state };
  }
  unknown(id) { if (this.operation && (id === undefined || this.operation.id === id)) this.state = 'OUTCOME_UNKNOWN_HELD'; }
  confirm(id, outcome) {
    if (!this.operation || this.operation.id !== id || !['CANCELLED_CONFIRMED', 'COMPLETED', 'FAILED'].includes(outcome)) throw Error('AUTHORITATIVE_CONFIRMATION_REQUIRED');
    this.state = outcome; this.operation = null;
  }
}
module.exports = { InterruptController };
