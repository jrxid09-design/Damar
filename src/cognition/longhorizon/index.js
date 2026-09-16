"use strict";

/**
 * W7-L7 GOVERNED LONG-HORIZON AUTONOMY CONVERGENCE.
 *
 * ACC subdomain `src/cognition/longhorizon/**` — COMPOSITION ONLY, owns no
 * new domain state (task card). Composes W7-L1..L6 into one bounded cycle.
 *
 * HARD BOUNDARY (verified structurally by tests/wave7/l7/convergenceAdversarial.test.js
 * scanning this module's own source, same pattern as MC-A5):
 *   this module imports NOTHING from src/action/** or src/authority/**.
 *   No function here ever constructs an ActionIntent, an authProof, or an
 *   AuthorityDecision. A cycle's plan/goal output is returned to the CALLER
 *   as data only — forming a real intent and evaluating it through Authority
 *   is the composition root's job, outside this module, through the
 *   existing Wave4 Action Intent / Authority owners.
 *
 * MODES (ARCH-Q-02, TC-ACC-03):
 *   off      -> cycle() is a no-op, returns null immediately.
 *   shadow   -> cycle() runs the full observe/evaluate pass; the return
 *               value is tagged decisionInfluence:false and nothing outside
 *               this module currently reads it (SHADOW = zero decision
 *               influence by the simple fact that no consumer exists yet).
 *   governed -> cycle() additionally returns a GovernedCognitiveProjection —
 *               a frozen, schema-checked read-only summary with no
 *               authority-shaped field, safe for a FUTURE Manager consumer
 *               to read as one advisory input alongside REQUEST_CLASS
 *               classification. This module does not itself wire that
 *               consumer — Manager's internal request-handling logic is
 *               untouched by this integration pass (see freeze evidence).
 */

const { BOUNDS } = require("./bounds");
const { laws } = require("./laws");
const { createSelfModel } = require("../selfmodel");
const { createWorldModel } = require("../worldmodel");
const { createGoalEngine } = require("../goals");
const { createProspectiveMemory } = require("../prospective");
const { createAttentionEconomy } = require("../attention");
const { createMetacognition } = require("../metacog");
// FG-03: MODES/AUTHORITY_SHAPED_KEYS/assertNoAuthorityShapedFields/
// resolveMode/isInfluenceAllowed now live in src/cognition/governed/**
// (the canonical, reusable governed-mode foundation) -- longhorizon was
// their first producer and is now just their first consumer, so no
// behavior changes here, only the ownership of these guarantees.
const {
    AUTHORITY_SHAPED_KEYS, assertNoAuthorityShapedFields, resolveMode, isInfluenceAllowed,
    recordModeTransition, recordModeTransitionChecked
} = require("../governed");

const BELIEF_RANK = Object.freeze({ USABLE: 3, DEGRADED: 2, UNUSABLE: 1, UNKNOWN: 0 });

