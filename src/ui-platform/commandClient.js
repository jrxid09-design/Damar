'use strict';
const { COMMAND_KINDS, requiredString } = require('./contracts');

class CommandClient {
  constructor(api) { this.api = api; }
  async send({ kind, operation, target, payload = {}, idempotencyKey = null, signal } = {}) {
    if (!COMMAND_KINDS.includes(kind)) throw new TypeError(`invalid command kind: ${kind}`);
    requiredString(operation, 'operation');
    const request = { kind, operation, target: target ?? null, payload, idempotencyKey };
    return this.api.request('/api/ui/commands', { method: 'POST', body: request, signal });
  }
  async decideApproval({ approvalId, decision, reason = null, signal }) { return this.send({ kind: 'APPROVAL_DECISION', operation: 'approval.decide', target: { approval_id: requiredString(approvalId, 'approvalId') }, payload: { decision, reason }, signal }); }
}

module.exports = { CommandClient };
