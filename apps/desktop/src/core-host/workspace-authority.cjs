'use strict';
// Real DAMAR Core authority for the CLI's consequential workspace tools (host bridge; no canonical file is edited).
// Owner-approved deviation (2026-11-15): Core's Manager.handle() only executes capabilities Core registers itself, so the
// host uses Core's own pieces directly:
//   - the isolated Core's vault-enrolled Owner (enrolled once per Core data directory),
//   - one genuine Owner-ratified, scoped grant per approved exact request (proposeEvolution -> ratifyAsOwner with a
//     self-signed Owner proof -> provisionAuthority), each with its own capability id because Core keeps one grant per id,
//   - a host-owned instance of Core's CanonicalCapabilityExecution with Core's replay ledger + rollback witness and
//     Core's audit acknowledger; every execution is authorized by loadAndEvaluateAuthority against the real store.
// "Allow once" = maxExecutions 1, consumed right after the call. "Allow always this session" = expires at session end.
const crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const OWNER = 'owner-cli-local';

function createWorkspaceAuthority({ coreSrc, dataDir }) {
  const core = m => require(path.join(coreSrc, m));
  let ready = null;
  function init() {
    if (ready) return ready;
    ready = (async () => {
      const comp = await core('authority/ownerTrustComposition.js').ensureCanonicalComposed();
      if (comp.registry.getState?.() !== 'ACTIVE') {
        const ceremony = await comp.firstOwnerBootstrap.begin({ principalId: OWNER, mode: 'damar-vault' });
        await comp.firstOwnerBootstrap.complete({ ceremonyId: ceremony.ceremonyId, signature: null });
      }
      const prod = await core('authority/productionComposition.js').ensureProductionAuthorityComposed();
      const owner = comp.registry.getOwner();
      if (!owner || !prod?.canonicalOwner) throw Error('CORE_AUTHORITY_UNAVAILABLE');
      const { CanonicalCapabilityExecution } = core('manager/internal/canonicalCapabilityExecution.js');
      const { createCanonicalReplayLedger } = core('manager/internal/canonicalReplayLedger.js');
      const { createCanonicalReplayWitness } = core('manager/internal/canonicalReplayWitness.js');
      const { createCanonicalAuditAcknowledger } = core('manager/internal/canonicalAuditAcknowledger.js');
      fs.mkdirSync(path.join(dataDir, 'audit'), { recursive: true });
      const replayStore = createCanonicalReplayLedger({ file: path.join(dataDir, 'workspace-replay.sqlite'),
        rollbackAnchor: createCanonicalReplayWitness(path.join(dataDir, 'workspace-replay.witness.jsonl')) });
      const bridge = new CanonicalCapabilityExecution({ replayStore });
      bridge.installAuditAcknowledger(createCanonicalAuditAcknowledger({ dir: path.join(dataDir, 'audit') }));
      return { comp, prod, owner, bridge, evaluate: core('authority/evaluate.js').loadAndEvaluateAuthority, registered: new Set(), pending: new Map() };
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  // One capability id per exact request: operation + scope tokens (path or command, and the workspace root).
  const capabilityFor = (op, scope) => `damar.ws.${op}.${sha(scope.join('|')).slice(0, 20)}`;

  async function evaluate(op, scope) {
    const a = await init();
    return a.evaluate(a.prod.canonicalOwner.store, { capabilityId: capabilityFor(op, scope), action: op, scope, identity: { principalId: a.owner.principalId }, nowMs: Date.now() });
  }

  // Mint the Owner-ratified grant for one approved request. mode: 'once' | 'session'.
  async function grant({ op, scope, mode, sessionEndsAt, summary }) {
    const a = await init();
    const capabilityId = capabilityFor(op, scope);
    const expires = new Date(mode === 'session' ? sessionEndsAt : Date.now() + 120000).toISOString();
    const proposalId = 'cli-' + crypto.randomUUID(), ratificationId = 'cli-rat-' + crypto.randomUUID();
    await a.prod.canonicalOwner.proposeEvolution({ proposalId, kind: 'authority_expansion', createdBy: 'damar-cli',
      problem: String(summary || op).slice(0, 500), proposedChange: `Allow ${op} on ${scope[0]} (${mode === 'session' ? 'this session' : 'once'})`,
      requestedAuthority: { capabilityId, subject: a.owner.principalId, actions: [op], scope, maxExecutions: mode === 'session' ? 1000 : 1, expiresAt: expires } });
    const proof = await a.comp.selfSignOwnerProof({ purpose: 'owner-proof' });
    if (!proof) throw Error('OWNER_PROOF_UNAVAILABLE');
    const ratified = await a.prod.ratifyAsOwner({ proof, ratification: { ratificationId, proposalId, decision: 'APPROVED', expiryAt: expires } });
    if (ratified?.applied === false) throw Error('RATIFICATION_REFUSED_' + (ratified.reasonCode || 'UNKNOWN'));
    const minted = await a.prod.provisionAuthority({ proposalId, ratificationId });
    if (!minted?.allowed) throw Error('GRANT_NOT_ISSUED_' + (minted?.reasonCode || 'UNKNOWN'));
    return { capabilityId, expiresAt: expires, mode };
  }

  // Execute one approved request through Core's capability execution bridge (authorize -> replay guard -> driver ->
  // verifier -> audit). `invocation` makes each run a distinct request so a repeated command is not a replay.
  async function execute({ op, scope, parameters, driver, verify, invocation }) {
    const a = await init();
    const capabilityId = capabilityFor(op, scope);
    // The bridge binds one driver per capability id for its lifetime; a session grant reuses the id across calls, so the
    // registered driver/verifier dispatch to THIS invocation's closures (keyed by the invocation id in the parameters).
    if (!a.registered.has(capabilityId)) {
      const of = p => a.pending.get(p?.invocation) || null;
      a.bridge.registerCapability({ capabilityId, operation: op, driverId: 'damar-cli-workspace', driver: req => { const x = of(req.parameters); if (!x) throw Error('INVOCATION_UNKNOWN'); return x.driver(req); } });
      a.bridge.registerVerifier(capabilityId, (p, result) => { const x = of(p); return x ? x.verify(p, result) : { checks: [{ name: 'invocation known', passed: false }] }; });
      a.registered.add(capabilityId);
    }
    const evaluation = await a.evaluate(a.prod.canonicalOwner.store, { capabilityId, action: op, scope, identity: { principalId: a.owner.principalId }, nowMs: Date.now() });
    if (!evaluation.allowed) return { outcome: 'DENIED', reason: evaluation.reasonCode, effectInvoked: false };
    a.pending.set(invocation, { driver, verify });
    try { return await a.bridge.execute({ capabilityId, operation: op, parameters: { ...parameters, invocation }, evaluation, requestId: invocation }); }
    finally { a.pending.delete(invocation); }
  }

  async function consume(op, scope) { const a = await init(); return a.prod.canonicalOwner.consumeExecution(capabilityFor(op, scope)); }

  return { init, grant, evaluate, execute, consume, capabilityFor, owner: OWNER };
}
module.exports = { createWorkspaceAuthority };