async function createLongHorizonCycle({
    mode = "off", capabilityRegistry, clock = { nowMs: () => Date.now() },
    stores = {}, auditLedger = null, bounds = BOUNDS, requireAudit = false
} = {}) {

    mode = resolveMode(mode);

    if (mode === "off") {
        // GATE-W7-10: OFF => nothing is even constructed. Zero footprint.
        return Object.freeze({
            schemaVersion: require("./bounds").SCHEMA_VERSION,
            mode: "off", laws,
            async cycle() { return null; }
        });
    }

    // Bug review independen (audit putaran-52, W7R52-P2-2): `stores.X`
    // adalah [[Get]] mentah -- Proxy yang di-revoke pada `stores`
    // melempar TypeError mentah, sebelum tiap lane sempat menerima
    // `store: null` (jalur "tanpa persistence" yang sudah aman).
    let safeStores;
    try {
        safeStores = stores || {};
    } catch {
        safeStores = {};
    }
    const storeFor = (key) => {
        try {
            return safeStores[key] ?? null;
        } catch {
            return null;
        }
    };

    // Bug review independen (audit putaran-54, Codex, AUD54-P2-1): `clock`
    // sendiri milik lapisan komposisi L7 ini (dipakai di buildGovernedProjection,
    // TERPISAH dari clock yang diteruskan ke 6 lane anak) tidak pernah
    // dinormalisasi -- Proxy `clock` yang di-revoke raw-throw pas
    // `clock.nowMs()`, menggagalkan seluruh siklus governed. Pola fallback
    // sama seperti now() 6 lane anak (putaran-53) diterapkan di sini.
    function safeNowMs() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }
    // TRANSITION RECORDING IS SCOPED TO GOVERNED, and that scoping is a
    // deliberate, documented boundary rather than an omission:
    //
    //  - ADR-17's "mode gate" is the gate that governs DECISION INFLUENCE.
    //    `isInfluenceAllowed` is true only for governed; shadow is
    //    decisionInfluence:false ALWAYS by contract, so an unrecorded shadow
    //    initialization cannot influence any decision. Governed -- the one mode
    //    that permits ADVISORY_ONLY influence -- is the transition whose
    //    recording is safety-relevant, and it is recorded fail-closed below.
    //  - Recording shadow into the caller-supplied ledger additionally violates
    //    the frozen W7-L7 per-cycle audit cap contract (its "audit ledger tidak
    //    boleh menerima lebih dari MAX_AUDIT_EVENTS_PER_CYCLE event per siklus"
    //    assertion counts every append into that ledger, so a construction-time
    //    event becomes a third entry against a cap of two). Recording shadow
    //    would therefore require weakening a frozen Wave7 contract test, which
    //    is explicitly out of bounds.
    //
    // NO LEDGER IS MANUFACTURED HERE. An earlier revision created its own
    // `createAuditLedger()` and called it "canonical"; that was wrong on two
    // counts (audit of 9e7b8df): a fresh sinkless in-memory ledger per
    // construction is disposable and shares nothing with the durable ledger the
    // runtime and `ownerTrustComposition` actually own, and manufacturing an
    // authority-adjacent record sink inside a cognition lane is exactly the
    // ownership creep FG-03 must not do. The ledger is BOUND BY THE CALLER --
    // `canonicalRuntimeComposition` supplies the canonical one -- so governed
    // either records into a real sink or honestly reports that it could not.
    if (mode === "governed") {
        const transition = recordModeTransitionChecked({
            auditLedger: auditLedger == null ? null : auditLedger,
            from: "off", to: mode, at: safeNowMs()
        });

        // FAIL-CLOSED (audits of 0b8abb7 / 9e7b8df): a ledger that was SUPPLIED
        // and did not confirm a durable append means the required audited
        // transition did not happen. Proceeding into an unaudited GOVERNED mode
        // would be exactly the fail-open transition ADR-17 forbids, so the mode
        // degrades to "off" -- with no lane constructed, mirroring "off".
        //
        // `requireAudit: false` (the default) keeps the Wave7 L7 convergence
        // contract's `mode: "governed"` construction with no ledger intact --
        // that is a DECLARED configuration (auditSupplied:false), not a
        // silent failure. The PRODUCTION runtime passes `requireAudit: true`,
        // which additionally refuses to start governed with NO ledger at all:
        // resolving a null ledger was otherwise indistinguishable from success,
        // so governed could start with no canonical durable record even after
        // the sinkless fallback was removed (audit of 406553b).
        //
        // Normalisasi GAGAL-TUTUP: `requireAudit === true` membuat nilai
        // truthy yang salah bentuk (mis. `1` atau "true") justru MEMATIKAN
        // persyaratannya -- kebalikan dari yang dimaksudkan pemanggil (audit
        // 7677a0f). Sekarang setiap nilai truthy menuntut audit, sehingga
        // konfigurasi yang salah bentuk tidak pernah melemahkan penjaga ini.
        const auditRequired = Boolean(requireAudit);
        if (transition.failedOpen || (auditRequired && auditLedger == null)) {
            return Object.freeze({
                schemaVersion: require("./bounds").SCHEMA_VERSION,
                mode: "off", laws,
                auditUnavailable: true,
                async cycle() { return null; }
            });
        }
    }

    const selfModel = await createSelfModel({ capabilityRegistry, clock, store: storeFor("selfmodel") });
    const worldModel = await createWorldModel({ clock, store: storeFor("worldmodel") });
    const goals = await createGoalEngine({ clock, store: storeFor("goals") });
    const prospective = await createProspectiveMemory({ clock, store: storeFor("prospective") });
    const attention = await createAttentionEconomy({ clock });
    const metacog = await createMetacognition({ clock });

    // --- L1-R1 closure: diff-based downgrade/eviction observer -----------
    // Reads ONLY selfModel.snapshot()'s existing frozen output — no change
    // to L1's public contract. Emits real Audit Ledger events when a real
    // ledger is supplied; always returns the events either way so tests can
    // verify the detection logic independent of ledger wiring.
    // Bug review independen (audit putaran-29, AUD29-ADV-1): tidak punya
    // MAX_* sendiri, tapi setiap panggilan MENGGANTI seluruh Map dari
    // `snap.capabilityAssessments` (baris di bawah), yang sudah dibatasi
    // selfModel's MAX_CAPABILITY_ASSESSMENTS -- terikat transitif, bukan
    // kebocoran independen.
    let previousAssessments = new Map(); // capabilityId -> selfBelief

    function auditSelfModelTransitions() {
        const snap = selfModel.snapshot();
        const events = [];
        const seenIds = new Set();

        for (const a of snap.capabilityAssessments) {
            seenIds.add(a.capabilityId);
            const prev = previousAssessments.get(a.capabilityId);
            if (prev !== undefined && BELIEF_RANK[a.selfBelief] < BELIEF_RANK[prev]) {
                events.push({ eventType: "cognition.selfmodel.downgrade", source: "acc.longhorizon",
                    outcome: "ok", metadata: { capabilityId: a.capabilityId, from: prev, to: a.selfBelief } });
            }
        }
        for (const [capabilityId, prevBelief] of previousAssessments) {
            if (!seenIds.has(capabilityId)) {
                events.push({ eventType: "cognition.selfmodel.eviction", source: "acc.longhorizon",
                    outcome: "ok", metadata: { capabilityId, lastKnownBelief: prevBelief } });
            }
        }

        previousAssessments = new Map(snap.capabilityAssessments.map(a => [a.capabilityId, a.selfBelief]));

        // Bug review independen (Codex putaran-8): satu siklus bisa memancarkan
        // satu event per kapabilitas terlacak (hingga batas selfModel 2048),
        // jauh melampaui MAX_AUDIT_EVENTS_PER_CYCLE (256) -- membanjiri audit
        // ledger. Dibatasi eksplisit di sini, per siklus.
        // Bug review independen (audit putaran-52, W7R52-P2-2): `bounds.
        // MAX_AUDIT_EVENTS_PER_CYCLE` adalah [[Get]] mentah terhadap
        // `bounds` yang bisa dioverride pemanggil -- Proxy yang di-revoke
        // raw-throw di sini. Jatuh ke default BOUNDS asli kalau tidak sah.
        let maxAuditEvents;
        try {
            maxAuditEvents = bounds.MAX_AUDIT_EVENTS_PER_CYCLE;
        } catch {
            maxAuditEvents = BOUNDS.MAX_AUDIT_EVENTS_PER_CYCLE;
        }
        if (!Number.isInteger(maxAuditEvents) || maxAuditEvents < 0) {
            maxAuditEvents = BOUNDS.MAX_AUDIT_EVENTS_PER_CYCLE;
        }
        const bounded = events.slice(0, maxAuditEvents);

        // Bug review independen (audit putaran-52, W7R52-P2-1): cek tipe
        // `typeof auditLedger.append === "function"` sendiri berada DI
        // LUAR try -- Proxy yang di-revoke (atau getter `append` yang
        // melempar) melempar mentah persis pada [[Get]] cek ini, SEBELUM
        // try di baris berikutnya sempat menangkapnya. Kontrak "audit
        // failure never blocks cognition" dilanggar oleh guard-nya
        // sendiri. Cek tipe DAN panggilan sekarang dalam SATU try.
        for (const event of bounded) {
            try {
                if (auditLedger && typeof auditLedger.append === "function") {
                    auditLedger.append(event);
                }
            } catch { /* audit failure never blocks cognition */ }
        }
        return bounded;
    }

    function buildGovernedProjection() {
        const selfSnap = selfModel.snapshot();
        const openContradictions = worldModel.openContradictions();
        // Bug review independen (audit putaran-3, AUD3-P2-1): `attention.pick()`
        // MENGOMIT kredit round-robin dan memindahkan target ke RUNNING --
        // proyeksi "advisory-only"/read-only ini tidak boleh punya efek
        // samping pada penjadwalan nyata. `peekTopTarget()` murni baca.
        const pick = attention.peekTopTarget();

        const projection = Object.freeze({
            schemaVersion: "governedCognitiveProjection.v1",
            generatedAtMs: safeNowMs(),
            selfModel: Object.freeze({
                capabilityCount: selfSnap.capabilityAssessments.length,
                unknownCount: selfSnap.unknowns.length,
                healthState: selfSnap.healthState
            }),
            worldModel: Object.freeze({ openContradictionCount: openContradictions.length }),
            attentionFocus: pick ? Object.freeze({ targetId: pick.targetId, workKind: pick.workKind }) : null,
            decisionInfluence: "ADVISORY_ONLY"
        });

        assertNoAuthorityShapedFields(projection, "GovernedCognitiveProjection");
        assertNoAuthorityShapedFields(projection.selfModel, "GovernedCognitiveProjection.selfModel");
        return projection;
    }

    async function cycle() {
        const auditEvents = auditSelfModelTransitions();
        const reminders = prospective.tick();
        const contradictions = worldModel.openContradictions();

        const result = {
            mode, decisionInfluence: isInfluenceAllowed(mode) ? "ADVISORY_ONLY" : false,
            auditEvents, remindersFired: reminders.length, openContradictions: contradictions.length
        };

        if (mode === "governed") {
            result.projection = buildGovernedProjection();
        }

        return Object.freeze(result);
    }

    return Object.freeze({
        schemaVersion: require("./bounds").SCHEMA_VERSION,
        mode, laws,
        cycle,
        // Exposed for convergence tests / future integration-window wiring —
        // read-only references to the composed lanes, never new state here.
        lanes: Object.freeze({ selfModel, worldModel, goals, prospective, attention, metacog })
    });
}

module.exports = { createLongHorizonCycle, laws, AUTHORITY_SHAPED_KEYS };
