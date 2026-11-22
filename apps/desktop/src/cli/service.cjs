'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateRequest, validateResponse } = require('./contracts.cjs');
const { IntentStore } = require('./intents.cjs');
const endpoint = require('./core-endpoint.cjs').coreEndpoint();
// Same public code as before; `reason` records which failure it was (deadline, caller abort, refused, bad body) so a
// "Core did not answer" report can be diagnosed instead of guessed.
function unavailable(error, signal, ms) {
  const reason = signal?.aborted ? 'CALLER_ABORTED' : error?.name === 'TimeoutError' ? 'TIMEOUT_' + ms + 'MS' : error?.cause?.code || error?.message || error?.name || 'UNKNOWN';
  return Object.assign(Error('SERVICE_RESPONSE_UNAVAILABLE'), { reason: String(reason).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) });
}
async function boundedResponse(response){
  let text;
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1024*1024){await reader.cancel();throw Error('RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(value));}text=Buffer.concat(chunks).toString('utf8');}
    finally{reader.releaseLock();}
  }else if(response.text){text=await response.text();if(Buffer.byteLength(text)>1024*1024)throw Error('RESPONSE_TOO_LARGE');}
  else {const body=await response.json();if(Buffer.byteLength(JSON.stringify(body))>1024*1024)throw Error('RESPONSE_TOO_LARGE');return body;}
  try{return JSON.parse(text);}catch{if(response.ok)throw Error('MALFORMED_SUCCESS_RESPONSE');return null;}
}
class ServiceClient {
  constructor({ sessionDirectory, intentDirectory, transport = fetch }) {
    if (!path.isAbsolute(sessionDirectory)) throw Error('EXPLICIT_PRIVATE_SESSION_REQUIRED');
    const descriptor = JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'session.json'), 'utf8'));
    if (descriptor.address !== endpoint) throw Error('SESSION_ENDPOINT_MISMATCH');
    this.sessionDirectory = sessionDirectory;
    this.sessionId = crypto.createHash('sha256').update(path.resolve(sessionDirectory).toLowerCase()).digest('hex');
    this.intents = new IntentStore(intentDirectory); this.transport = transport;
    this.grants = new Map();
  }
  async request(route, { method = 'GET', role = 'requester', body, signal } = {}) {
    const readRoutes=['/api/r6/state','/api/v1/console/mcp/servers','/api/v1/console/plugins'];
    const mutation=/^\/api\/r6\/(plan|revise|approve|revoke|execute|verify|cancel)$/.exec(route);
    if(!(method==='GET'&&readRoutes.includes(route)&&body===undefined||method==='POST'&&mutation))throw Error('SERVICE_ROUTE_DENIED');
    if(mutation)validateRequest(mutation[1],body,role);
    if (!['requester', 'owner'].includes(role)) throw Error('ROLE_DENIED');
    const credentials = JSON.parse(fs.readFileSync(path.join(this.sessionDirectory, 'credentials.json'), 'utf8'));
    const token = credentials[role];
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error('INVALID_PRIVATE_CREDENTIAL');
    let response;
    try {
      response = await this.transport(endpoint + route, { method, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
       const responseBody=await boundedResponse(response);
       return { ok: response.ok, status: response.status, body:responseBody };
    } catch (error) { throw unavailable(error, signal, 4000); }
  }
  // Core Pandawa/usage/provider contract. Reads: requester. Mutations: explicit owner role only, exact routes.
  async r9(route, { method = 'GET', role = 'requester', body, signal } = {}) {
    const reads = ['/api/r9/sandbox', '/api/r9/pandawa/runs', '/api/r9/pandawa/runs?cliSession=' + this.sessionId, '/api/r9/provider', '/api/r9/usage?cliSession=' + this.sessionId, '/api/r9/sessions', '/api/r9/lifecycle', '/api/r9/cli/settings', '/api/r9/pandawa/discussions'];
    const posts = /^\/api\/r9\/(?:pandawa\/runs|pandawa\/runs\/run_[a-f0-9]{32}\/cancel|provider|connect|settings|lifecycle\/restart|turns|turns\/interrupted|checkpoints|memory|turns\/turn-[a-f0-9-]{36}\/(?:permission|cancel)|pandawa\/discussions|pandawa\/discussions\/disc_[a-f0-9]{32}\/(?:interject|cancel))$/;
    // Session history is the operator's own record, not a privileged mutation: the requester credential journals it.
    const sessionPost = /^\/api\/r9\/sessions(?:\/[a-f0-9]{64}\/(?:attach|events|close))?$/.test(route);
    const readOk = reads.includes(route) || /^\/api\/r9\/models\?provider=[a-z0-9-]{1,32}$/.test(route) || /^\/api\/r9\/sessions\/[a-f0-9]{64}$/.test(route) || /^\/api\/r9\/turns\/turn-[a-f0-9-]{36}$/.test(route) || /^\/api\/r9\/pandawa\/discussions\/disc_[a-f0-9]{32}$/.test(route);
    if (!(method === 'GET' && readOk && body === undefined || method === 'POST' && (posts.test(route) || sessionPost) && body && typeof body === 'object' && !Array.isArray(body))) throw Error('SERVICE_ROUTE_DENIED');
    if (method === 'POST' && !sessionPost && role !== 'owner' || !['requester', 'owner'].includes(role)) throw Error('ROLE_DENIED');
    const token = JSON.parse(fs.readFileSync(path.join(this.sessionDirectory, 'credentials.json'), 'utf8'))[role];
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error('INVALID_PRIVATE_CREDENTIAL');
    // Provider metadata can take a few seconds on a cold gateway (Core waits up to 8 s); allow 10 s for those routes.
    const ms = /^\/api\/r9\/(?:connect|provider|models)/.test(route) ? 10000 : 4000;
    try {
      const response = await this.transport(endpoint + route, { method, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { ok: response.ok, status: response.status, body: await boundedResponse(response) };
    } catch (error) { throw unavailable(error, signal, ms); }
  }
  // Live events of one agent turn (server-sent events, Owner credential). Calls onEvent exactly once per event, in seq
  // order, and resolves on the final event. The connection is not trusted to survive: when it breaks (reset, idle
  // close, Core restart) the client asks Core for the turn's status and resumes the stream from the next event
  // (?from=N); events already delivered are never delivered twice (so no permission card is shown twice and nothing is
  // re-run: Core keeps executing the turn independently of this connection). If Core restarted and the turn ended, the
  // final result comes from Core's durable journal (`recovered: true`). Gives up after MAX_RECONNECTS attempts in a row
  // without progress (TURN_STREAM_LOST); `signal` only stops the waiting between attempts (Esc during a reconnect).
  async turnEvents(turnId, onEvent, { from = 0, signal, onReconnect } = {}) {
    if (!/^turn-[a-f0-9-]{36}$/.test(turnId) || !Number.isSafeInteger(from) || from < 0) throw Error('SERVICE_ROUTE_DENIED');
    const MAX_RECONNECTS = 8, FATAL = new Set(['TURN_EVENT_MALFORMED', 'TURN_EVENT_TOO_LARGE', 'SERVICE_ROUTE_DENIED', 'INVALID_PRIVATE_CREDENTIAL']);
    let next = from, failures = 0, lastError = null;
    const deliver = async event => { if (event.seq < next) return; next = event.seq + 1; failures = 0; await onEvent(event); };
    for (;;) {
      try {
        const final = await this.streamOnce(turnId, next, deliver);
        if (final) return final;
        lastError = 'TURN_STREAM_ENDED';
      } catch (error) {
        if (FATAL.has(error.message)) throw error;
        lastError = error.message === 'SERVICE_RESPONSE_UNAVAILABLE' && error.reason ? error.reason : error.message;
      }
      if (signal?.aborted) throw unavailable(Error('aborted'), signal, 0);
      // Reconcile with Core: did the turn end while the stream was down?
      try {
        const r = await this.r9(`/api/r9/turns/${turnId}`, { role: 'owner', signal });
        // Only Core's own answer means the turn is unknown (a starting or foreign server's 404 is retried).
        if (r.status === 404 && r.body?.error === 'TURN_NOT_FOUND') throw Object.assign(Error('TURN_LOST'), { reason: lastError });
        const status = r.ok ? r.body?.data : null;
        if (status && status.live === false && status.final) {
          const final = { ...status.final, seq: next, recovered: true };
          await onEvent(final); return final;
        }
      } catch (error) { if (error.message === 'TURN_LOST' || signal?.aborted) throw error; }
      failures++;
      if (failures > MAX_RECONNECTS) throw Object.assign(Error('TURN_STREAM_LOST'), { reason: String(lastError).slice(0, 40) });
      onReconnect?.({ attempt: failures, of: MAX_RECONNECTS, reason: lastError });
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(4000, 250 * 2 ** (failures - 1)));
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(unavailable(Error('aborted'), signal, 0)); }, { once: true });
      });
    }
  }
  // One SSE connection from `from`: delivers events in order; returns the final event, or null if the stream ended
  // without one. Bounded: 256 KiB per event; heartbeat comments (": hb") keep the connection active and are ignored.
  async streamOnce(turnId, from, onEvent, route = `/api/r9/turns/${turnId}/events`) {
    const token = JSON.parse(fs.readFileSync(path.join(this.sessionDirectory, 'credentials.json'), 'utf8')).owner;
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error('INVALID_PRIVATE_CREDENTIAL');
    let response;
    try { response = await this.transport(`${endpoint}${route}?from=${from}`, { redirect: 'error', headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' } }); }
    catch (error) { throw unavailable(error, null, 0); }
    if (response.status === 404) throw Object.assign(Error('TURN_EVENTS_NOT_FOUND'), { status: 404 });
    if (!response.ok || !/^text\/event-stream/.test(response.headers.get('content-type') || '')) throw Error('TURN_EVENTS_UNAVAILABLE');
    const decoder = new TextDecoder(); let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 262144 && buffer.indexOf('\n\n') < 0) throw Error('TURN_EVENT_TOO_LARGE');
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
          let event; try { event = JSON.parse(line.slice(6)); } catch { throw Error('TURN_EVENT_MALFORMED'); }
          if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) throw Error('TURN_EVENT_MALFORMED');
          await onEvent(event);
          if (event.type === 'final') return event;
        }
      }
    } catch (error) {
      if (['TURN_EVENT_MALFORMED', 'TURN_EVENT_TOO_LARGE'].includes(error.message)) throw error;
      throw Object.assign(Error('TURN_STREAM_INTERRUPTED'), { reason: error.cause?.code || error.name });
    }
    return null;
  }
  // Live events of one Pandawa discussion (same SSE contract and bounds as turns). A broken stream resumes from the next
  // event a few times; then the discussion's durable record is read so the final state is still reported.
  async discussionEvents(id, onEvent, { signal } = {}) {
    if (!/^disc_[a-f0-9]{32}$/.test(id)) throw Error('SERVICE_ROUTE_DENIED');
    let next = 0;
    const deliver = async e => { if (e.seq < next) return; next = e.seq + 1; await onEvent(e); };
    for (let attempt = 0; attempt < 4; attempt++) {
      try { const final = await this.streamOnce(id, next, deliver, `/api/r9/pandawa/discussions/${id}/events`); if (final) return final; }
      catch (error) { if (['TURN_EVENT_MALFORMED', 'TURN_EVENT_TOO_LARGE', 'INVALID_PRIVATE_CREDENTIAL'].includes(error.message)) throw error; }
      if (signal?.aborted) break;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
    const r = await this.r9(`/api/r9/pandawa/discussions/${id}`, { role: 'owner' });
    const events = r.ok ? r.body?.data?.events || [] : [];
    for (const e of events) await deliver(e);
    return events.find(e => e.type === 'final') || null;
  }
  async usage(signal) {
    const r = await this.r9('/api/r9/usage?cliSession=' + this.sessionId, { signal });
    const d = r.body?.data;
    const n = v => Number.isSafeInteger(v) && v >= 0;
    if (!r.ok || r.body?.success !== true || d?.source !== 'core-durable-receipts' || d.cliSession !== this.sessionId || ![d.inputTokens, d.outputTokens, d.totalTokens, d.confirmedReceipts, d.unknownUsageReceipts].every(n)) throw Error('UNRECOGNIZED_USAGE_READBACK');
    return { source: d.source, scope: 'private session (Core durable receipts)', inputTokens: d.inputTokens, outputTokens: d.outputTokens, totalTokens: d.totalTokens,
      confirmedReceipts: d.confirmedReceipts, unknownUsageReceipts: d.unknownUsageReceipts, attemptsWithoutUsage: d.attemptsWithoutUsage, pendingRuns: d.pendingRuns,
      unknownOutcomeRuns: d.unknownOutcomeRuns, complete: d.complete === true, byProvider: d.byProvider, estimated: false, cost: d.cost,
      ...(Object.keys(d.byProvider || {}).length ? { modelLabel: 'offline fixture ' + String(Object.keys(d.byProvider).at(-1).split('/')[1]).slice(0, 32) } : {}) };
  }
  async identity(signal) {
    let response;
    try { response = await this.transport(endpoint + '/api/r7r3/overview', { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000), redirect: 'error' }); }
    catch { throw Error('RUNTIME_OFFLINE'); }
    let body;
    try { body = await boundedResponse(response); } catch { throw Error('UNRECOGNIZED_RUNTIME'); }
    if (!response.ok || body.connection !== 'online' || typeof body.runtimeInstanceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(body.runtimeInstanceId)) throw Error('UNRECOGNIZED_RUNTIME');
    return body.runtimeInstanceId;
  }
  async state(signal) {
    const result = await this.request('/api/r6/state', { signal });
    const data = result.body?.data;
    if (!result.ok || result.body?.success !== true || data?.authority !== 'isolated-test' ||
        !Array.isArray(data.plans) || !Array.isArray(data.jobs)) throw Error('UNRECOGNIZED_STATE');
    return data;
  }
  async mutate(action, input, { role = 'requester', signal } = {}) {
    // Caller must explicitly select owner role; there is no role retry or automatic elevation.
    const body = validateRequest(action, input, role);
    const runtimeId = await this.identity(signal);
    const before = await this.state(signal);
    if (signal?.aborted) throw Error('CANCELLED_BEFORE_DISPATCH');
    const intent = this.intents.begin({ sessionId: this.sessionId, runtimeId, action });
    try {
      const binding = { operationId: intent.operationId, runtimeId, sessionId: this.sessionId, action,
        ...(action === 'plan' ? { inputDigest: crypto.createHash('sha256').update(body.text).digest('hex'),
          priorPlanIds: before.plans.map(plan => plan.planId) } : { planId: body.planId, version: body.version }),
          ...(action==='revise'?{inputDigest:crypto.createHash('sha256').update(body.text).digest('hex')}:{} ) };
      const directory = path.join(this.intents.directory, 'bindings');
      fs.mkdirSync(directory, { recursive: true });
      const fd = fs.openSync(path.join(directory, intent.operationId + '.json'), 'wx');
       try { fs.writeFileSync(fd, JSON.stringify(binding)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
       // An uncertain invalidation must not leave a stale executable local grant.
       if(['revise','revoke','cancel'].includes(action))this.grants.delete(body.planId);
      const response = await this.request('/api/r6/' + action, { method: 'POST', role, body, signal });
      if (!response.ok) return { state: 'OUTCOME_UNKNOWN_HELD', operationId: intent.operationId, reason: 'AUTHORITATIVE_RECONCILIATION_REQUIRED', httpStatus: response.status };
      const data = validateResponse(action, response.body, body);
      const safe = { ...data }; delete safe.approvalId;
      // An action-specific valid response proves receipt only in the same runtime incarnation.
      // If the service restarted between dispatch and readback, retain the uncertain operation.
      const afterRuntime = await this.identity(signal);
      if (afterRuntime !== runtimeId) throw Error('RUNTIME_CHANGED_HOLD_REQUIRED');
      this.intents.acknowledge(intent.operationId, { runtimeId, action });
      if (action === 'approve') this.grants.set(data.planId, { approvalId: data.approvalId, expiresAt: data.expiresAt, runtimeId });
       if (action === 'revoke' || action === 'cancel' || action === 'revise') this.grants.delete(body.planId);
      return { state: 'ACKNOWLEDGED', operationId: intent.operationId, data: safe };
    } catch {
      return { state: 'OUTCOME_UNKNOWN_HELD', operationId: intent.operationId, reason: 'RESPONSE_NOT_AUTHORITATIVELY_CONFIRMED' };
    }
  }
  async reconcile(operationId, { signal } = {}) {
    const record = this.intents.list().find(item => item.operationId === operationId);
    if (!record || record.sessionId !== this.sessionId) throw Error('INTENT_SESSION_MISMATCH');
    const runtimeId = await this.identity(signal);
    if (runtimeId !== record.runtimeId) return { state: 'OUTCOME_UNKNOWN_HELD', reason: 'RUNTIME_CHANGED', operationId };
    let binding;
    try { binding = JSON.parse(fs.readFileSync(path.join(this.intents.directory, 'bindings', operationId + '.json'), 'utf8')); }
    catch { throw Error('MISSING_BINDING_HOLD_REQUIRED'); }
    if (binding.operationId !== operationId || binding.runtimeId !== runtimeId || binding.sessionId !== this.sessionId || binding.action !== record.action)
      throw Error('INTENT_BINDING_MISMATCH');
    const state = await this.state(signal);
    // Plan readbacks omit input digests. A lost plan response cannot be matched safely by count or age.
     if (record.action === 'plan') return { state: 'OUTCOME_UNKNOWN_HELD', operationId, reason: 'PLAN_RESPONSE_LOST_UNCORRELATABLE_NO_REPLAY' };
     if(record.action==='revise')return {state:'OUTCOME_UNKNOWN_HELD',operationId,reason:'REVISION_DIGEST_ABSENT_FROM_READBACK_NO_REPLAY'};
    const plan = state.plans.find(item => item.planId === binding.planId && item.version === binding.version);
    const approval = state.approvals?.find(item => item.planId === binding.planId && item.version === binding.version);
    const confirmed = plan && (
      record.action === 'execute' && ['QUEUED', 'WORKING', 'VERIFIED', 'FAILED'].includes(plan.status) && plan.jobId === plan.planId ||
      record.action === 'verify' && plan.status === 'VERIFIED' && /^[a-f0-9]{64}$/.test(plan.result?.sha256) ||
      record.action === 'cancel' && plan.status === 'CANCELLED' ||
      record.action === 'approve' && approval && !approval.revoked ||
      record.action === 'revoke' && approval?.revoked === true);
    if (!confirmed) return { state: 'OUTCOME_UNKNOWN_HELD', operationId, reason: 'NO_ACTION_SPECIFIC_CONFIRMATION' };
    if (await this.identity(signal) !== runtimeId) return { state: 'OUTCOME_UNKNOWN_HELD', operationId, reason: 'RUNTIME_CHANGED' };
    this.intents.acknowledge(operationId, { runtimeId, action: record.action });
    return { state: 'RECONCILED', operationId, observedStatus: plan.status,
      ...(record.action === 'approve' ? { grant: 'NOT_RECOVERABLE_FROM_READBACK_REVOKE_AND_REAPPROVE_REQUIRED' } : {}) };
  }
}
module.exports = { ServiceClient, endpoint, boundedResponse };
