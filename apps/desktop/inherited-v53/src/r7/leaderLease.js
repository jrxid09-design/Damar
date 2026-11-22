const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function processIdentity(pid = process.pid) {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return `linux:${tail[19]}`;
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    try {
      if (!Number.isInteger(pid) || pid < 1) return null;
      const ticks = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks } else { 'DEAD' }`], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
      if (ticks === 'DEAD') return 'dead';
      return /^\d+$/.test(ticks) ? `win:${ticks}` : null;
    } catch (error) { return error.status === 1 ? 'dead' : null; }
  }
  try {
    process.kill(pid, 0);
    return null; // Alive but no safe creation identity available: never recover it.
  } catch (error) { return error.code === 'ESRCH' ? 'dead' : null; }
}

function isSameLiveProcess(owner) {
  if (!owner || owner.host !== os.hostname() || !Number.isInteger(owner.pid)) return null;
  const current = processIdentity(owner.pid);
  if (current === 'dead') return false;
  if (!current) return null;
  return current === owner.processStart;
}

function createLeaderLease({ directory, onAlert = () => {}, staleGraceMs = 0 }) {
  const lockPath = path.join(directory, 'leader.lock');
  const epochPath = path.join(directory, 'leader.epoch');
  let held;

  function readEpoch() {
    try {
      const n = Number(fs.readFileSync(epochPath, 'utf8'));
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid epoch');
      return n;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }
  function writeEpoch(n) {
    const tmp = `${epochPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, `${n}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, epochPath);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      onAlert({ type: 'leader-epoch-persistence-failed', error: error.message });
      throw error;
    }
  }
  function acquire() {
    fs.mkdirSync(directory, { recursive: true });
    const owner = { host: os.hostname(), pid: process.pid, processStart: processIdentity(), nonce: crypto.randomUUID() };
    if (!owner.processStart) throw new Error('Cannot safely identify this process; leadership remains OFF');
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') { onAlert({ type: 'leader-lock-persistence-failed', error: error.message }); throw error; }
      let previous;
      try { previous = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); }
      catch { onAlert({ type: 'ambiguous-leader-lock', lockPath }); throw new Error('Leader lock is ambiguous; refusing stale recovery'); }
      const alive = isSameLiveProcess(previous);
      if (alive !== false) { onAlert({ type: alive === true ? 'leader-already-live' : 'ambiguous-leader-lock', owner: previous }); throw new Error('Leader is live or its identity is ambiguous'); }
      if (staleGraceMs > 0 && Date.now() - Number(previous.createdAt || 0) < staleGraceMs) throw new Error('Stale leader lock grace period has not elapsed');
      // Move, do not recursively delete: only recover the exact lock inode observed.
      const stale = `${lockPath}.stale-${crypto.randomUUID()}`;
      fs.renameSync(lockPath, stale);
      try { fs.rmSync(stale, { recursive: true, force: false }); } catch (e) { onAlert({ type: 'stale-lock-cleanup-failed', error: e.message }); throw e; }
      return acquire();
    }
    const epoch = readEpoch() + 1;
    writeEpoch(epoch);
    const token = crypto.randomBytes(32).toString('hex');
    owner.createdAt = Date.now(); owner.epoch = epoch; owner.token = token;
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'w', mode: 0o600 });
    held = Object.freeze({ ...owner });
    return Object.freeze({ epoch, token, renew, release });
  }
  function assertCurrent() {
    if (!held) throw new Error('No active leader lease');
    let disk;
    try { disk = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); }
    catch (error) { throw new Error(`Fenced: leader lock unavailable (${error.message})`); }
    if (disk.nonce !== held.nonce || disk.epoch !== held.epoch || disk.token !== held.token || readEpoch() !== held.epoch) throw new Error('Fenced: lease is no longer current');
    return true;
  }
  function renew() { assertCurrent(); return true; }
  function release() {
    if (!held) return false;
    assertCurrent();
    fs.rmSync(lockPath, { recursive: true, force: false });
    held = undefined;
    return true;
  }
  return { acquire, assertCurrent, get current() { return held; } };
}

module.exports = { createLeaderLease, processIdentity, isSameLiveProcess };
