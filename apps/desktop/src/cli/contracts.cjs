'use strict';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const version = value => Number.isSafeInteger(value) && value > 0;
const fields = {
  plan: ['text', 'syntheticData'], approve: ['planId', 'version'], revoke: ['planId', 'version'],
  revise: ['planId', 'version', 'text', 'syntheticData'],
  execute: ['planId', 'version', 'approvalId', 'requestId'], verify: ['planId', 'version'], cancel: ['planId', 'version']
};
function validateRequest(action, body, role) {
  if (!Object.hasOwn(fields, action)) throw Error('UNKNOWN_MUTATION');
  if (role !== (['approve', 'revoke'].includes(action) ? 'owner' : 'requester')) throw Error('ROLE_DENIED');
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join() !== [...fields[action]].sort().join()) throw Error('INVALID_SCHEMA');
  if (action === 'plan' || action === 'revise') {
    if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 4096 || body.syntheticData !== true) throw Error('SYNTHETIC_TEXT_REQUIRED');
  } else if (!id(body.planId) || !version(body.version)) throw Error('INVALID_PLAN_BINDING');
  if(action==='revise'&&(!id(body.planId)||!version(body.version)||body.version===Number.MAX_SAFE_INTEGER))throw Error('INVALID_PLAN_BINDING');
  if (action === 'execute' && (!id(body.approvalId) || !id(body.requestId))) throw Error('INVALID_EXECUTION_BINDING');
  return body;
}
function validateResponse(action, body, request) {
  const data = body?.data;
  if (body?.success !== true || data?.schemaVersion !== 1 || data?.authority !== 'isolated-test') throw Error('OUTCOME_UNKNOWN_HELD');
  if (!id(data.planId) || (request.planId && data.planId !== request.planId) ||
      (action !== 'revoke' && (!version(data.version) || request.version && data.version !== request.version+(action==='revise'?1:0)))) throw Error('OUTCOME_UNKNOWN_HELD');
  const valid = action === 'plan' ? data.status === 'PLANNED' && /^[a-f0-9]{64}$/.test(data.inputDigest) :
    action === 'revise' ? data.status === 'PLANNED' && /^[a-f0-9]{64}$/.test(data.inputDigest) :
    action === 'approve' ? id(data.approvalId) && Number.isSafeInteger(data.expiresAt) :
    action === 'revoke' ? data.revoked === true :
    action === 'execute' ? ['QUEUED', 'WORKING', 'VERIFIED'].includes(data.status) :
    action === 'verify' ? data.status === 'VERIFIED' && data.verified === true && /^[a-f0-9]{64}$/.test(data.result?.sha256) :
    action === 'cancel' ? data.status === 'CANCELLED' : false;
  if (!valid) throw Error('OUTCOME_UNKNOWN_HELD');
  return data;
}
module.exports = { validateRequest, validateResponse };
