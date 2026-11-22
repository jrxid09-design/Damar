'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 3;
const ACK_TIMEOUT_MS = 2500;
const STOP_TIMEOUT_MS = 10000;

function readStatus(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { state: value.state, updatedAt: value.updatedAt, reason: value.reason || null, attempt: value.attempt || 0 };
  } catch { return { state: 'UNKNOWN', updatedAt: null, reason: null, attempt: 0 }; }
}

function writeStatus(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ state: value.state, updatedAt: new Date().toISOString(), reason: value.reason || null, attempt: value.attempt || 0 }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function createChildBridge({ processRef = process, file, ackTimeoutMs = ACK_TIMEOUT_MS } = {}) {
  const pending = new Map();
  processRef.on('message', message => {
    if (!message || !['R7R3_RESTART_RESERVED', 'R7R3_RESTART_RESERVATION_FAILED'].includes(message.type)) return;
    const row = pending.get(message.requestId);
    if (!row) return;
    pending.delete(message.requestId); clearTimeout(row.timer);
    row.resolve(message.type === 'R7R3_RESTART_RESERVED');
  });
  return {
    status: () => readStatus(file),
    reserve() {
      if (!processRef.connected) return Promise.resolve(false);
      const requestId = crypto.randomUUID();
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(requestId); resolve(false); }, ackTimeoutMs);
        timer.unref?.(); pending.set(requestId, { resolve, timer });
        processRef.send({ type: 'R7R3_RESTART_RESERVE', requestId }, error => {
          if (error) { const row = pending.get(requestId); if (row) { pending.delete(requestId); clearTimeout(row.timer); resolve(false); } }
        });
      }).then(accepted => accepted ? requestId : null);
    },
    commit(requestId) { if (!processRef.connected || typeof requestId !== 'string') return false; processRef.send({ type: 'R7R3_RESTART_COMMIT', requestId }); return true; },
    cancel(requestId) { if (!processRef.connected || typeof requestId !== 'string') return false; processRef.send({ type: 'R7R3_RESTART_CANCEL', requestId }); return true; },
    ready() { if (processRef.connected) processRef.send({ type: 'R7R3_READY' }); },
  };
}

module.exports = { RESTART_WINDOW_MS, MAX_RESTARTS_PER_WINDOW, STOP_TIMEOUT_MS, readStatus, writeStatus, createChildBridge };
