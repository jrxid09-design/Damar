'use strict';
// Host-owned policy. The canonical snapshot remains byte-identical; only the isolated Core process applies this policy.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https');
const { Readable } = require('node:stream');
const DEFAULTS = Object.freeze({ version: 1, providerRequestMs: 600000, inactivityMs: 600000, executionMs: 1800000, heartbeatMs: 2000 });
function validate(v) {
  if (!v || v.version !== 1) throw Error('DEADLINES_VERSION_INVALID');
  for (const [key, lo, hi] of [['providerRequestMs', 1000, 900000], ['inactivityMs', 1000, 900000],
    ['executionMs', 1000, 3600000], ['heartbeatMs', 250, 4000]]) {
    if (!Number.isSafeInteger(v[key]) || v[key] < lo || v[key] > hi) throw Error('DEADLINE_INVALID_' + key);
  }
  if (v.heartbeatMs >= 5000) throw Error('HEARTBEAT_EXCEEDS_TRANSPORT_IDLE');
  return Object.freeze({ ...v });
}
function createProviderDeadlines(file) {
  let current = DEFAULTS;
  let applyRuntime = null;
  if (fs.existsSync(file)) current = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  const api = {
    view: () => ({ ...current, transportIdleMs: 5000 }),
    update(next) {
      const checked = validate({ ...current, ...next, version: 1 });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(checked), { flag: 'wx', mode: 0o600 });
      try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      current = checked; applyRuntime?.(); return api.view();
    },
    install({ aiRuntime, HttpClient, turnContext }) {
      if (!HttpClient.stream.__damarDeadline) {
        const originalStream = HttpClient.stream;
        const wrapped = function(url, options = {}) {
          const turn = turnContext.getStore();
          return turn ? loopbackStream(url, options, current, turn) : originalStream.call(this, url, options);
        };
        wrapped.__damarDeadline = true; HttpClient.stream = wrapped;
      }
      const apply = () => { process.env.DAMAR_TURN_WALLCLOCK_MS = String(current.executionMs); const runtime = aiRuntime.ensure().runtime; runtime.executor.callTimeout = current.inactivityMs; };
      applyRuntime = apply;
      if (!aiRuntime.reconfigure.__damarDeadline) {
        const original = aiRuntime.reconfigure.bind(aiRuntime);
        const wrapped = (...args) => { const result = original(...args); apply(); return result; };
        wrapped.__damarDeadline = true; aiRuntime.reconfigure = wrapped;
      }
      apply();
    },
  };
  return api;
}
// Node's default fetch body timer can end a silent SSE at 300 s, independently of the header timeout.
// The isolated Core's agent provider path uses a bounded loopback HTTP request with separate header/body clocks.
function loopbackStream(rawUrl, options, deadlines, turn) {
  const url = new URL(rawUrl);
  // A local endpoint configured as `localhost` is pinned to IPv4 loopback instead of resolving a name.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  // Plain HTTP only to this machine; remote providers must use HTTPS (certificate verified by Node).
  const remote = url.protocol === 'https:';
  if (!remote && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')) return Promise.reject(Error('PROVIDER_HTTPS_REQUIRED'));
  return new Promise((resolve, reject) => {
    let settled = false, response = null;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(headersTimer); error ? reject(error) : resolve(value); };
    const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body || {});
    const headers = { ...options.headers, 'content-type': 'application/json', ...(remote ? {} : { 'x-damar-turn': turn.id }) };
    const req = (remote ? https : http).request(url, { method: 'POST', headers, signal: turn.signal }, res => {
      response = res; clearTimeout(headersTimer);
      if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); return finish(Error(`${res.statusCode} ${res.statusMessage}`)); }
      res.setTimeout(deadlines.inactivityMs, () => res.destroy(Error('PROVIDER_INACTIVITY_TIMEOUT')));
      finish(null, Readable.toWeb(res));
    });
    const headersTimer = setTimeout(() => req.destroy(Error('PROVIDER_REQUEST_TIMEOUT')), deadlines.providerRequestMs);
    req.on('error', error => { if (!settled) finish(error); else response?.destroy(error); });
    req.end(body);
  });
}
module.exports = { createProviderDeadlines, validate, DEFAULTS };
