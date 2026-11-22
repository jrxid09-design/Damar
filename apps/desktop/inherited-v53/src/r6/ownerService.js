'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { createDurableJobs, LIMITS, fail, digest } = require('./durableJobs');
const PREFIX = '/api/r6/';
const READ = ['health', 'state', 'audit'];
const ACTIONS = [...READ, 'plan', 'revise', 'approve', 'revoke', 'execute', 'verify', 'cancel'];
const credentialsFromEnv = (env = process.env) => ({ requester: env.DAMAR_R6_REQUESTER_TOKEN, owner: env.DAMAR_R6_OWNER_TOKEN });
function createOwnerService(options = {}) {
    const { credentials = credentialsFromEnv(), now = Date.now, staticHandler } = options;
    if (!credentials || ['owner', 'requester'].some(r => typeof credentials[r] !== 'string' ||
        Buffer.byteLength(credentials[r]) < 32 || Buffer.byteLength(credentials[r]) > 256 || /\s/.test(credentials[r])) ||
        credentials.owner === credentials.requester) throw fail('CREDENTIALS_REQUIRED', 503);
    const store = createDurableJobs({ ...options, now });
    const grants = new Map(); let scheduled = false; let closed = false;
    const schema = (body, required, optional = []) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            required.some(k => !Object.hasOwn(body, k)) || Object.keys(body).some(k => ![...required, ...optional].includes(k))) throw fail('INVALID_BODY', 400);
    };
    function textCheck(body) {
        if (body.syntheticData !== true || typeof body.text !== 'string' || Buffer.byteLength(body.text) > LIMITS.textBytes ||
            Object.values(credentials).some(token => body.text.includes(token))) throw fail('SYNTHETIC_TEXT_REQUIRED', 400);
    }
    function ttl(value, fallback, max) {
        const n = value === undefined ? fallback : value;
        if (!Number.isSafeInteger(n) || n < 1 || n > max) throw fail('INVALID_TTL', 400);
        return n;
    }
    function get(body) {
        const p = store.read().plans.find(p => p.id === body.planId);
        if (!p) throw fail('PLAN_NOT_FOUND', 404);
        if (p.version !== body.version) throw fail('TASK_VERSION_MISMATCH');
        return p;
    }
    function live(p) {
        if (now() >= p.expiresAt) throw fail('PLAN_EXPIRED');
        if (p.status !== 'PLANNED') throw fail('TASK_NOT_PLANNED');
    }
    function grantCheck(p, body, cached = false) {
        const g = grants.get(p.id);
        if (!g || g.id !== body.approvalId) throw fail('APPROVAL_REQUIRED');
        if (g.revoked) throw fail('APPROVAL_REVOKED');
        if (g.version !== p.version || g.requester !== p.requester || g.inputDigest !== p.inputDigest) throw fail('APPROVAL_BINDING_MISMATCH');
        if (!cached && (now() >= g.expiresAt || now() >= p.expiresAt)) throw fail('APPROVAL_EXPIRED');
        return g;
    }
    function view(p) {
        return { planId: p.id, taskId: p.id, jobId: p.requestId ? p.id : null, version: p.version,
            requester: p.requester, operation: 'sha256-text', status: p.status, expiresAt: p.expiresAt,
            code: p.code, ...(p.result ? { outcome: 'EXECUTED_VERIFIED', result: { ...p.result } } : {}) };
    }
    function snapshot() {
        const s = store.read();
        return { schemaVersion: 1, authority: 'isolated-test', source: 'damar.r6.jobs', available: store.available(),
            featureFlags: { isolatedTest: true, productionAuthority: false, arbitraryExecution: false, queueExecution: true },
            limits: LIMITS, plans: s.plans.map(view), jobs: s.plans.filter(p => p.requestId).map(view),
            approvals: s.plans.filter(p => grants.has(p.id)).map(p => {
                const g = grants.get(p.id); return { planId: p.id, version: g.version, revoked: g.revoked,
                    expiresAt: g.expiresAt, consumed: !!p.requestId, expired: now() >= g.expiresAt };
            }), executions: s.plans.filter(p => p.result).map(view), events: s.events };
    }
    function update(p, patch, type) {
        return store.commit(s => Object.assign(s.plans.find(r => r.id === p.id), patch), p.id, type);
    }
    function pump() {
        scheduled = false;
        if (closed || !store.available()) return;
        const p = store.read().plans.find(p => p.status === 'QUEUED');
        if (!p) return;
        try {
            const g = grants.get(p.id);
            grantCheck(p, { approvalId: g?.id });
            update(p, { status: 'WORKING' }, 'job:start');
            const result = { operation: 'sha256-text', sha256: digest(p.text), bytes: Buffer.byteLength(p.text) };
            update(p, { status: 'VERIFIED', result, code: 'ok' }, 'job:terminal');
        } catch (e) {
            if (store.available()) update(p, { status: 'FAILED', code: e.code || 'EXECUTION_FAILED' }, 'job:terminal');
        }
        if (!closed && store.available()) schedule();
    }
    function schedule() { if (!scheduled) { scheduled = true; setImmediate(pump); } }
    function act(action, role, body) {
        if (!store.available()) throw fail('SERVICE_UNAVAILABLE', 503);
        if (!['health','state'].includes(action) && role !== (['approve','revoke','audit'].includes(action) ? 'owner' : 'requester')) throw fail('ROLE_DENIED', 403);
        if (action === 'health') return { available: true, operation: 'sha256-text', limits: LIMITS };
        if (action === 'state') return snapshot();
        if (action === 'audit') return { events: store.read().events };
        if (action === 'plan') {
            schema(body, ['text','syntheticData'], ['ttlMs']); textCheck(body);
            if (store.read().plans.length >= LIMITS.plans) throw fail('PLAN_CAPACITY', 429);
            const p = { id: crypto.randomUUID(), version: 1, text: body.text, syntheticData: true,
                inputDigest: digest(body.text), expiresAt: now() + ttl(body.ttlMs, 60000, LIMITS.planTtlMs),
                status: 'PLANNED', requester: 'isolated-requester', requestId: null, result: null, code: null };
            store.commit(s => s.plans.push(p), p.id, 'job:planned');
            return { ...view(p), inputDigest: p.inputDigest };
        }
        if (action === 'revise') {
            schema(body, ['planId','version','text','syntheticData']); textCheck(body);
            const p = get(body); live(p);
            const next = update(p, { version: p.version + 1, text: body.text, inputDigest: digest(body.text) }, 'job:revised');
            grants.delete(p.id); return { ...view(next), inputDigest: next.inputDigest };
        }
        if (action === 'approve') {
            schema(body, ['planId','version'], ['ttlMs']); const p = get(body); live(p);
            const previous = grants.get(p.id);
            if (previous && !previous.revoked && now() < previous.expiresAt) throw fail('APPROVAL_ALREADY_ISSUED');
            const g = { id: crypto.randomUUID(), version: p.version, requester: p.requester, inputDigest: p.inputDigest,
                expiresAt: Math.min(p.expiresAt, now() + ttl(body.ttlMs, 30000, LIMITS.approvalTtlMs)), revoked: false };
            update(p, {}, 'job:approved'); grants.set(p.id, g);
            return { planId: p.id, version: p.version, approvalId: g.id, expiresAt: g.expiresAt };
        }
        if (action === 'revoke') {
            schema(body, ['planId','version']); const p = get(body);
            const g = grants.get(p.id); if (!g) throw fail('APPROVAL_REQUIRED');
            update(p, {}, 'job:revoked'); g.revoked = true;
            return { planId: p.id, revoked: true };
        }
        if (action === 'execute') {
            schema(body, ['planId','version','approvalId','requestId']); const p = get(body);
            if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(body.requestId)) throw fail('INVALID_REQUEST_ID', 400);
            grantCheck(p, body, p.status === 'VERIFIED');
            if (p.requestId) {
                if (body.requestId !== p.requestId) throw fail('REQUEST_BINDING_MISMATCH');
                if (!['QUEUED','WORKING','VERIFIED'].includes(p.status)) throw fail('TASK_TERMINAL');
                return { ...view(p), cached: p.status === 'VERIFIED' };
            }
            live(p);
            const next = update(p, { status: 'QUEUED', requestId: body.requestId }, 'job:queued');
            schedule(); return view(next);
        }
        if (action === 'verify') {
            schema(body, ['planId','version']); const p = get(body);
            if (p.status !== 'VERIFIED') throw fail('NOT_EXECUTED');
            return { ...view(p), verified: p.result.sha256 === digest(p.text) };
        }
        if (action === 'cancel') {
            schema(body, ['planId','version']); const p = get(body);
            if (!['PLANNED','QUEUED'].includes(p.status)) throw fail('TASK_TERMINAL');
            const next = update(p, { status: 'CANCELLED', code: 'cancelled' }, 'job:terminal');
            grants.delete(p.id); return view(next);
        }
        throw fail('ROUTE_NOT_FOUND', 404);
    }
    function authenticate(req) {
        const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
        for (const role of ['requester', 'owner']) {
            const expected = Buffer.from(`Bearer ${credentials[role]}`);
            if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) return role;
        }
        throw fail('AUTHENTICATION_REQUIRED', 401);
    }
    async function handler(req, res) {
        if (!(req.url || '').startsWith(PREFIX)) return staticHandler ? !!await staticHandler(req, res) : false;
        const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        try {
            if (req.socket.localAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${req.socket.localPort}`) throw fail('HOST_DENIED', 403);
            if (Object.hasOwn(req.headers, 'origin')) throw fail('ORIGIN_DENIED', 403);
            const action = req.url.slice(PREFIX.length);
            if (!ACTIONS.includes(action)) throw fail('ROUTE_NOT_FOUND', 404);
            if (req.method !== (READ.includes(action) ? 'GET' : 'POST')) throw fail('METHOD_DENIED', 405);
            const role = authenticate(req); let body = {};
            if (req.method === 'POST') {
                if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('JSON_REQUIRED', 415);
                const chunks = []; let bytes = 0;
                for await (const chunk of req) { bytes += chunk.length; if (bytes > LIMITS.bodyBytes) throw fail('BODY_TOO_LARGE', 413); chunks.push(chunk); }
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_JSON', 400); }
            }
            let data;
            try { data = act(action, role, body); }
            catch (e) {
                if (store.available() && !READ.includes(action) && body && typeof body.planId === 'string' &&
                    store.read().plans.some(p => p.id === body.planId)) {
                    store.commit(() => {}, body.planId, 'job:denied', {
                        expired: ['APPROVAL_EXPIRED','PLAN_EXPIRED'].includes(e.code), revoked: e.code === 'APPROVAL_REVOKED' });
                }
                throw e;
            }
            send(200, { success: true, data: { schemaVersion: 1, authority: 'isolated-test', ...data } });
        } catch (e) { send(e.status || 500, { success: false, error: { code: e.code || 'SERVICE_UNAVAILABLE', message: e.code || 'SERVICE_UNAVAILABLE' } }); }
        return true;
    }
    function close() { if (closed) return; closed = true; grants.clear(); store.close(); }
    return { handler, snapshot, close, authority: 'isolated-test', limits: LIMITS };
}
function createOwnerServer(options) {
    const service = createOwnerService(options);
    const server = http.createServer({ maxHeaderSize: LIMITS.headerBytes }, async (req, res) => {
        if (req.socket.localAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${req.socket.localPort}` || Object.hasOwn(req.headers, 'origin')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: { code: 'HOST_OR_ORIGIN_DENIED', message: 'HOST_OR_ORIGIN_DENIED' } })); return;
        }
        if (!await service.handler(req, res)) { res.writeHead(404); res.end(); }
    });
    server.maxConnections = LIMITS.connections; server.maxHeadersCount = 32;
    server.requestTimeout = LIMITS.requestTimeoutMs; server.headersTimeout = LIMITS.requestTimeoutMs;
    server.timeout = LIMITS.requestTimeoutMs; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 100;
    server.on('close', service.close);
    return { server, service };
}
module.exports = { createOwnerServer, createOwnerService, credentialsFromEnv, PREFIX, LIMITS, ACTIONS };
