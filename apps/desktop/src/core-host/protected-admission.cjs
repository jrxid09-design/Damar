'use strict';
// Storage engine for a separately provisioned authority, NOT an in-process
// production witness. Its directory must be inaccessible to the Core identity.
const fs = require('node:fs'), path = require('node:path');
const deny = message => { throw Error(message); };
// Windows libuv open bits: UV_FS_O_EXLOCK = share mode 0 (no other open, rename or
// delete while held); UV_FS_O_TEMPORARY = FILE_FLAG_DELETE_ON_CLOSE (release deletes
// exactly the held object, also on crash). Never delete the lock by pathname.
const EXLOCK = 0x10000000, DELETE_ON_CLOSE = 0x40, { O_CREAT, O_EXCL, O_RDWR } = fs.constants;
const LOCK_FLAGS = O_CREAT | O_EXCL | O_RDWR | EXLOCK | DELETE_ON_CLOSE, MARKER_FLAGS = O_CREAT | O_EXCL | O_RDWR | EXLOCK;
function openAdmission({ directory, scopeId, now = Date.now }) {
  if (process.platform !== 'win32') deny('ADMISSION_PLATFORM_UNSUPPORTED');
  const file = path.join(directory, 'admission.jsonl'), lock = path.join(directory, 'admission.lock');
  // Durable write-ahead marker: survives crash and uncertain outcomes; only an administrator reconciles it.
  const marker = path.join(directory, 'admission.uncertain');
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) deny('ADMISSION_NOT_PROVISIONED');
  const directoryIdentity = fs.lstatSync(directory, { bigint: true });
  const initial = fs.lstatSync(file, { bigint: true });
  if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1n) deny('ADMISSION_OBJECT_UNSAFE');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const verify = fd => {
    const parent = fs.lstatSync(directory, { bigint: true }), named = fs.lstatSync(file, { bigint: true }), opened = fs.fstatSync(fd, { bigint: true });
    if (!same(parent, directoryIdentity) || parent.isSymbolicLink() || !same(named, initial) || !same(opened, initial) ||
        named.isSymbolicLink() || !opened.isFile() || opened.nlink !== 1n) deny('ADMISSION_OBJECT_CHANGED');
    return opened;
  };
  const withJournal = (flags, action) => {
    const fd = fs.openSync(file, flags);
    try { verify(fd); return action(fd); } finally { fs.closeSync(fd); }
  };
  const read = fd => {
    const stat = verify(fd);
    if (stat.size > 16777216n) deny('ADMISSION_STATE_LIMIT');
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) { const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) deny('ADMISSION_STATE_UNCERTAIN'); offset += count; }
    const after = verify(fd);
    if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) deny('ADMISSION_STATE_UNCERTAIN');
    const text = buffer.toString('utf8');
    if (!text.endsWith('\n')) deny('ADMISSION_STATE_UNCERTAIN');
    let previous = null;
    for (const line of text.trimEnd().split('\n')) {
      let row; try { row = JSON.parse(line); } catch { deny('ADMISSION_STATE_UNCERTAIN'); }
      if (row.scopeId !== scopeId || row.sequence !== (previous?.sequence ?? -1) + 1 || !Number.isSafeInteger(row.time) || row.time < (previous?.time ?? 0)) deny('ADMISSION_STATE_UNCERTAIN');
      if (!['revision', 'attempts', 'tokens', 'costMicros', 'expiresAt'].every(k => Number.isSafeInteger(row[k]) && row[k] >= 0) || typeof row.revoked !== 'boolean' || !Array.isArray(row.usedIds) || !row.limits || !['attempts', 'tokens', 'costMicros'].every(k => Number.isSafeInteger(row.limits[k]) && row.limits[k] > 0)) deny('ADMISSION_STATE_UNCERTAIN');
      if (previous && (row.revision < previous.revision || row.attempts < previous.attempts || row.tokens < previous.tokens || row.costMicros < previous.costMicros || JSON.stringify(row.limits) !== JSON.stringify(previous.limits))) deny('ADMISSION_STATE_UNCERTAIN');
      previous = row;
    }
    if (!previous || now() < previous.time) deny('ADMISSION_CLOCK_ROLLBACK');
    return previous;
  };
  const transaction = update => {
    let fd, markerFd, retainMarker = false;
    try { fd = fs.openSync(lock, LOCK_FLAGS, 0o600); } catch { deny('ADMISSION_LOCKED_OR_UNCERTAIN'); }
    try {
      const lockIdentity = fs.fstatSync(fd, { bigint: true });
      if (!lockIdentity.isFile() || lockIdentity.nlink !== 1n || !same(lockIdentity, fs.lstatSync(lock, { bigint: true }))) deny('ADMISSION_OBJECT_CHANGED');
      try { markerFd = fs.openSync(marker, MARKER_FLAGS, 0o600); fs.fsyncSync(markerFd); } catch { deny('ADMISSION_LOCKED_OR_UNCERTAIN'); }
      return withJournal('r+', out => {
        const state = read(out), next = update(structuredClone(state));
        next.sequence = state.sequence + 1; next.time = now();
        const position = Number(verify(out).size), data = Buffer.from(JSON.stringify(next) + '\n');
        let offset = 0;
        while (offset < data.length) { const count = fs.writeSync(out, data, offset, data.length - offset, position + offset); if (!count) deny('ADMISSION_STATE_UNCERTAIN'); offset += count; }
        fs.fsyncSync(out); verify(out);
        return structuredClone(next);
      });
    } catch (error) {
      if (/ADMISSION_(OBJECT_|STATE_UNCERTAIN)/.test(error.message) || !/^ADMISSION_/.test(error.message)) retainMarker = true;
      throw error;
    } finally {
      try {
        if (markerFd !== undefined) {
          // The share-0 marker handle cannot be renamed/replaced while open; check, close, then
          // unlink while the exclusive lock still excludes every other admission engine.
          const named = fs.lstatSync(marker, { bigint: true }), held = fs.fstatSync(markerFd, { bigint: true });
          fs.closeSync(markerFd);
          if (!retainMarker) {
            if (named.isSymbolicLink() || named.nlink !== 1n || !same(named, held)) deny('ADMISSION_OBJECT_CHANGED');
            fs.unlinkSync(marker);
          }
        }
      } finally { fs.closeSync(fd); }
    }
  };
  return Object.freeze({
    status() { if (fs.existsSync(lock) || fs.existsSync(marker)) deny('ADMISSION_LOCKED_OR_UNCERTAIN'); return withJournal('r', fd => structuredClone(read(fd))); },
    advance(expectedRevision, digest, expiresAt) {
      return transaction(s => {
        if (s.revision !== expectedRevision || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) deny('ADMISSION_STALE_OR_INVALID');
        s.revision++; s.digest = digest; s.expiresAt = expiresAt; s.revoked = false; return s;
      });
    },
    revoke(expectedRevision) { return transaction(s => { if (s.revision !== expectedRevision) deny('ADMISSION_STALE_OR_INVALID'); s.revision++; s.revoked = true; return s; }); },
    reserve({ revision, requestId, requestDigest, tokens, costMicros }) {
      return transaction(s => {
        if (s.revoked || s.revision !== revision || now() >= s.expiresAt || s.pending) deny('ADMISSION_DISABLED_OR_UNCERTAIN');
        if (!/^[a-f0-9]{64}$/.test(requestDigest || '') || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId || '') || s.usedIds.includes(requestId) || !Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isSafeInteger(costMicros) || costMicros < 0) deny('ADMISSION_INVALID_RESERVATION');
        if (s.attempts >= s.limits.attempts || s.tokens + tokens > s.limits.tokens || s.costMicros + costMicros > s.limits.costMicros) deny('ADMISSION_BUDGET_EXHAUSTED');
        s.attempts++; s.tokens += tokens; s.costMicros += costMicros;
        s.usedIds.push(requestId); s.pending = { requestId, requestDigest, tokens, costMicros }; return s;
      });
    },
    settle({ requestId, tokens, costMicros }) {
      return transaction(s => {
        const p = s.pending;
        if (!p || p.requestId !== requestId || !Number.isSafeInteger(tokens) || tokens < 0 || tokens > p.tokens || !Number.isSafeInteger(costMicros) || costMicros < 0 || costMicros > p.costMicros) deny('ADMISSION_RECEIPT_UNCERTAIN');
        // No refunds: conservative upper bounds remain charged to this scope.
        s.pending = null; return s;
      });
    },
  });
}
// Administrator-only bootstrap; never expose over the Core transport.
function provisionAdmission({ directory, scopeId, limits, now = Date.now }) {
  if (!/^[a-f0-9]{64}$/.test(scopeId) || !limits || !['attempts', 'tokens', 'costMicros'].every(k => Number.isSafeInteger(limits[k]) && limits[k] > 0)) deny('ADMISSION_PROVISION_INVALID');
  fs.mkdirSync(directory, { recursive: true });
  const fd = fs.openSync(path.join(directory, 'admission.jsonl'), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ scopeId, sequence: 0, revision: 0, digest: null, time: now(), revoked: true, expiresAt: 0, attempts: 0, tokens: 0, costMicros: 0, limits, pending: null, usedIds: [] }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
module.exports = { openAdmission, provisionAdmission };
