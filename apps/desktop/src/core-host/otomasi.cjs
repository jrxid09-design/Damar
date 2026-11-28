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
// when the daemon or its projection cannot be reached. Read-only by design:
// no gated write route for automation config or brief runs exists yet (the
// daemon console rejects legacy action ingress), so this binding offers no
// mutation path at all.
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
  return { daemonStatus };
}

module.exports = { createOtomasiBinding };
