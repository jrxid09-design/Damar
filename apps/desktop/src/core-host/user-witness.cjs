'use strict';
// v1 user-level rollback witness (Owner decision 2026-11-21): compare-and-swap anchor for the
// model-grant journal, kept outside Core's session directory in the protected-admission engine.
// ponytail: runs under the same Windows account as Core, so it detects journal restore/rollback,
// not same-user malware; upgrade path is the DamarProtectedAuthority service (windows-authority/).
const fs = require('node:fs'), path = require('node:path');
const { openAdmission, provisionAdmission } = require('./protected-admission.cjs');
const FAR = 10 * 365 * 86400000;
function createUserWitness({ root, now = Date.now }) {
  const directory = scopeId => {
    if (!/^[a-f0-9]{64}$/.test(scopeId)) throw Error('WITNESS_SCOPE_INVALID');
    return path.join(root, scopeId);
  };
  const provisioned = scopeId => fs.existsSync(path.join(directory(scopeId), 'admission.jsonl'));
  const engine = scopeId => openAdmission({ directory: directory(scopeId), scopeId, now });
  const same = (state, value) => state.revision === value.revision && state.digest === value.digest;
  return Object.freeze({
    verify(scopeId, value) {
      try {
        // A missing anchor only vouches for an empty journal; anything else fails closed.
        if (!provisioned(scopeId)) return value.revision === 0 && value.digest === null;
        return same(engine(scopeId).status(), value);
      } catch { return false; }
    },
    advance(scopeId, previous, next) {
      try {
        if (next.revision !== previous.revision + 1) return false;
        if (!provisioned(scopeId)) {
          if (previous.revision !== 0 || previous.digest !== null) return false;
          provisionAdmission({ directory: directory(scopeId), scopeId, limits: { attempts: 1, tokens: 1, costMicros: 1 }, now });
        }
        const e = engine(scopeId);
        if (!same(e.status(), previous)) return false;
        return same(e.advance(previous.revision, next.digest, now() + FAR), next);
      } catch { return false; }
    },
  });
}
module.exports = { createUserWitness };
