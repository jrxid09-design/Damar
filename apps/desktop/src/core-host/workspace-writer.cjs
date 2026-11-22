'use strict';
// Narrow workspace write authority (replaces the former in-process write-guard bypass). The Core host keeps its
// scratch-only output guard; an approved write/edit is carried out by THIS separate, short-lived process, spawned only by
// the capability driver after Core authorized the exact request. Contract: exactly one regular file, given as a path
// relative to the workspace root, read as JSON on stdin:
//   { root, rel, contentB64, before: 'absent' | 'any' | <sha256 of the current content>, protectedRoots: [...] }
// Checks (fail closed): every component from the root to the target directory is a real directory (no symlink/junction:
// lstat + realpath equals the lexical path); the target is absent or a regular single-link file; nothing is under a
// protected root; the content precondition holds. Content goes to an exclusive temp file (wx) in the target directory,
// is fsynced, the chain is re-verified, then renamed over the target and verified again.
// Output: one JSON line { ok, sha256 } or { ok: false, error }.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isProtected } = require('./workspace-tools.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const low = p => path.resolve(p).toLowerCase();
const fail = code => { throw Object.assign(Error(code), { code }); };

// A component must exist as a real directory whose real path is exactly its lexical path (catches junctions/symlinks).
function realDir(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('REPARSE_OR_NOT_DIRECTORY');
  if (low(fs.realpathSync.native(p)) !== low(p)) fail('REPARSE_POINT_IN_PATH');
}
function chain(root, dir, create = false) {
  let cur = root; realDir(cur);
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    if (create && !fs.lstatSync(cur, { throwIfNoEntry: false })) fs.mkdirSync(cur);   // one level at a time, never recursive through a link
    realDir(cur);
  }
}

function write({ root, rel, contentB64, before, protectedRoots, remove = false }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof rel !== 'string' || !rel || rel.length > 400 || rel.includes('\0') || path.isAbsolute(rel) || /[:*?"<>|]/.test(rel)) fail('PATH_INVALID');
  if (!Array.isArray(protectedRoots) || typeof contentB64 !== 'string') fail('REQUEST_INVALID');
  root = path.resolve(root);
  const target = path.resolve(root, rel), dir = path.dirname(target);
  if (!low(target).startsWith(low(root) + path.sep)) fail('OUTSIDE_WORKSPACE');
  if (isProtected(root, protectedRoots) || isProtected(target, protectedRoots)) fail('PROTECTED_PATH');
  const content = Buffer.from(contentB64, 'base64');
  if (content.length > 512 * 1024) fail('CONTENT_TOO_LARGE');
  chain(root, dir, true);
  const existing = fs.lstatSync(target, { throwIfNoEntry: false }) || null;   // never follows a link (a denied target must not read as absent)
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1)) fail('TARGET_NOT_REGULAR_FILE');
  if (existing && low(fs.realpathSync.native(target)) !== low(target)) fail('REPARSE_POINT_IN_PATH');
  if (before === 'absent' && existing) fail('TARGET_EXISTS');
  if (before !== 'absent' && before !== 'any' && (!existing || sha(fs.readFileSync(target)) !== before)) fail('FILE_CHANGED_SINCE_READ');
  // Delete mode (undo of a created file): only an existing regular file whose content still matches `before`.
  if (remove === true) {
    if (!existing || before === 'absent' || before === 'any') fail('REMOVE_NEEDS_EXACT_CONTENT');
    chain(root, dir);
    fs.unlinkSync(target);
    if (fs.existsSync(target)) fail('REMOVE_FAILED');
    return { ok: true, removed: true };
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.damar-tmp`);
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    chain(root, dir);   // re-verified immediately before the rename (narrows the swap window)
    if (low(fs.realpathSync.native(tmp)) !== low(tmp)) fail('REPARSE_POINT_IN_PATH');
    fs.renameSync(tmp, target);
  } catch (error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
  chain(root, dir);
  if (low(fs.realpathSync.native(target)) !== low(target)) fail('ESCAPED_AFTER_RENAME');
  const written = fs.readFileSync(target);
  if (sha(written) !== sha(content)) fail('CONTENT_MISMATCH_AFTER_WRITE');
  return { ok: true, sha256: sha(written) };
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { input += d; if (input.length > 1024 * 1024) { process.stdout.write(JSON.stringify({ ok: false, error: 'REQUEST_TOO_LARGE' }) + '\n'); process.exit(2); } });
  process.stdin.on('end', () => {
    let result;
    try { result = write(JSON.parse(input)); } catch (e) { result = { ok: false, error: /^[A-Z_]{3,60}$/.test(e.code || '') && !/^E[A-Z]+$/.test(e.code) ? e.code : 'FS_' + String(e.code || 'FAILED').replace(/[^A-Z]/g, '').slice(0, 20) }; }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  });
}
module.exports = { write };
