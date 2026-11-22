'use strict';
// Revokes the folder grants the DAMAR sandbox (job-run.py) made, exactly as recorded in its grant ledgers.
// usage: node scripts/revoke-sandbox-grants.cjs <sandbox-grants.jsonl>...
// Only ACEs of the recorded AppContainer SID on the recorded paths are removed (icacls /remove:g); nothing else is touched.
// Each revocation is appended to its ledger ({..., revoked: true}) so the sandbox grants again when it next needs to.
// Core does this by itself on stop and sweeps the ledgers of crashed Cores on start (src/core-host/sandbox-lifecycle.cjs);
// this script is the manual fallback.
const { revoke } = require('../src/core-host/sandbox-lifecycle.cjs');
module.exports = { revoke };

if (require.main === module) {
  const ledgers = process.argv.slice(2);
  if (!ledgers.length) { console.error('usage: node scripts/revoke-sandbox-grants.cjs <sandbox-grants.jsonl>...'); process.exit(2); }
  const report = revoke(ledgers);
  console.log(JSON.stringify(report));
  process.exitCode = report.failed.length ? 1 : 0;
}
