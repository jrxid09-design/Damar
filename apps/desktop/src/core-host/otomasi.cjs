'use strict';
// Otomasi binding for the desktop Core (F10): the automation service (the
// daily WhatsApp brief) lives exactly once, as a singleton in the canonical
// daemon (src/services/automationService, started by src/server.js). The
// desktop Core never composes a second one and never writes its JsonStore
// file: the daemon caches the config in-process, so external writes would
// be invisible to the running service and then clobbered by its next write.
// The Core reads the daemon's status projection over loopback with the
// install credential, the same pattern as the Cyber binding
// (core-host/cyber.cjs). The token is read server-side on every call, used
// only as a Bearer header to the local daemon, and never returned, logged
// or stored by this module. Every failure degrades to an honest unavailable
// reason; nothing here throws into the route layer and nothing is invented
// when the daemon or its projection cannot be reached. Writes go to the
// daemon's token-guarded automation write seam (POST /api/ui/automation/*):
// config saves are applied by the daemon through the automation service
// singleton, so the running scheduler observes them on its next tick with
// no daemon restart, and a run-now call runs the brief through the
// service's own governed submit. The daemon console's legacy action
// ingress stays disabled and is not revived.
const path = require('node:path');
const { readDaemonToken } = require('./cyber.cjs');

function createOtomasiBinding({ installRoot, fetchImpl } = {}) {
  if (!installRoot || !path.isAbsolute(installRoot)) throw Error('OTOMASI_INSTALL_ROOT_REQUIRED');
  const base = String(process.env.DAMAR_OTOMASI_DAEMON_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const transport = typeof fetchImpl === 'function' ? fetchImpl : ((...a) => fetch(...a));
  async function daemonStatus() {
    const token = readDaemonToken(installRoot);
    if (!token) return { available: false, reason: 'KREDENSIAL_TIDAK_TERSEDIA' };
    let response;
    try {
      response = await transport(base + '/api/ui/automation/status', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { accept: 'application/json', authorization: 'Bearer ' + token } });
    } catch { return { available: false, reason: 'DAEMON_TIDAK_TERJANGKAU' }; }
    // A daemon build that predates the status route answers 404: the
    // projection activates when that daemon is next relaunched, with no
    // further change on this side.
    if (response.status === 404) return { available: false, reason: 'PROYEKSI_BELUM_AKTIF' };
    if (!response.ok) return { available: false, reason: 'DAEMON_MENOLAK' };
    let body = null;
    try { body = await response.json(); } catch {}
    if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return { available: false, reason: 'PROYEKSI_TIDAK_VALID' };
    return { available: true, ...body.data };
  }
  async function daemonPost(pathname, payload, timeoutMs) {
    const token = readDaemonToken(installRoot);
    if (!token) return { available: false, reason: 'KREDENSIAL_TIDAK_TERSEDIA' };
    let response;
    try {
      response = await transport(base + pathname, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(payload || {}) });
    } catch { return { available: false, reason: 'DAEMON_TIDAK_TERJANGKAU' }; }
    // A daemon build that predates the write routes answers 404: the write
    // path activates when that daemon is next relaunched, with no further
    // change on this side.
    if (response.status === 404) return { available: false, reason: 'PROYEKSI_BELUM_AKTIF' };
    if (response.status === 400) {
      let detail = null;
      try { const b = await response.json(); if (b && typeof b.message === 'string') detail = b.message; } catch {}
      return { available: false, reason: 'VALIDASI_DITOLAK', detail };
    }
    if (!response.ok) return { available: false, reason: 'DAEMON_MENOLAK' };
    let body = null;
    try { body = await response.json(); } catch {}
    if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return { available: false, reason: 'PROYEKSI_TIDAK_VALID' };
    return { available: true, ...body.data };
  }
  // Saving the brief schedule is an ordinary Owner configuration step: no
  // approval prompt stands in front of it at any layer of this path.
  async function daemonConfigure(input) {
    const payload = {};
    if (input && typeof input.enabled === 'boolean') payload.enabled = input.enabled;
    if (input && typeof input.time === 'string') payload.time = input.time;
    return daemonPost('/api/ui/automation/config', payload, 6000);
  }
  // Run-now runs the daemon service's brief once, through the same governed
  // submit the scheduler's automatic cycle uses; the outcome is reported
  // as recorded, never dressed up.
  async function daemonRunNow() {
    return daemonPost('/api/ui/automation/run', {}, 30000);
  }
  return { daemonStatus, daemonConfigure, daemonRunNow };
}

module.exports = { createOtomasiBinding };
