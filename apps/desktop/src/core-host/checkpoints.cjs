'use strict';
// Undo / redo of agent file changes. Every verified agent write/edit is journaled in Core (append-only, durable) with its
// exact before/after content, grouped by turn. /undo restores the latest applied turn of the session, /redo re-applies
// the latest undone one; a new agent change clears the session's redo stack. Restoration is all-or-nothing up front:
// every file must still be exactly as the agent left it (undo) or as it was before (redo), otherwise nothing is written
// (FILE_CHANGED_SINCE_AGENT). Writes go through the single-file writer process under a one-shot Core grant.
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const MAX = 512 * 1024;

function createCheckpoints({ file, appendDurable, readJsonl, writeFile, authority, protectedRoots, node }) {
  const changes = [];                       // CHANGE rows in order
  const state = new Map();                  // turnId -> 'applied' | 'undone' | 'dropped'
  const undone = new Map();                 // session -> [turnId] (redo stack, newest last)
  const stack = s => { if (!undone.has(s)) undone.set(s, []); return undone.get(s); };
  const apply = r => {
    if (r.type === 'CHANGE') { changes.push(r); state.set(r.turnId, 'applied'); }
    else if (r.type === 'UNDO') { state.set(r.turnId, 'undone'); stack(r.session).push(r.turnId); }
    else if (r.type === 'REDO') { state.set(r.turnId, 'applied'); undone.set(r.session, stack(r.session).filter(t => t !== r.turnId)); }
    else if (r.type === 'DROP') { state.set(r.turnId, 'dropped'); undone.set(r.session, stack(r.session).filter(t => t !== r.turnId)); }
  };
  for (const r of readJsonl(file)) apply(r);
  const write = row => { const r = { t: Date.now(), ...row }; appendDurable(file, r); apply(r); };
  const turnsOf = session => [...new Set(changes.filter(c => c.session === session).map(c => c.turnId))];
  // One entry per file per turn: the content before the turn's first change and after its last change.
  const filesOf = turnId => {
    const merged = new Map();
    for (const c of changes.filter(x => x.turnId === turnId)) {
      const m = merged.get(c.rel);
      if (!m) merged.set(c.rel, { ...c });
      else Object.assign(m, { after: c.after, afterSha: c.afterSha });
    }
    return [...merged.values()];
  };
  const decode = b64 => (b64 === null ? null : Buffer.from(b64, 'base64').toString('utf8'));

  function record({ session, turnId, root, rel, before, after }) {
    if (Buffer.byteLength(after) > MAX || (before !== null && Buffer.byteLength(before) > MAX)) return false;
    for (const t of stack(session).slice()) write({ type: 'DROP', session, turnId: t });   // new change: redo stack cleared
    write({ type: 'CHANGE', id: 'chg_' + crypto.randomUUID().replace(/-/g, ''), session, turnId, root, rel,
      before: before === null ? null : Buffer.from(before, 'utf8').toString('base64'), after: Buffer.from(after, 'utf8').toString('base64'),
      beforeSha: before === null ? null : sha(before), afterSha: sha(after) });
    return true;
  }
  const list = session => turnsOf(session).map(turnId => ({ turnId, state: state.get(turnId), files: filesOf(turnId).map(c => ({ path: c.rel, created: c.before === null })) }));
  const target = (session, kind) => (kind === 'undo' ? turnsOf(session).reverse().find(t => state.get(t) === 'applied') : stack(session).at(-1)) || null;

  // What /undo or /redo would do, with the precondition already checked (nothing is written here).
  function preview(session, kind) {
    const turnId = target(session, kind);
    if (!turnId) return null;
    const rows = kind === 'undo' ? filesOf(turnId).slice().reverse() : filesOf(turnId);
    const files = rows.map(c => {
      const full = path.join(c.root, c.rel);
      const current = fs.existsSync(full) ? sha(fs.readFileSync(full)) : null;
      const expected = kind === 'undo' ? c.afterSha : c.beforeSha;
      const action = kind === 'undo' ? (c.before === null ? 'delete' : 'restore') : (c.before === null ? 'recreate' : 'reapply');
      return { path: c.rel, action, unchanged: current === expected };
    });
    return { turnId, kind, files, ready: files.every(f => f.unchanged) };
  }

  async function run(session, kind, turnId) {
    const plan = preview(session, kind);
    if (!plan || plan.turnId !== turnId) throw Object.assign(Error('CHECKPOINT_NOT_CURRENT'), { status: 409 });
    if (!plan.ready) throw Object.assign(Error('FILE_CHANGED_SINCE_AGENT'), { status: 409, files: plan.files.filter(f => !f.unchanged).map(f => f.path) });
    const rows = kind === 'undo' ? filesOf(turnId).slice().reverse() : filesOf(turnId);
    const root = rows[0].root, scope = [`turn:${turnId}`, `kind:${kind}`];
    await authority.grant({ op: 'restore', scope, mode: 'once', sessionEndsAt: Date.now() + 60000, summary: `${kind} agent turn ${turnId}` });
    const invocation = 'inv-' + crypto.randomUUID();
    const result = await authority.execute({ op: 'restore', scope, parameters: { turnId, kind, files: rows.length }, invocation,
      driver: async () => {
        for (const c of rows) {
          const before = decode(c.before), after = decode(c.after);
          if (kind === 'undo') {
            if (before === null) await writeFile({ node, root, rel: c.rel, content: '', before: c.afterSha, protectedRoots, remove: true });
            else await writeFile({ node, root, rel: c.rel, content: before, before: c.afterSha, protectedRoots });
          } else await writeFile({ node, root, rel: c.rel, content: after, before: before === null ? 'absent' : c.beforeSha, protectedRoots });
        }
        return { restored: rows.length };
      },
      verify: async () => ({ checks: rows.map(c => {
        const full = path.join(c.root, c.rel), want = kind === 'undo' ? c.beforeSha : c.afterSha;
        return { name: c.rel, passed: want === null ? !fs.existsSync(full) : fs.existsSync(full) && sha(fs.readFileSync(full)) === want };
      }) }) });
    await authority.consume('restore', scope).catch(() => {});
    if (result.outcome !== 'EXECUTED_VERIFIED') throw Object.assign(Error('RESTORE_' + (result.outcome || 'FAILED')), { status: 409, reason: result.reason });
    write({ type: kind === 'undo' ? 'UNDO' : 'REDO', session, turnId });
    return { turnId, kind, files: plan.files };
  }
  return { record, list, preview, run };
}
module.exports = { createCheckpoints };
