'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const LIMITS = Object.freeze({ textBytes: 4096, bodyBytes: 8192, headerBytes: 8192,
    connections: 32, requestTimeoutMs: 5000, plans: 128, events: 256,
    stateBytes: 2097152, planTtlMs: 120000, approvalTtlMs: 60000 });
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = ['job:planned', 'job:revised', 'job:approved', 'job:revoked', 'job:queued', 'job:start', 'job:terminal', 'job:recovered', 'job:denied'];
const STATUSES = ['PLANNED', 'QUEUED', 'WORKING', 'VERIFIED', 'FAILED', 'CANCELLED'];
function createDurableJobs({ statePath, onEvent, now = Date.now }) {
    if (typeof statePath !== 'string' || !statePath) throw fail('STATE_PATH_REQUIRED', 503);
    const lockPath = `${statePath}.lock`;
    let lock;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch { throw fail('STATE_LOCKED', 503); }
    let closed = false; let poisoned = false;
    let state = { schemaVersion: 1, sequence: 0, plans: [], events: [] };
    function close() {
        if (closed) return;
        closed = true; fs.closeSync(lock); fs.unlinkSync(lockPath);
    }
    try {
        if (fs.existsSync(statePath)) {
            if (fs.statSync(statePath).size > LIMITS.stateBytes) throw Error();
            state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 ||
                !Array.isArray(state.plans) || state.plans.length > LIMITS.plans ||
                !Array.isArray(state.events) || state.events.length > LIMITS.events) throw Error();
            const ids = new Set();
            for (const p of state.plans) {
                if (!p || !UUID.test(p.id) || ids.has(p.id) || !Number.isSafeInteger(p.version) || p.version < 1 ||
                    typeof p.text !== 'string' || Buffer.byteLength(p.text) > LIMITS.textBytes || p.syntheticData !== true ||
                    p.inputDigest !== digest(p.text) || !Number.isSafeInteger(p.expiresAt) ||
                    !STATUSES.includes(p.status) || p.requester !== 'isolated-requester' ||
                    (p.requestId !== null && (typeof p.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(p.requestId))) ||
                    (p.status === 'VERIFIED' && (p.result?.sha256 !== digest(p.text) || p.result?.bytes !== Buffer.byteLength(p.text) || p.result?.operation !== 'sha256-text'))) throw Error();
                if (Object.keys(p).some(k => !['id','version','text','syntheticData','inputDigest','expiresAt','status','requester','requestId','result','code'].includes(k))) throw Error();
                ids.add(p.id);
            }
            state.events.forEach((e, i) => {
                if (e.schemaVersion !== 1 || e.source !== 'damar.r6.jobs' || !UUID.test(e.eventId) || !UUID.test(e.taskId) ||
                    !Number.isSafeInteger(e.version) || e.version < 1 || !TYPES.includes(e.type) ||
                    !Number.isSafeInteger(e.at) || !Number.isSafeInteger(e.sequence) ||
                    e.sequence !== state.sequence - state.events.length + i + 1 ||
                    !Number.isInteger(e.metrics?.active) || e.metrics.active < 0 || e.metrics.active > 1 ||
                    !Number.isInteger(e.metrics?.queued) || e.metrics.queued < 0 || e.metrics.queued > LIMITS.plans ||
                    Object.keys(e).some(k => !['schemaVersion','source','eventId','sequence','taskId','version','type','at','metrics'].includes(k)) ||
                    Object.keys(e.metrics).some(k => !['active','queued','verified','failed','cancelled','denied','expired','revoked'].includes(k)) ||
                    ['verified','failed','cancelled','denied','expired','revoked'].some(k => ![0,1].includes(e.metrics[k]))) throw Error();
            });
            if (state.sequence > 0 && !state.events.length) throw Error();
        }
    } catch { close(); throw fail('STATE_CORRUPT', 503); }
    function commit(mutator, id, type, anomaly = {}) {
        if (closed || poisoned) throw fail('SERVICE_UNAVAILABLE', 503);
        const next = structuredClone(state);
        mutator(next);
        const p = next.plans.find(p => p.id === id);
        const event = { schemaVersion: 1, source: 'damar.r6.jobs', eventId: crypto.randomUUID(),
            sequence: ++next.sequence, taskId: id, version: p.version, type, at: now(),
            metrics: { active: next.plans.filter(p => p.status === 'WORKING').length,
                queued: next.plans.filter(p => p.status === 'QUEUED').length,
                verified: p.status === 'VERIFIED' && type === 'job:terminal' ? 1 : 0,
                failed: p.status === 'FAILED' && ['job:terminal','job:recovered'].includes(type) ? 1 : 0,
                cancelled: p.status === 'CANCELLED' && type === 'job:terminal' ? 1 : 0,
                denied: type === 'job:denied' ? 1 : 0, expired: anomaly.expired ? 1 : 0,
                revoked: anomaly.revoked ? 1 : 0 } };
        next.events.push(event); next.events = next.events.slice(-LIMITS.events);
        const content = JSON.stringify(next);
        if (Buffer.byteLength(content) > LIMITS.stateBytes) throw fail('STATE_FULL', 503);
        try {
            const fd = fs.openSync(`${statePath}.pending`, 'w', 0o600);
            try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(`${statePath}.pending`, statePath);
        } catch { poisoned = true; throw fail('STATE_UNAVAILABLE', 503); }
        state = next;
        if (typeof onEvent === 'function') {
            try { onEvent(Object.freeze({ ...event, metrics: Object.freeze({ ...event.metrics }) })); } catch { /* Advisory subscribers cannot alter committed authority. */ }
        }
        return structuredClone(p);
    }
    try {
        for (const p of state.plans.filter(p => ['QUEUED', 'WORKING'].includes(p.status))) {
            commit(s => { const row = s.plans.find(r => r.id === p.id); row.status = 'FAILED'; row.code = 'RESTART_AMBIGUOUS'; }, p.id, 'job:recovered');
        }
    } catch (e) { close(); throw e; }
    return { read: () => structuredClone(state), commit, close, available: () => !closed && !poisoned };
}
module.exports = { createDurableJobs, LIMITS, fail, digest };
