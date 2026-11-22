'use strict';

const SOURCE = 'damar.r6.jobs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['job:terminal', 'job:denied', 'job:recovered', 'job:stalled']);
const DENIAL_WINDOW_MS = 5 * 60 * 1000;
const DENIAL_THRESHOLD = 2;
const REVIEW_TIMEOUT_MS = 5000;
const LIMITS = Object.freeze({ callsRun: 3, callsHour: 3, callsDay: 3, inputTokens: 1200,
  outputTokens: 240, spendUnits: 1, concurrency: 1, cooldownMs: 1000 });
const METRIC_KEYS = ['active', 'queued', 'verified', 'failed', 'cancelled', 'denied', 'expired', 'revoked'];
const finiteMetric = value => Number.isSafeInteger(value) && value >= 0 && value <= 128;

function validEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const allowed = ['schemaVersion', 'source', 'eventId', 'sequence', 'taskId', 'version', 'type', 'at', 'metrics'];
  if (Object.keys(event).some(key => !allowed.includes(key)) || Object.keys(event).length !== allowed.length) return false;
  if (event.schemaVersion !== 1 || event.source !== SOURCE || !UUID.test(event.eventId) || !UUID.test(event.taskId)
      || !Number.isSafeInteger(event.sequence) || event.sequence <= 0 || !Number.isSafeInteger(event.version) || event.version <= 0
      || !TYPES.has(event.type) || !Number.isSafeInteger(event.at) || event.at < 0
      || !event.metrics || typeof event.metrics !== 'object' || Array.isArray(event.metrics)) return false;
  if (Object.keys(event.metrics).some(key => !METRIC_KEYS.includes(key))) return false;
  return METRIC_KEYS.every(key => finiteMetric(event.metrics[key]));
}

function parseAdvisory(raw, eventId, metrics) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2048) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'eventId,metrics,reasonCode,recommendation') return null;
  const reasons = new Set(['verified_completion', 'denial_threshold', 'recovered_anomaly', 'stalled_anomaly']);
  if (value.eventId !== eventId || !reasons.has(value.reasonCode)
      || !['observe', 'owner_attention', 'no_action'].includes(value.recommendation)
      || !value.metrics || Object.keys(value.metrics).sort().join(',') !== 'active,denied,queued,verified'
      || ['active', 'queued', 'verified', 'denied'].some(k => value.metrics[k] !== metrics[k])) return null;
  return Object.freeze({ eventId, reasonCode: value.reasonCode, recommendation: value.recommendation,
    metrics: Object.freeze({ active: metrics.active, queued: metrics.queued, verified: metrics.verified, denied: metrics.denied }) });
}

