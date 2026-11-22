const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLeaderLease } = require('./leaderLease');

const VERSION = 1;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const finite = n => Number.isSafeInteger(n) && n >= 0;

function createSupervisorStore({ directory, ownerId, capabilityValidator = () => false, getRestartCapability = () => undefined, onAlert = () => {}, persistOptIn = false, clock = () => Date.now() } = {}) {
  if (!directory || !ownerId) throw new TypeError('directory and ownerId are required');
  try { fs.mkdirSync(directory, { recursive: true }); }
  catch (error) { onAlert({ type: 'storage-unavailable', error: error.message }); throw error; }
  const configPath = path.join(directory, 'supervisor.v1.json');
  const ledgerPath = path.join(directory, 'spend-ledger.v1.json');
  const lease = createLeaderLease({ directory, onAlert });
  let activeLease;
  let invalidPersistentState = false;

  function atomicWrite(file, value) {
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      onAlert({ type: 'atomic-persistence-failed', file, error: error.message });
      throw error;
    }
  }
  function readChecked(file, fallback, kind) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.schemaVersion !== VERSION || raw.checksum !== digest(raw.payload)) throw new Error('checksum or schema mismatch');
      return raw.payload;
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      invalidPersistentState = true;
      onAlert({ type: 'invalid-persistent-state', kind, error: error.message });
      return fallback;
    }
  }
  function writeChecked(file, payload) { atomicWrite(file, { schemaVersion: VERSION, payload, checksum: digest(payload) }); }
  function validLedger(value) {
    if (!value || !['reserved', 'estimated', 'billedKnown', 'billedUnknown', 'fenceEpoch'].every(key => finite(value[key])) || !Array.isArray(value.reservations) || !Array.isArray(value.events)) return false;
    const ids = new Set(), requests = new Set(), eventIds = new Set();
    let reserved = 0, estimated = 0, billedKnown = 0, billedUnknown = 0;
    const dispatched = new Set();
    for (const row of value.reservations) {
      if (!row || !row.reservationId || !row.requestId || !row.eventId || !['QUEUED', 'INFLIGHT', 'SETTLED', 'UNCERTAIN', 'CANCELLED'].includes(row.status) || !finite(row.maxInputTokens) || !finite(row.maxOutputTokens) || !finite(row.maxSpendUnits) || !finite(row.createdAt)) return false;
      if (ids.has(row.reservationId) || requests.has(row.requestId) || eventIds.has(row.eventId)) return false;
      ids.add(row.reservationId); requests.add(row.requestId); eventIds.add(row.eventId); estimated += row.maxSpendUnits;
      if (row.status === 'QUEUED' || row.status === 'INFLIGHT') reserved += row.maxSpendUnits;
      if (row.status !== 'QUEUED' && row.status !== 'CANCELLED') dispatched.add(row.eventId);
      if (row.status === 'SETTLED') { if (!finite(row.billedKnown) || row.billedKnown > row.maxSpendUnits) return false; billedKnown += row.billedKnown; }
      if (row.status === 'UNCERTAIN') { if (row.billedUnknown !== row.maxSpendUnits) return false; billedUnknown += row.billedUnknown; }
    }
    const listedEvents = new Set();
    for (const eventId of value.events) { if (listedEvents.has(eventId)) return false; listedEvents.add(eventId); }
    return [reserved, estimated, billedKnown, billedUnknown].every(finite) && value.reserved === reserved && value.estimated === estimated && value.billedKnown === billedKnown && value.billedUnknown === billedUnknown && listedEvents.size === dispatched.size && [...listedEvents].every(eventId => dispatched.has(eventId));
  }
  function defaultConfig() { return { ownerId, state: 'OFF', policy: {}, budget: { maxSpendUnits: 0 }, persistOptIn: false, updatedAt: Date.now() }; }
  const hadConfig = fs.existsSync(configPath);
  let config = readChecked(configPath, defaultConfig(), 'config');
  if (!config || config.ownerId !== ownerId || !['ON', 'OFF'].includes(config.state)) {
    invalidPersistentState = true;
    onAlert({ type: 'invalid-owner-or-config' }); config = defaultConfig();
  }
  if (!config.budget || !finite(config.budget.maxSpendUnits) || !config.policy || typeof config.policy !== 'object') {
    invalidPersistentState = true;
    onAlert({ type: 'invalid-owner-or-config', reason: 'invalid policy or budget' }); config = defaultConfig();
  }
  // Runtime starts OFF. ON can only be restored with persisted consent and a fresh owner grant.
  let persistedState = config.state;
  config = { ...config, state: 'OFF' };
  if (!hadConfig) writeChecked(configPath, config);
  const hadLedger = fs.existsSync(ledgerPath);
  const emptyLedger = () => ({ reserved: 0, estimated: 0, billedKnown: 0, billedUnknown: 0, reservations: [], events: [], fenceEpoch: 0 });
  let ledger = readChecked(ledgerPath, emptyLedger(), 'ledger');
  if (!validLedger(ledger)) {
    invalidPersistentState = true;
    onAlert({ type: 'invalid-persistent-state', kind: 'ledger', error: 'ledger schema or balances are inconsistent' });
    ledger = emptyLedger();
  }
  if (invalidPersistentState) config.state = 'OFF';
  if (!hadLedger) writeChecked(ledgerPath, ledger);
  const key = path.join(directory, 'ledger.mutex');
  function transaction(fn) {
    lease.assertCurrent();
    let fd;
    try { fd = fs.openSync(key, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Ledger transaction busy; retry'); throw error; }
    try {
      // Reload on every operation so processes never overwrite newer ledger state.
      ledger = readChecked(ledgerPath, ledger, 'ledger');
      if (!validLedger(ledger)) {
        invalidPersistentState = true;
        onAlert({ type: 'invalid-persistent-state', kind: 'ledger', error: 'ledger schema or balances are inconsistent' });
      }
      if (invalidPersistentState) { config.state = 'OFF'; throw new Error('Persistent state invalid; supervisor forced OFF'); }
      if (ledger.fenceEpoch > activeLease.epoch) throw new Error('Fenced by newer ledger epoch');
      const result = fn();
      ledger.fenceEpoch = activeLease.epoch;
      try { writeChecked(ledgerPath, ledger); }
      catch (error) {
        config.state = 'OFF';
        onAlert({ type: 'ledger-persistence-failed', error: error.message });
        try { writeChecked(configPath, config); } catch (persistError) { onAlert({ type: 'configuration-persistence-failed', error: persistError.message }); }
        throw error;
      }
      return result;
    } finally { fs.closeSync(fd); fs.unlinkSync(key); }
  }
  function acquire() {
    activeLease = lease.acquire();
    ledger.fenceEpoch = Math.max(ledger.fenceEpoch || 0, activeLease.epoch);
    if (!invalidPersistentState) {
      try { writeChecked(ledgerPath, ledger); }
      catch (error) {
        config.state = 'OFF';
        try { activeLease.release(); } catch (releaseError) { onAlert({ type: 'leader-release-failed', error: releaseError.message }); }
        throw error;
      }
    }
    if (!invalidPersistentState && ledger.reservations.some(row => row.status === 'QUEUED')) {
      try { cancelQueued(); }
      catch (error) {
        config.state = 'OFF';
        try { activeLease.release(); } catch (releaseError) { onAlert({ type: 'leader-release-failed', error: releaseError.message }); }
        throw error;
      }
    }
    const restoredOn = persistedState === 'ON' && config.persistOptIn && persistOptIn;
    let restartAllowed = false;
    if (restoredOn) {
      try { restartAllowed = capabilityValidator({ ownerId, capability: getRestartCapability(), phase: 'restart' }) === true; }
      catch (error) { onAlert({ type: 'restart-authorization-failed', error: error.message }); }
    }
    if (restoredOn && !restartAllowed) config.state = 'OFF';
    else if (restoredOn) config.state = 'ON';
    return activeLease;
  }
  function configure(state, ownerCapability, options = {}) {
    lease.assertCurrent();
    if (state !== 'ON' && state !== 'OFF') throw new TypeError('state must be ON or OFF');
    if (invalidPersistentState) throw new Error('Persistent state invalid; configuration remains OFF');
    let authorized = false;
    try { authorized = capabilityValidator({ ownerId, capability: ownerCapability, phase: 'configure' }) === true; }
    catch (error) { onAlert({ type: 'owner-authorization-failed', error: error.message }); }
    if (!authorized) throw new Error('Owner authorization rejected');
    if (state === 'ON' && (!Object.hasOwn(options, 'policy') || !Object.hasOwn(options, 'budget') || !options.policy || typeof options.policy !== 'object' || Array.isArray(options.policy) || !options.budget || typeof options.budget !== 'object' || Array.isArray(options.budget) || !finite(options.budget.maxSpendUnits))) throw new Error('ON requires explicit policy and finite budget');
    if (state === 'ON') {
      const optionalCaps = ['maxCalls', 'maxInputTokens', 'maxOutputTokens', 'maxPerHourSpendUnits', 'maxPerDaySpendUnits', 'maxPerHourCalls', 'maxPerDayCalls'];
      for (const cap of optionalCaps) if (options.budget[cap] !== undefined && !finite(options.budget[cap])) throw new Error(`${cap} must be a finite non-negative integer`);
    }
    const previous = config;
    config = { ...config, state, policy: options.policy || config.policy, budget: options.budget || config.budget, persistOptIn: state === 'ON' && options.persistOptIn === true, updatedAt: Date.now() };
    try { writeChecked(configPath, config); }
    catch (error) { config = { ...previous, state: 'OFF' }; onAlert({ type: 'configuration-persistence-failed', error: error.message }); throw error; }
    persistedState = config.state;
    if (state === 'OFF') cancelQueued();
    return { ...config };
  }
  function reserve({ eventId, requestId, maxInputTokens, maxOutputTokens, maxSpendUnits }) {
    const rejected = code => ({ allowed: false, code });
    if (!['string', 'number'].includes(typeof eventId) || !eventId || !['string', 'number'].includes(typeof requestId) || !requestId) return rejected('INVALID_ID');
    if (Object.entries({ maxInputTokens, maxOutputTokens, maxSpendUnits }).some(([, value]) => !finite(value))) return rejected('INVALID_AMOUNT');
    try { return transaction(() => {
      const existing = ledger.reservations.find(r => r.requestId === requestId);
      if (existing) {
        if (existing.eventId !== eventId || existing.maxInputTokens !== maxInputTokens || existing.maxOutputTokens !== maxOutputTokens || existing.maxSpendUnits !== maxSpendUnits) return rejected('REQUEST_ID_CONFLICT');
        if (existing.status !== 'QUEUED') return rejected(existing.status === 'CANCELLED' ? 'RESERVATION_CANCELLED' : 'ALREADY_DISPATCHED');
        return { allowed: true, reservationId: existing.reservationId, eventId, requestId, status: existing.status, duplicate: true };
      }
      if (config.state !== 'ON') return rejected('SUPERVISOR_OFF');
      if (ledger.events.includes(eventId) || ledger.reservations.some(row => row.eventId === eventId)) return rejected('EVENT_ALREADY_USED');
      const budget = config.budget;
      if (maxSpendUnits > budget.maxSpendUnits) return rejected('REQUEST_SPEND_CAP');
      if (budget.maxInputTokens !== undefined && maxInputTokens > budget.maxInputTokens) return rejected('INPUT_TOKEN_CAP');
      if (budget.maxOutputTokens !== undefined && maxOutputTokens > budget.maxOutputTokens) return rejected('OUTPUT_TOKEN_CAP');
      const prior = ledger.reservations.filter(row => row.status !== 'CANCELLED');
      if (budget.maxCalls !== undefined && prior.length >= budget.maxCalls) return rejected('CALL_CAP');
      const now = clock();
      const inWindow = (row, duration) => row.status !== 'CANCELLED' && now - row.createdAt < duration;
      const hour = prior.filter(row => inWindow(row, 3_600_000));
      const day = prior.filter(row => inWindow(row, 86_400_000));
      if (budget.maxPerHourCalls !== undefined && hour.length >= budget.maxPerHourCalls) return rejected('HOURLY_CALL_CAP');
      if (budget.maxPerDayCalls !== undefined && day.length >= budget.maxPerDayCalls) return rejected('DAILY_CALL_CAP');
      if (budget.maxPerHourSpendUnits !== undefined && hour.reduce((sum, row) => sum + row.maxSpendUnits, 0) + maxSpendUnits > budget.maxPerHourSpendUnits) return rejected('HOURLY_SPEND_CAP');
      if (budget.maxPerDaySpendUnits !== undefined && day.reduce((sum, row) => sum + row.maxSpendUnits, 0) + maxSpendUnits > budget.maxPerDaySpendUnits) return rejected('DAILY_SPEND_CAP');
      const committed = ledger.reserved + ledger.billedKnown + ledger.billedUnknown;
      if (committed + maxSpendUnits > budget.maxSpendUnits) return rejected('SPEND_BUDGET_EXCEEDED');
      const reservation = { reservationId: crypto.randomUUID(), eventId, requestId, maxInputTokens, maxOutputTokens, maxSpendUnits, status: 'QUEUED', epoch: activeLease.epoch, createdAt: now };
      ledger.reservations.push(reservation); ledger.reserved += maxSpendUnits; ledger.estimated += maxSpendUnits;
      return { allowed: true, ...reservation };
    }); } catch (error) {
      if (/Persistent state invalid/.test(error.message)) return rejected('STORE_INVALID');
      if (/Fenced|No active leader/.test(error.message)) return rejected('STALE_LEASE');
      if (/Ledger transaction busy/.test(error.message)) return rejected('LEDGER_BUSY');
      throw error;
    }
  }
  function settle({ reservationId, usage }) {
    return transaction(() => {
      const row = ledger.reservations.find(r => r.reservationId === reservationId);
      if (!row) throw new Error('Unknown reservation');
      if (row.status === 'SETTLED' || row.status === 'UNCERTAIN') return { ...row, duplicate: true };
      if (row.status !== 'INFLIGHT') throw new Error('Only an in-flight reservation can settle');
      ledger.reserved -= row.maxSpendUnits;
      const known = usage && finite(usage.billedUnits) && usage.billedUnits <= row.maxSpendUnits;
      if (known) { row.status = 'SETTLED'; row.billedKnown = usage.billedUnits; ledger.billedKnown += usage.billedUnits; }
      else { row.status = 'UNCERTAIN'; row.billedUnknown = row.maxSpendUnits; ledger.billedUnknown += row.maxSpendUnits; }
      row.settledAt = Date.now(); return { ...row };
    });
  }
  function markDispatched(reservationId) {
    return transaction(() => {
      const row = ledger.reservations.find(r => r.reservationId === reservationId);
      if (!row || row.status !== 'QUEUED' || row.epoch !== activeLease.epoch || config.state !== 'ON') return false;
      if (ledger.events.includes(row.eventId)) return false;
      row.status = 'INFLIGHT'; ledger.events.push(row.eventId); return { ok: true, reservationId };
    });
  }
  function cancelReservation(reservationId) {
    return transaction(() => {
      const row = ledger.reservations.find(r => r.reservationId === reservationId);
      if (!row || row.status !== 'QUEUED') return false;
      row.status = 'CANCELLED'; ledger.reserved -= row.maxSpendUnits;
      return { ok: true, reservationId, cancelled: true };
    });
  }
  function cancelQueued() {
    return transaction(() => {
      let released = 0;
      for (const row of ledger.reservations) if (row.status === 'QUEUED') { row.status = 'CANCELLED'; released += row.maxSpendUnits; }
      ledger.reserved -= released; return released;
    });
  }
  function snapshot() { return { config: { ...config }, ledger: JSON.parse(JSON.stringify(ledger)), lease: activeLease && { epoch: activeLease.epoch } }; }
  return { acquire, configure, reserve, settle, markDispatched, cancelReservation, cancelQueued, snapshot, assertCurrent: lease.assertCurrent };
}

module.exports = { createSupervisorStore, VERSION };
