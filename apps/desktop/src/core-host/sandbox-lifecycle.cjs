'use strict';
// Sandbox grant lifecycle. job-run.py grants the DAMAR AppContainer folder access (Modify on the workspace, Read+Execute
// on interpreter folders) and records every grant in the Core session's ledger. This module:
//  - revoke(ledgers): removes exactly the recorded ACEs (icacls /remove:g on the recorded AppContainer SID) and appends
//    a revocation row per grant; nothing else is touched;
//  - a registry of live Core sessions (ledger + owning pid). On start a Core sweeps it: the ledgers of Cores that are no
//    longer running (crashed, killed) are revoked and dropped. On a normal stop a Core revokes its own grants.
// ponytail: liveness is "pid exists" - a reused pid only delays the sweep until that process exits (never revokes the
// grants of a live Core); a registry rewrite racing a second Core starting at the same instant can drop that Core's row
// (its grants are then revoked on its own stop, not by a sweep).
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');

const SID = /^S-1-15-2(-\d+){7}$/;
const readRows = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; } };

// The grants a ledger still holds (granted and not revoked since).
function liveGrants(ledger) {
  const rows = readRows(ledger); if (!rows) return null;
  const live = new Map();
  for (const r of rows) {
    if (!SID.test(String(r.sid)) || typeof r.path !== 'string' || typeof r.rights !== 'string') continue;
    const key = r.sid + '|' + r.path.toLowerCase() + '|' + r.rights;
    if (r.revoked) live.delete(key); else live.set(key, r);
  }
  return [...live.values()];
}

function revoke(ledgers) {
  const report = { revoked: [], missing: [], failed: [] };
  for (const ledger of ledgers) {
    const live = liveGrants(ledger);
    if (!live) { if (fs.existsSync(ledger)) report.failed.push({ ledger, error: 'LEDGER_UNREADABLE' }); continue; }
    for (const r of live) {
      const mark = () => fs.appendFileSync(ledger, JSON.stringify({ ...r, t: Date.now(), revoked: true }) + '\n');
      if (!fs.existsSync(r.path)) { report.missing.push(r.path); mark(); continue; }
      const run = spawnSync('icacls', [r.path, '/remove:g', '*' + r.sid, '/Q'], { encoding: 'utf8', windowsHide: true });
      if (run.status !== 0) { report.failed.push({ ledger, path: r.path, error: (run.stdout + run.stderr).trim().slice(0, 200) }); continue; }
      mark(); report.revoked.push(r.path);
    }
  }
  return report;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function createSandboxLifecycle({ registry, ledger, pid = process.pid, isAlive = alive }) {
  const entries = () => (readRows(registry) || []).filter(r => typeof r.ledger === 'string' && Number.isSafeInteger(r.pid));
  const rewrite = rows => { const tmp = registry + '.' + pid + '.tmp'; fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); fs.renameSync(tmp, registry); };
  return {
    // Crash recovery: revoke and forget the ledgers of Cores that are gone.
    sweep() {
      const rows = entries(), stale = rows.filter(r => r.pid !== pid && !isAlive(r.pid));
      const report = revoke([...new Set(stale.map(r => r.ledger))]);
      if (stale.length) rewrite(rows.filter(r => !stale.includes(r) || report.failed.some(f => f.ledger === r.ledger)));
      return { swept: stale.length, ...report };
    },
    register() {
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      const report = this.sweep();
      fs.appendFileSync(registry, JSON.stringify({ t: Date.now(), ledger, pid }) + '\n');
      return report;
    },
    // Normal stop: revoke this Core's grants and drop its registry row. Idempotent.
    release() {
      const report = revoke([ledger]);
      if (!report.failed.length) rewrite(entries().filter(r => !(r.pid === pid && r.ledger === ledger)));
      return report;
    },
  };
}
module.exports = { revoke, liveGrants, createSandboxLifecycle };