function createEventReview({ store, provider, clock = Date.now } = {}) {
  let enabled = false;
  let latestSequence = 0;
  let closed = false;
  let inflight = null;
  let lastCall = -Infinity;
  const recentDenials = [];
  const seen = new Set();

  function ownerState(next) {
    if (closed) return { ok: false, code: 'closed' };
    if (!next || typeof next.enabled !== 'boolean' || next.role !== 'owner') return { ok: false, code: 'owner_required' };
    if (!next.enabled) {
      enabled = false;
      inflight?.controller.abort();
      return { ok: true, code: 'off' };
    }
    if (typeof provider?.review !== 'function') return { ok: false, code: 'provider_unavailable' };
    if (typeof store?.reserve !== 'function' || typeof store?.markDispatched !== 'function'
        || typeof store?.settle !== 'function' || typeof store?.cancelReservation !== 'function') return { ok: false, code: 'ledger_unavailable' };
    enabled = true;
    return { ok: true, code: 'on' };
  }

  function eligibility(event, time) {
    if (event.type === 'job:terminal' && event.metrics.verified === 1) return 'verified_completion';
    if (event.type === 'job:recovered') return 'recovered_anomaly';
    if (event.type === 'job:stalled') return 'stalled_anomaly';
    if (event.type === 'job:denied') {
      recentDenials.push({ id: event.eventId, at: time });
      while (recentDenials.length && time - recentDenials[0].at > DENIAL_WINDOW_MS) recentDenials.shift();
      if (recentDenials.length >= DENIAL_THRESHOLD) return 'denial_threshold';
    }
    return null;
  }

  async function onEvent(event) {
    // This entry point is only to be wired to the private post-commit R6 callback.
    if (closed || !validEvent(event)) return { ok: false, code: 'invalid_or_untrusted_event' };
    if (seen.has(event.eventId)) return { ok: false, code: 'duplicate' };
    if (event.sequence <= latestSequence) return { ok: false, code: 'stale_sequence' };
    latestSequence = event.sequence;
    seen.add(event.eventId);
    if (seen.size > 2048) seen.delete(seen.values().next().value);
    if (!enabled) return { ok: false, code: 'off' };
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, code: 'invalid_clock' };
    const reasonCode = eligibility(event, now);
    if (!reasonCode) return { ok: false, code: 'ineligible' };
    if (inflight) return { ok: false, code: 'concurrency_limit' };
    if (now - lastCall < LIMITS.cooldownMs) return { ok: false, code: 'cooldown' };
    if (typeof provider?.review !== 'function' || typeof store?.reserve !== 'function'
        || typeof store?.markDispatched !== 'function' || typeof store?.settle !== 'function'
        || typeof store?.cancelReservation !== 'function') {
      return { ok: false, code: 'provider_or_ledger_unavailable' };
    }

    const controller = new AbortController();
    const token = { controller, eventId: event.eventId };
    inflight = token;
    let reservation;
    try {
      reservation = await store.reserve({ eventId: event.eventId, requestId: `werkudara:${event.eventId}`,
        maxInputTokens: LIMITS.inputTokens, maxOutputTokens: LIMITS.outputTokens, maxSpendUnits: LIMITS.spendUnits });
    } catch {
      if (inflight === token) inflight = null;
      return { ok: false, code: 'budget_unavailable' };
    }
    if (!reservation || reservation.allowed !== true || typeof reservation.reservationId !== 'string' || !reservation.reservationId) {
      if (inflight === token) inflight = null;
      return { ok: false, code: 'over_budget' };
    }
    if (!enabled || closed) {
      try { await store.cancelReservation(reservation.reservationId); } catch { /* reservation remains conservative */ }
      if (inflight === token) inflight = null;
      return { ok: false, code: 'off' };
    }

    let timedOut = false;
    let timer;
    let abortHandler;
    const metrics = Object.freeze({ active: event.metrics.active, queued: event.metrics.queued,
      verified: event.metrics.verified, denied: event.metrics.denied });
    const payload = Object.freeze({ source: SOURCE, eventId: event.eventId, sequence: event.sequence,
      type: event.type, reasonCode, metrics, limits: Object.freeze({ inputTokens: LIMITS.inputTokens,
        outputTokens: LIMITS.outputTokens, spendUnits: LIMITS.spendUnits }) });
    try {
      if (!enabled || closed) {
        try { await store.cancelReservation(reservation.reservationId); } catch { /* queued budget stays reserved */ }
        if (inflight === token) inflight = null;
        return { ok: false, code: 'off' };
      }
      let dispatched;
      try { dispatched = await store.markDispatched(reservation.reservationId); }
      catch {
        try { await store.cancelReservation(reservation.reservationId); } catch { /* dispatch state remains conservatively reserved */ }
        if (inflight === token) inflight = null;
        return { ok: false, code: 'dispatch_rejected' };
      }
      if (dispatched !== true && dispatched?.ok !== true) {
        try { await store.cancelReservation(reservation.reservationId); } catch { /* reservation remains conservative */ }
        if (inflight === token) inflight = null;
        return { ok: false, code: 'dispatch_rejected' };
      }
      if (!enabled || closed || controller.signal.aborted) {
        try { await store.settle({ reservationId: reservation.reservationId }); } catch { /* full reservation remains billed-unknown */ }
        if (inflight === token) inflight = null;
        return { ok: false, code: 'off' };
      }
      lastCall = now;
      // No ledger or policy work belongs between successful dispatch marking and the provider invocation.
       const aborted = new Promise((_, reject) => {
         abortHandler = () => reject(new Error('cancelled'));
         controller.signal.addEventListener('abort', abortHandler, { once: true });
         if (controller.signal.aborted) abortHandler();
       });
       const timeout = new Promise((_, reject) => {
         timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('timeout')); }, REVIEW_TIMEOUT_MS);
       });
       const request = Promise.resolve().then(() => provider.review(payload, { signal: controller.signal, timeoutMs: REVIEW_TIMEOUT_MS }));
       const raw = await Promise.race([request, aborted, timeout]);
      if (!enabled || controller.signal.aborted) throw new Error(timedOut ? 'timeout' : 'cancelled');
      const advisory = parseAdvisory(raw, event.eventId, metrics);
      if (!advisory) throw new Error('invalid_response');
      token.advisory = advisory;
    } catch {
      // Missing usage deliberately leaves the dispatched reservation billed-unknown at its maximum.
      try { await store.settle({ reservationId: reservation.reservationId }); } catch { /* conservative reservation */ }
      if (inflight === token) inflight = null;
      return { ok: false, code: timedOut ? 'timeout' : (controller.signal.aborted ? 'cancelled' : 'provider_or_response_failure') };
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
    }
    const mocked = provider.mocked === true;
    try {
      await store.settle({ reservationId: reservation.reservationId,
        ...(mocked ? { usage: { billedUnits: 0 } } : {}) });
    } catch {
      return { ok: false, code: 'settlement_uncertain' };
    } finally {
      if (inflight === token) inflight = null;
    }
    return { ok: true, code: 'reviewed', advisory: token.advisory,
      billing: mocked ? Object.freeze({ state: 'mock_zero', billedUnits: 0, realBill: false })
        : Object.freeze({ state: 'unknown', billedUnits: null, realBill: false }) };
  }

  function close() { closed = true; enabled = false; inflight?.controller.abort(); }
  return Object.freeze({ onEvent, ownerState, close, status: () => Object.freeze({ enabled, inflight: !!inflight,
    sequence: latestSequence }) });
}

module.exports = { createEventReview, LIMITS, SOURCE };
