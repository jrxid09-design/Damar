'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseServiceCommand } = require('./commands.cjs');

function writeCliResumeMarker(directory, sessionId) {
  if (!path.isAbsolute(directory || '') || !/^[a-f0-9]{64}$/.test(sessionId || '')) throw Error('CLI_RESTART_MARKER_INVALID');
  const file = path.join(directory, 'cli-restart-session.json'), tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ sessionId }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) { throw Object.assign(Error('CLI_RESTART_MARKER_WRITE_FAILED'), { cause: error }); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  return file;
}

async function restartCoreSession({ engine, history, sessions, confirmOwner, timeoutMs = 20000, pollMs = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!engine?.client || !history?.id) throw Error('CORE_RESTART_REQUIRES_PRIVATE_SESSION');
  const sessionId = history.id;
  await history.flush();
  const command = parseServiceCommand('/core restart');
  const accepted = await engine.dispatch(command, { signal: AbortSignal.timeout(4000), confirmOwner });
  if (accepted?.state !== 'CORE_RESTART_ACCEPTED') throw Error('CORE_RESTART_REJECTED');

  const deadline = Date.now() + timeoutMs;
  let lastState = 'UNKNOWN';
  while (Date.now() < deadline) {
    try {
      const response = await engine.client.r9('/api/r9/lifecycle');
      lastState = response.body?.data?.state?.state || 'UNKNOWN';
      if (response.ok && response.body?.success === true && lastState === 'READY') {
        await history.attach(sessionId);
        sessions?.sync();
        return { sessionId, state: 'READY' };
      }
      if (['STOP_TIMEOUT', 'RESTART_FAILED', 'STOP_FAILED'].includes(lastState)) break;
    } catch {}
    await sleep(pollMs);
  }
  throw Error(lastState === 'STOP_TIMEOUT' ? 'CORE_RESTART_STOP_TIMEOUT' : 'CORE_RESTART_READY_TIMEOUT');
}

module.exports = { restartCoreSession, writeCliResumeMarker };
