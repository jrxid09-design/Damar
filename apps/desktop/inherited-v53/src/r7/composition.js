'use strict';

const crypto = require('node:crypto');
const { createOwnerServer } = require('../r6/ownerService');
const { createEventReview, LIMITS: REVIEW_LIMITS } = require('./eventReview');
const { createSupervisorStore } = require('./supervisorStore');
const { createWatchdog } = require('./watchdog');

function createR7Composition({ statePath, supervisorPath, credentials, staticHandler, provider,
  ownerId = 'isolated-candidate-owner', persistOptIn = false, clock = Date.now,
  monotonicClock = () => Number(process.hrtime.bigint() / 1_000_000n),
  watchdogProgressThresholdMs = 30_000, watchdogScanIntervalMs = 1000 } = {}) {
  const auth = credentials || { requester: process.env.DAMAR_R6_REQUESTER_TOKEN, owner: process.env.DAMAR_R6_OWNER_TOKEN };
  if (!supervisorPath) throw new TypeError('R7 supervisor state path required');
  const capability = Object.freeze({ scope: 'isolated-candidate-owner' });
  const advisories = [];
  const alerts = [];
  const alertKeys = new Map();
  const pendingReviews = new Set();
  const producers = new Map();
  let lastTrigger = null;
  let scanTimer = null;
  let closed = false;
  function pushAlert(value, dedupeKey) {
    const now = monotonicClock();
    for (const [key, at] of alertKeys) if (now >= at && now - at > 300_000) alertKeys.delete(key);
    if (dedupeKey && alertKeys.has(dedupeKey)) return false;
    if (dedupeKey) {
      alertKeys.set(dedupeKey, now);
      if (alertKeys.size > 256) alertKeys.delete(alertKeys.keys().next().value);
    }
    alerts.push(value);
    if (alerts.length > 64) alerts.shift();
    return true;
  }
  const store = createSupervisorStore({ directory: supervisorPath, ownerId,
    capabilityValidator: ({ capability: supplied, phase }) => phase === 'configure' && supplied === capability,
    persistOptIn, clock, onAlert(alert) {
      pushAlert({ code: alert.type || 'supervisor_alert', at: clock() }, `store:${alert.type || 'supervisor_alert'}`);
    } });
  const lease = store.acquire();
  let eventSequence = 0;
  const watchdog = createWatchdog({ progressThresholdMs: watchdogProgressThresholdMs,
    onWarning(warning) { pushAlert({ code: 'watchdog_no_progress', taskId: warning.taskId,
      version: warning.version, status: warning.status, staleForMs: warning.staleForMs, at: clock() },
    `watchdog:${warning.taskId}:${warning.version}:${warning.status}`); }, clock: monotonicClock });
  const review = createEventReview({ store, provider, clock });

  function observeProducerEvent(event) {
    const key = `${event.taskId}:${event.version}`;
    let producer = producers.get(key);
    if (event.type === 'job:start' && !producer) {
      const producerId = `r6:${key}`;
      const capability = watchdog.register({ producerId, taskId: event.taskId, version: event.version });
      producer = { producerId, capability, seq: 0 };
      producers.set(key, producer);
    }
    if (!producer) return;
    const terminal = ['job:terminal', 'job:recovered'].includes(event.type);
    const seq = ++producer.seq;
    producer.capability.heartbeat({ producerId: producer.producerId, taskId: event.taskId,
      version: event.version, seq, status: terminal ? 'terminated' : 'silent',
      monotonicMs: monotonicClock(), progress: true });
    if (terminal) {
      producer.capability.unregister();
      producers.delete(key);
    }
  }

  function receiveCommittedEvent(event) {
    if (closed) return;
    eventSequence = Math.max(eventSequence, event.sequence);
    observeProducerEvent(event);
    // Lifecycle events feed only the zero-token watchdog. They are not review requests.
    if (!['job:terminal', 'job:denied', 'job:recovered', 'job:stalled'].includes(event.type)) return;
    const pending = review.onEvent(event);
    pendingReviews.add(pending);
    void pending.then(result => {
      lastTrigger = { eventId: event.eventId, taskId: event.taskId, version: event.version,
        type: event.type, decision: result.code };
      if (result.ok && result.advisory) advisories.push({ ...result.advisory, billing: result.billing, at: clock() });
      if (result.code && !['off', 'ineligible', 'cooldown', 'concurrency_limit', 'duplicate', 'stale_sequence'].includes(result.code)) {
        pushAlert({ code: result.code, eventId: event.eventId, at: clock() }, `review:${event.eventId}:${result.code}`);
      }
      if (advisories.length > 64) advisories.shift();
    }, () => {
      pushAlert({ code: 'review_failure', eventId: event.eventId, at: clock() }, `review:${event.eventId}:failure`);
    }).finally(() => pendingReviews.delete(pending));
  }

  const { server, service } = createOwnerServer({ statePath, credentials: auth, onEvent: receiveCommittedEvent });
  if (watchdogScanIntervalMs > 0) {
    scanTimer = setInterval(() => watchdog.scan(), watchdogScanIntervalMs);
    scanTimer.unref?.();
  }
  const originalListeners = server.listeners('request');
  server.removeAllListeners('request');

  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify(value));
  }
  function ownerMatches(req) {
    const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    const expected = Buffer.from(`Bearer ${auth.owner || ''}`);
    return supplied.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(supplied, expected);
  }
  function status() {
    const state = store.snapshot();
    const ledger = state.ledger;
    const config = state.config;
    return { schemaVersion: 1, authority: 'isolated-test', enabled: config.state === 'ON', mode: config.policy?.mode || 'EVENT_REVIEW',
      ownerPermission: 'owner-authenticated-only', providerAvailable: typeof provider?.review === 'function', providerKind: provider?.mocked === true ? 'MOCKED' : 'unavailable',
      eventCursor: eventSequence, advisoryCount: advisories.length, advisories: advisories.slice(-16), alerts: alerts.slice(-16),
      budget: { limit: config.budget.maxSpendUnits || 0, estimated: ledger.estimated, reserved: ledger.reserved,
        billedKnown: ledger.billedKnown, billedUnknown: ledger.billedUnknown,
        remaining: Math.max(0, (config.budget.maxSpendUnits || 0) - ledger.reserved - ledger.billedKnown - ledger.billedUnknown),
        inFlight: ledger.reservations.filter(row => row.status === 'INFLIGHT').length },
      heldReviews: ledger.reservations.filter(row => row.status === 'INFLIGHT').map(row => ({ reservationId: row.reservationId, eventId: row.eventId, epoch: row.epoch, createdAt: row.createdAt, maxSpendUnits: row.maxSpendUnits, status: row.status })),
      monitoredJobs: watchdog.snapshot().producers.filter(row => row.active).length,
      lastTrigger, review: review.status(), leaseEpoch: state.lease?.epoch || 0, stopAvailable: true };
  }
  server.on('request', async (req, res) => {
    const host = `127.0.0.1:${req.socket.localPort}`;
    if (req.socket.localAddress !== '127.0.0.1' || req.headers.host !== host ||
        req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'host').length !== 1 ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      return json(res, 403, { success: false, error: 'ORIGIN_DENIED' });
    }
    try {
      if (req.url === '/api/r7/control' && req.method === 'GET') return json(res, 200, status());
      if (req.url?.startsWith('/api/r7/supervisor/')) {
        const action = req.url.slice('/api/r7/supervisor/'.length);
        if (!['status', 'on', 'off', 'activity', 'alerts', 'budget'].includes(action)) return json(res, 404, { success: false, error: 'NOT_IMPLEMENTED' });
        if (action === 'status' && req.method === 'GET') return json(res, 200, { success: true, data: status() });
        if (['activity', 'alerts', 'budget'].includes(action) && req.method === 'GET') {
          const value = status();
          return json(res, 200, { success: true, data: action === 'activity' ? value.advisories : action === 'alerts' ? value.alerts : value.budget });
        }
        if (!ownerMatches(req)) return json(res, 403, { success: false, error: 'OWNER_REQUIRED' });
        if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 405, { success: false, error: 'JSON_POST_REQUIRED' });
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return json(res, 413, { success: false, error: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { success: false, error: 'INVALID_JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { success: false, error: 'INVALID_BODY' });
        if (action === 'off') {
          if (Object.keys(body).length) return json(res, 400, { success: false, error: 'INVALID_BODY' });
          review.ownerState({ role: 'owner', enabled: false });
          await Promise.allSettled([...pendingReviews]);
          store.configure('OFF', capability);
          return json(res, 200, { success: true, data: status() });
        }
        if (action === 'on') {
          const allowed = ['mode', 'maxSpendUnits', 'maxCalls'];
          const mode = body.mode || 'EVENT_REVIEW';
          if (Object.keys(body).some(key => !allowed.includes(key)) || !['EVENT_ONLY', 'EVENT_REVIEW'].includes(mode)) return json(res, 400, { success: false, error: 'INVALID_MODE' });
          if (mode === 'EVENT_ONLY') {
            if ((body.maxSpendUnits !== undefined && body.maxSpendUnits !== 0) || (body.maxCalls !== undefined && body.maxCalls !== 0)) return json(res, 400, { success: false, error: 'EVENT_ONLY_REQUIRES_ZERO_MODEL_BUDGET' });
            review.ownerState({ role: 'owner', enabled: false });
            await Promise.allSettled([...pendingReviews]);
          } else {
            if (!Number.isSafeInteger(body.maxSpendUnits) || body.maxSpendUnits < 1 || body.maxSpendUnits > 1000 ||
                !Number.isSafeInteger(body.maxCalls) || body.maxCalls < 1 || body.maxCalls > 3) return json(res, 400, { success: false, error: 'FINITE_BUDGET_REQUIRED' });
            const enabled = review.ownerState({ role: 'owner', enabled: true });
            if (!enabled.ok) return json(res, 409, { success: false, error: enabled.code });
          }
          try {
            const maxSpendUnits = mode === 'EVENT_ONLY' ? 0 : body.maxSpendUnits;
            const maxCalls = mode === 'EVENT_ONLY' ? 0 : body.maxCalls;
            store.configure('ON', capability, { policy: { mode, level2: false }, budget: {
              maxSpendUnits, maxCalls, maxInputTokens: REVIEW_LIMITS.inputTokens,
              maxOutputTokens: REVIEW_LIMITS.outputTokens, maxPerHourCalls: maxCalls, maxPerDayCalls: maxCalls,
              maxPerHourSpendUnits: maxSpendUnits, maxPerDaySpendUnits: maxSpendUnits } });
            return json(res, 200, { success: true, data: status() });
          } catch { review.ownerState({ role: 'owner', enabled: false }); return json(res, 409, { success: false, error: 'CONFIGURATION_FAILED' }); }
        }
      }
      if (staticHandler && await staticHandler(req, res)) return;
      for (const listener of originalListeners) await listener(req, res);
    } catch (error) {
      if (!res.headersSent) json(res, 503, { success: false, error: error.code || 'R7_UNAVAILABLE' });
      else res.end();
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    if (scanTimer) clearInterval(scanTimer);
    review.close(); watchdog.shutdown(); producers.clear(); service.close();
    try { lease.release(); } catch { alerts.push({ code: 'leader_release_uncertain', at: clock() }); }
  }
  server.once('close', close);
  return { server, service, review, store, watchdog, status, close };
}

module.exports = { createR7Composition };
