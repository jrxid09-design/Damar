'use strict';
const fs = require('node:fs'), path = require('node:path');
function receipt(client, value) {
  if (!client.sessionDirectory) return;
  const file = path.join(client.sessionDirectory, 'provider-apply-receipt.json');
  const tmp = file + '.tmp';
  // Allowlist only: no URL, credentials, error payloads, or replayable request body.
  const safe = { provider: value.provider, model: value.model || null, phase: value.phase, time: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(safe), { mode: 0o600 }); fs.renameSync(tmp, file);
}
async function reconcile(client) {
  if (!client.sessionDirectory) return null;
  const file = path.join(client.sessionDirectory, 'provider-apply-receipt.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw Error('PROVIDER_RECEIPT_UNREADABLE'); }
  if (['COMPLETE', 'REJECTED', 'RECONCILED'].includes(saved.phase)) return null;
  const r = await client.r9('/api/r9/provider');
  if (!r.ok) throw Error('PROVIDER_RECONCILIATION_UNAVAILABLE');
  const row = r.body?.data?.providers?.find(p => p.id === saved.provider);
  return { state: 'OUTCOME_UNKNOWN', phase: saved.phase, provider: saved.provider,
    active: r.body?.data?.active, model: row?.model || null, hasKey: row?.hasKey === true,
    keyRemembered: row?.keyRemembered === true, replayed: false };
}
module.exports = { receipt, reconcile };
