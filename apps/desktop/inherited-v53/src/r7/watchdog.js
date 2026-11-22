const crypto = require('node:crypto');

const STATES = new Set(['idle', 'blocked', 'paused', 'silent', 'terminated']);

function createWatchdog({ onWarning = () => {}, maxProducers = 64, maxEvents = 256, progressThresholdMs = 30_000, warningLimit = 3, clock = () => Number(process.hrtime.bigint() / 1_000_000n) } = {}) {
  const producers = new Map();
  const warnings = [];
  let stopped = false;
  function register({ producerId, taskId, version, active = true }) {
    if (stopped) throw new Error('Watchdog is shut down');
    if (producers.size >= maxProducers) throw new Error('Producer limit reached');
    if (!producerId || !taskId || !Number.isSafeInteger(version) || version < 1) throw new TypeError('producerId, taskId and positive version required');
    if (producers.has(producerId)) throw new Error('Producer is already registered');
    const secret = crypto.randomBytes(32).toString('hex');
    const state = { producerId, taskId, version, active, seq: 0, lastBeat: clock(), progressAt: clock(), status: active ? 'silent' : 'idle', warned: 0 };
    producers.set(producerId, { state, secret });
    // Callback closure is the capability. It is never accepted over HTTP or serialized.
    return Object.freeze({ heartbeat: event => heartbeat(secret, producerId, event), unregister: () => unregister(secret, producerId) });
  }
  function heartbeat(secret, producerId, event) {
    if (stopped) return false;
    const entry = producers.get(producerId);
    if (!entry || entry.secret !== secret) return false;
    if (!event || event.producerId !== producerId || event.taskId !== entry.state.taskId || event.version !== entry.state.version || !Number.isSafeInteger(event.seq) || event.seq <= entry.state.seq || !STATES.has(event.status)) return false;
    if (event.status !== 'terminated' && event.status !== 'idle' && !Number.isFinite(event.monotonicMs)) return false;
    const now = clock();
    entry.state.seq = event.seq; entry.state.lastBeat = now; entry.state.status = event.status;
    if (event.progress === true) { entry.state.progressAt = now; entry.state.warned = 0; }
    if (event.status === 'terminated' || event.status === 'idle') entry.state.active = false;
    return true;
  }
  function unregister(secret, producerId) {
    const entry = producers.get(producerId);
    if (!entry || entry.secret !== secret) return false;
    producers.delete(producerId); return true;
  }
  function scan() {
    if (stopped) return [];
    const emitted = [];
    const now = clock();
    for (const { state } of producers.values()) {
      // Only known active, nonterminal tasks qualify. Quiet idle/completed jobs do not.
      if (!state.active || !['blocked', 'paused', 'silent'].includes(state.status) || now - state.progressAt < progressThresholdMs || state.warned >= warningLimit) continue;
      state.warned++;
      const warning = Object.freeze({ producerId: state.producerId, taskId: state.taskId, version: state.version, status: state.status, staleForMs: now - state.progressAt, ordinal: state.warned });
      if (warnings.length === maxEvents) warnings.shift();
      warnings.push(warning); emitted.push(warning); onWarning(warning);
    }
    return emitted;
  }
  function snapshot() { return { stopped, producers: [...producers.values()].map(({ state }) => ({ ...state })), warnings: warnings.slice() }; }
  function shutdown() { stopped = true; producers.clear(); warnings.length = 0; }
  return { register, scan, snapshot, shutdown };
}

module.exports = { createWatchdog, STATES };
