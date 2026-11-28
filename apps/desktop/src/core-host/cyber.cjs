'use strict';
// Damar Cyber binding for the desktop Core (F9): the DCD detection engine
// lives exactly once, composed in the canonical daemon (src/cyber via
// riProductionComposition; AUTHORITY_SOURCE_COUNT = 1). The desktop Core
// never composes a second engine; it reads the daemon's posture projection
// over loopback with the install credential, the same pattern the CLI uses
// (src/cli/client.js readTokenFromInstall reads <install>/.env). The token
// is read server-side on every call, used only as a Bearer header to the
// local daemon, and never returned, logged or stored by this module.
// Every failure degrades to an honest unavailable reason; nothing here
// throws into the route layer and nothing is invented when the daemon or
// its projection cannot be reached.
const fs = require('node:fs'), path = require('node:path');

function readDaemonToken(installRoot) {
  let raw;
  try { raw = fs.readFileSync(path.join(installRoot, '.env'), 'utf8'); } catch { return null; }
  for (const line of String(raw).split(/\r?\n/)) {
    const m = /^\s*DAMAR_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1];
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    if (v && v.length <= 512 && !/[\s\r\n]/.test(v)) return v;
    return null;
  }
  return null;
}

function createCyberBinding({ installRoot, fetchImpl } = {}) {
  if (!installRoot || !path.isAbsolute(installRoot)) throw Error('CYBER_INSTALL_ROOT_REQUIRED');
  const base = String(process.env.DAMAR_CYBER_DAEMON_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const transport = typeof fetchImpl === 'function' ? fetchImpl : ((...a) => fetch(...a));
  async function daemonPosture() {
    const token = readDaemonToken(installRoot);
    if (!token) return { available: false, reason: 'KREDENSIAL_TIDAK_TERSEDIA' };
    let response;
    try {
      response = await transport(base + '/api/ui/cyber/posture', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { accept: 'application/json', authorization: 'Bearer ' + token } });
    } catch { return { available: false, reason: 'DAEMON_TIDAK_TERJANGKAU' }; }
    // A daemon build that predates the posture route answers 404: the
    // projection activates when that daemon is next relaunched, with no
    // further change on this side.
    if (response.status === 404) return { available: false, reason: 'PROYEKSI_BELUM_AKTIF' };
    if (!response.ok) return { available: false, reason: 'DAEMON_MENOLAK' };
    let body = null;
    try { body = await response.json(); } catch {}
    if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return { available: false, reason: 'PROYEKSI_TIDAK_VALID' };
    return { available: true, ...body.data };
  }
  return { daemonPosture };
}

module.exports = { createCyberBinding, readDaemonToken };
