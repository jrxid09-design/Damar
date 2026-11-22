'use strict';

function projectControl(snapshot) {
  if (!snapshot || snapshot.authority !== 'isolated-test' || snapshot.schemaVersion !== 1) {
    throw new TypeError('ISOLATED_STATE_PROVENANCE_REQUIRED');
  }
  if (snapshot.available === false) throw new TypeError('ISOLATED_STATE_UNAVAILABLE');
  const rows = value => Array.isArray(value) ? value.slice(-100) : [];
  return {
    schema: 'damar.control.isolated.v1', authority: 'isolated-test', productionAuthority: false,
    plans: rows(snapshot.plans).map(plan => ({ id: plan.planId, version: plan.version,
      operation: 'sha256-text', expiresAt: plan.expiresAt,
      status: plan.status || (plan.expired ? 'EXPIRED' : rows(snapshot.executions).some(e => e.planId === plan.planId) ? 'EXECUTED_VERIFIED' :
        rows(snapshot.approvals).some(a => a.planId === plan.planId && !a.revoked && !a.expired) ? 'APPROVED' : 'PLANNED') })),
    approvals: rows(snapshot.approvals).map(item => ({ planId: item.planId, version: item.version,
      status: item.status || (item.revoked ? 'REVOKED' : item.expired ? 'EXPIRED' : item.consumed ? 'CONSUMED' : 'APPROVED'), expiresAt: item.expiresAt })),
    executions: rows(snapshot.executions).map(item => ({ planId: item.planId, version: item.version,
      status: item.status || item.outcome, digest: item.digest || item.result?.sha256, verified: item.verified === true || item.outcome === 'EXECUTED_VERIFIED' })),
    events: rows(snapshot.events).map(item => ({ eventId: item.eventId, type: item.type,
      planId: item.planId, version: item.version || item.taskVersion, at: item.at })),
    flags: { werkudaraSupervisor: false, physicalHid: false, canonicalAuthority: false },
    providers: { status: 'UNVERIFIED', reason: 'Gateway has not been queried by this read model' }
  };
}

module.exports = { projectControl };
