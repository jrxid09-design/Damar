const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
    MODES, AUTHORITY_SHAPED_KEYS, assertNoAuthorityShapedFields,
    resolveMode, isInfluenceAllowed, validateGovernedCognitiveProjection,
    recordModeTransition, recordModeTransitionChecked
} = require("../../../src/cognition/governed");

/**
 * Ledger KANONIK bermerek DENGAN SINK, dipakai untuk kasus "terkonfirmasi".
 *
 * Konfirmasi menuntut TIGA hal, dan ketiganya pernah menjadi celah:
 *  1. objeknya ledger kanonik (merek leksikal -- tidak bisa dipalsukan oleh
 *     tiruan yang menggemakan apa yang diterimanya, audit cd3dedf / bd45f18);
 *  2. konfirmasi memakai append DURABEL, sehingga ledger tanpa sink melempar
 *     NO_SINK dan gagal-tutup (audit bd45f18: merek membuktikan asal-pabrik,
 *     bukan durabilitas);
 *  3. rekamannya dapat dibaca kembali dan cocok dengan event yang di-append.
 * Sink di sini di memori; jalur file nyata diuji terpisah lewat owner-trust.
 */
function recordingLedger() {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");
    // Sink DURABEL nyata (file + fsync), bukan sink in-memory: sejak audit
    // 7677a0f sebuah konfirmasi menuntut bukti bahwa ledger benar-benar MAMPU
    // menulis durabel, dan hanya sink milik lane ini yang dihitung.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-rec-"));
    const file = path.join(dir, "audit-ledger.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = createAuditLedger({ sink, resume: sink.describeDurable() });
    return Object.freeze({
        ledger,
        file,
        writes: () => (fs.existsSync(file)
            ? fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim().length > 0)
            : []),
        close: () => { try { sink.close(); } catch { /* ignore */ } }
    });
}

/** Ledger kanonik bermerek yang SIAP dipakai sebagai `auditLedger`. */
function recordingLedgerFor() {
    return recordingLedger().ledger;
}

test("FG03-1: resolveMode passes through exactly the three sanctioned modes", () => {
    assert.equal(resolveMode("off"), "off");
    assert.equal(resolveMode("shadow"), "shadow");
    assert.equal(resolveMode("governed"), "governed");
});

test("FG03-2: resolveMode fails closed to 'off' for anything unrecognized -- restart/recovery can never resume into a live/permissive mode by accident", () => {
    assert.equal(resolveMode(undefined), "off");
    assert.equal(resolveMode(null), "off");
    assert.equal(resolveMode(""), "off");
    assert.equal(resolveMode("GOVERNED"), "off", "case-sensitive, no coercion");
    assert.equal(resolveMode("live"), "off");
    assert.equal(resolveMode(123), "off");
    assert.equal(resolveMode({ toString: () => "governed" }), "off", "no coercion of a hostile object");
});

test("FG03-3: resolveMode fails closed (not raw-throw) on a revoked Proxy mode value", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.equal(resolveMode(proxy), "off");
});

test("FG03-4: isInfluenceAllowed is true only for governed, per ADR-17 (shadow is decisionInfluence:false ALWAYS, by contract)", () => {
    assert.equal(isInfluenceAllowed("governed"), true);
    assert.equal(isInfluenceAllowed("shadow"), false);
    assert.equal(isInfluenceAllowed("off"), false);
    assert.equal(isInfluenceAllowed("anything-else"), false);
});

test("FG03-5: assertNoAuthorityShapedFields accepts a clean projection at any depth", () => {
    assert.doesNotThrow(() => assertNoAuthorityShapedFields(
        { a: { b: { c: [1, 2, { d: "safe" }] } } }, "test"
    ));
});

test("FG03-6: assertNoAuthorityShapedFields rejects every AUTHORITY_SHAPED_KEYS entry at the top level", () => {
    for (const key of AUTHORITY_SHAPED_KEYS) {
        assert.throws(() => assertNoAuthorityShapedFields({ [key]: "x" }, "test"), new RegExp(key));
    }
});

test("FG03-7: assertNoAuthorityShapedFields rejects an authority-shaped key nested arbitrarily deep -- the original two-level-shallow check this was extracted from would have missed this", () => {
    const deep = { a: { b: { c: { d: { authProof: "forged" } } } } };
    assert.throws(() => assertNoAuthorityShapedFields(deep, "test"), /authProof/);
});

test("FG03-8: assertNoAuthorityShapedFields rejects an authority-shaped key inside an array element", () => {
    assert.throws(() => assertNoAuthorityShapedFields({ list: [{ grant: "x" }] }, "test"), /grant/);
});

test("FG03-9: assertNoAuthorityShapedFields is cycle-safe (WeakSet), never infinite-loops on a self-referencing object", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => assertNoAuthorityShapedFields(cyclic, "test"));
});

test("FG03-10: assertNoAuthorityShapedFields fails closed on a pathologically deep chain instead of stack-overflowing or hanging", () => {
    let deep = { authProof: "buried" };
    for (let i = 0; i < 10_000; i++) deep = { next: deep };
    assert.throws(() => assertNoAuthorityShapedFields(deep, "test"), /terlalu dalam|melebihi batas/);
});

test("FG03-11: validateGovernedCognitiveProjection accepts a well-formed frozen projection", () => {
    const projection = Object.freeze({
        schemaVersion: "governedCognitiveProjection.v1",
        decisionInfluence: "ADVISORY_ONLY",
        selfModel: Object.freeze({ capabilityCount: 0 })
    });
    assert.strictEqual(validateGovernedCognitiveProjection(projection), true);
});

test("FG03-12: validateGovernedCognitiveProjection rejects wrong schemaVersion, wrong decisionInfluence, an unfrozen object, and an authority-shaped field", () => {
    assert.throws(() => validateGovernedCognitiveProjection({ schemaVersion: "x", decisionInfluence: "ADVISORY_ONLY" }), /schemaVersion/);
    assert.throws(() => validateGovernedCognitiveProjection(Object.freeze({ schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "AUTHORITATIVE" })), /decisionInfluence/);
    assert.throws(() => validateGovernedCognitiveProjection({ schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "ADVISORY_ONLY" }), /dibekukan/);
    assert.throws(() => validateGovernedCognitiveProjection(Object.freeze({
        schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "ADVISORY_ONLY", authProof: "forged"
    })), /authProof/);
});

test("FG03-13: validateGovernedCognitiveProjection rejects null/non-object input as a domain error, not a raw TypeError", () => {
    assert.throws(() => validateGovernedCognitiveProjection(null), /wajib objek/);
    assert.throws(() => validateGovernedCognitiveProjection(undefined), /wajib objek/);
    assert.throws(() => validateGovernedCognitiveProjection("x"), /wajib objek/);
});

test("FG03-14: recordModeTransition emits a well-shaped, resolved-mode audit event", () => {
    const events = [];
    const ledger = { append: (e) => events.push(e) };
    const returned = recordModeTransition({ auditLedger: ledger, from: "off", to: "governed", at: 1234 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "cognition.governed.mode.transition");
    assert.equal(events[0].metadata.from, "off");
    assert.equal(events[0].metadata.to, "governed");
    assert.equal(events[0].metadata.at, 1234);
    assert.deepEqual(returned, events[0]);
});

test("FG03-15: recordModeTransition normalizes an unrecognized from/to through resolveMode (never audits a fabricated mode string)", () => {
    const events = [];
    const ledger = { append: (e) => events.push(e) };
    recordModeTransition({ auditLedger: ledger, from: "hostile", to: undefined });
    assert.equal(events[0].metadata.from, "off");
    assert.equal(events[0].metadata.to, "off");
});

test("FG03-16: recordModeTransition never throws when auditLedger is missing, non-callable, throwing, or a revoked Proxy -- audit failure never blocks cognition", () => {
    assert.doesNotThrow(() => recordModeTransition({ from: "off", to: "shadow" }));
    assert.doesNotThrow(() => recordModeTransition({ auditLedger: {}, from: "off", to: "shadow" }));
    assert.doesNotThrow(() => recordModeTransition({
        auditLedger: { append: () => { throw new Error("ledger down"); } }, from: "off", to: "shadow"
    }));
    const { proxy, revoke } = Proxy.revocable({ append: () => {} }, {});
    revoke();
    assert.doesNotThrow(() => recordModeTransition({ auditLedger: proxy, from: "off", to: "shadow" }));
});

test("FG03-17 (FG03_AUTHORITY_LEAKAGE=0): governed/** imports nothing from authority/ or action/bootstrap -- zero path to Authority, zero path to the dispatcher", () => {
    const dir = path.join(__dirname, "../../../src/cognition/governed");
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".js")) continue;
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        assert.doesNotMatch(content, /require\(["'].*\/(authority|action)\//,
            `${file} tidak boleh mengimpor authority/action`);
    }
});

test("FG03-18 (FG03_SECOND_DISPATCHER=0): governed's public API exposes only pure guard/validation/audit functions and frozen constants -- no dispatch, execute, run, invoke, or call surface", () => {
    const governed = require("../../../src/cognition/governed");
    const dispatchShaped = /^(dispatch|execute|invoke|run|call|route|act)/i;
    for (const [key, value] of Object.entries(governed)) {
        if (typeof value === "function") {
            assert.doesNotMatch(key, dispatchShaped, `${key} looks dispatch-shaped, governed must never expose one`);
        }
    }
});

test("FG03-19: MODES is the same frozen array instance longhorizon/bounds.js re-exports (single source of truth, no drift)", () => {
    const { MODES: longhorizonModes } = require("../../../src/cognition/longhorizon/bounds");
    assert.strictEqual(longhorizonModes, MODES);
});

test("FG03-20: every export is frozen or a pure function -- governed holds no mutable state of its own to persist, restart, or leak", () => {
    assert.ok(Object.isFrozen(MODES));
    assert.ok(Object.isFrozen(AUTHORITY_SHAPED_KEYS));
});

test("FG03-21: deep validation rejects proxy-hidden authority fields and contains async audit rejection", async () => {
    const hidden = new Proxy(Object.freeze({ authProof: "forged" }), { ownKeys: () => [] });
    const projection = Object.freeze({ schemaVersion: "governedCognitiveProjection.v1", decisionInfluence: "ADVISORY_ONLY", nested: hidden });
    assert.throws(() => validateGovernedCognitiveProjection(projection), /dibekukan|authProof/);
    let unhandled = false;
    const listener = () => { unhandled = true; };
    process.once("unhandledRejection", listener);
    recordModeTransition({ auditLedger: { append: () => Promise.reject(new Error("down")) }, from: "off", to: "governed" });
    await new Promise(resolve => setImmediate(resolve));
    process.removeListener("unhandledRejection", listener);
    assert.equal(unhandled, false);
});

test("FG03-22: validation never trusts inherited or accessor-backed projection fields", () => {
    const inherited = Object.freeze(Object.assign(Object.create({ authProof: "forged" }), {
        schemaVersion: "governedCognitiveProjection.v1",
        decisionInfluence: "ADVISORY_ONLY"
    }));
    assert.throws(() => validateGovernedCognitiveProjection(inherited), /objek data biasa|authProof/);

    let getterCalls = 0;
    const accessor = Object.freeze(Object.defineProperties({}, {
        schemaVersion: { value: "governedCognitiveProjection.v1", enumerable: true },
        decisionInfluence: { value: "ADVISORY_ONLY", enumerable: true },
        nested: { get() { getterCalls += 1; return { authProof: "forged" }; }, enumerable: true }
    }));
    assert.throws(() => validateGovernedCognitiveProjection(accessor), /data property/);
    assert.equal(getterCalls, 0);
});

test("FG03-23: mode transition timestamps are detached scalar data", () => {
    const at = { counter: 1 };
    const event = recordModeTransition({ from: "off", to: "shadow", at });
    assert.equal(event.metadata.at, null);
    assert.equal(Object.isFrozen(event.metadata), true);
});

test("FG03-24: governed foundation is exposed through the canonical cognition entry point", () => {
    const cognition = require("../../../src/cognition");
    assert.equal(cognition.governed.validateGovernedCognitiveProjection, validateGovernedCognitiveProjection);
    assert.equal(cognition.governed.REASONS.INVALID_PROJECTION, "INVALID_PROJECTION");
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 0b8abb7 — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("FG03-25: an ACTIVE Proxy is refused before any trap runs, so an ownKeys trap can no longer hide an authority-shaped field", () => {
    // The pre-repair walk used Reflect.ownKeys directly: the trap below ran
    // AND returned [], hiding authProof from the scan, so validation passed.
    let traps = 0;
    const hidden = new Proxy(Object.freeze({ authProof: "forged" }), {
        ownKeys() { traps += 1; return []; },
        getOwnPropertyDescriptor() { traps += 1; return { value: 1, enumerable: true, configurable: true }; }
    });
    const projection = Object.freeze({
        schemaVersion: "governedCognitiveProjection.v1",
        decisionInfluence: "ADVISORY_ONLY",
        nested: hidden
    });
    assert.throws(() => validateGovernedCognitiveProjection(projection), /Proxy|dibekukan|authProof/);
    assert.equal(traps, 0, "no Proxy trap may execute during validation");
});

test("FG03-26: authority-shaped containment covers the whole vocabulary family, not just historical field names", () => {
    for (const key of [
        "authority", "authorized", "authorization", "permission", "permissions",
        "privilege", "approved", "approval", "decision", "decisionMaker",
        "lease", "bearerToken", "leaseToken", "authToken", "credential", "apiKey"
    ]) {
        assert.throws(
            () => assertNoAuthorityShapedFields({ nested: { [key]: "x" } }, "Probe"),
            /tidak boleh membawa field/,
            `'${key}' must be contained`);
    }
    // A legitimate advisory projection still passes.
    assert.doesNotThrow(() => assertNoAuthorityShapedFields({
        selfModel: { capabilityCount: 1, healthState: "OK" },
        attentionFocus: { targetId: "t1", workKind: "REASON" },
        decisionInfluence: "ADVISORY_ONLY"
    }, "Probe"));
});

test("FG03-27: recordModeTransitionChecked REPORTS an unconfirmed append instead of silently going unaudited", () => {
    // no ledger: a declared configuration, not a positive audit claim
    const none = recordModeTransitionChecked({ from: "off", to: "shadow" });
    assert.equal(none.auditSupplied, false);
    assert.equal(none.audited, false);
    assert.equal(none.failedOpen, false);

    // confirmed durable append -- requires PROOF OF PERSISTENCE (read-back)
    const confirmed = recordModeTransitionChecked({
        auditLedger: recordingLedgerFor(), from: "off", to: "governed"
    });
    assert.equal(confirmed.auditSupplied, true);
    assert.equal(confirmed.audited, true);
    assert.equal(confirmed.failedOpen, false);

    // A shape-only return proves nothing and must NOT count as confirmed.
    const shapeOnly = recordModeTransitionChecked({
        auditLedger: { append: () => ({ ok: true }) }, from: "off", to: "governed"
    });
    assert.equal(shapeOnly.failedOpen, true, "a shape-only return is not proof of a durable record");

    // supplied but REJECTED -- the fail-open case that must be visible
    const rejected = recordModeTransitionChecked({
        auditLedger: { append: () => ({ ok: false, error: { code: "E_INVALID_EVENT" } }) },
        from: "off", to: "governed"
    });
    assert.equal(rejected.failedOpen, true, "a rejected append must be reported as fail-open");

    // supplied but THROWING
    const throwing = recordModeTransitionChecked({
        auditLedger: { append: () => { throw new Error("ledger down"); } },
        from: "off", to: "governed"
    });
    assert.equal(throwing.failedOpen, true, "a throwing append must be reported as fail-open");

    // the unchecked wrapper keeps its exact prior contract (FG03-14 relies on it)
    assert.deepEqual(
        recordModeTransition({ auditLedger: { append: () => {} }, from: "off", to: "governed" }),
        recordModeTransitionChecked({ auditLedger: { append: () => {} }, from: "off", to: "governed" }).event);
});

test("FG03-28: the governed facade is frozen -- a caller cannot swap a guard for a permissive one", () => {
    const governed = require("../../../src/cognition/governed");
    assert.equal(Object.isFrozen(governed), true);
    assert.equal(Object.isFrozen(require("../../../src/cognition").governed), true);
    // This file is not strict-mode, so a plain assignment to a frozen property
    // silently no-ops rather than throwing -- assert the OUTCOME (the guard is
    // unchanged), which is what actually matters, via the strict Reflect path.
    assert.equal(Reflect.set(governed, "resolveMode", () => "governed"), false);
    assert.equal(governed.resolveMode("hostile"), "off");
    assert.equal(Reflect.set(governed, "AUTHORITY_SHAPED_KEYS", []), false);
    assert.equal(governed.AUTHORITY_SHAPED_KEYS.includes("authProof"), true);
});

test("FG03-29: governed mode cannot start when a SUPPLIED ledger fails to record the transition (fail-closed construction)", async () => {
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    const registry = Object.freeze({
        get: () => ({ kind: "tool" }),
        has: () => true,
        list: () => []
    });

    const lh = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: { append: () => { throw new Error("ledger down"); } }
    });
    assert.equal(lh.mode, "off", "an unrecordable transition must not silently yield governed mode");
    assert.equal(lh.auditUnavailable, true);
    assert.equal(lh.lanes, undefined, "the degraded path constructs no lanes, matching mode off's zero footprint");
    assert.equal(await lh.cycle(), null);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 8f78a21 — repaired classes                        */
/* ---------------------------------------------------------------------- */

function fakeRegistry() {
    const map = new Map([["cap.x", { kind: "tool" }]]);
    return {
        get: (id) => (map.has(id) ? { id, ...map.get(id) } : null),
        has: (id) => map.has(id),
        getAvailability: () => { throw new Error("unused"); }
    };
}

test("FG03-30: 'supplied' means the caller passed a ledger, so an unusable one can never report a confirmed transition", () => {
    const governedOutcome = (auditLedger) =>
        recordModeTransitionChecked({ auditLedger, from: "off", to: "governed" });

    // absent ledger: a declared configuration, not a positive audit claim
    assert.equal(governedOutcome(undefined).auditSupplied, false);
    assert.equal(governedOutcome(undefined).failedOpen, false);
    assert.equal(governedOutcome(null).auditSupplied, false);

    // SUPPLIED but unusable: every one of these must be reported as fail-open.
    assert.equal(governedOutcome({}).failedOpen, true, "no append at all");
    assert.equal(governedOutcome({ append: 42 }).failedOpen, true, "non-callable append");
    assert.equal(governedOutcome({ append: () => {} }).failedOpen, true, "a no-op append confirms nothing");
    assert.equal(governedOutcome({ append: () => false }).failedOpen, true, "explicit refusal");
    assert.equal(governedOutcome({ append: () => ({ ok: false }) }).failedOpen, true, "appendSafe rejection");
    assert.equal(governedOutcome({ append: () => { throw new Error("down"); } }).failedOpen, true, "throwing append");

    const { proxy, revoke } = Proxy.revocable({ append: () => ({ ok: true }) }, {});
    revoke();
    assert.equal(governedOutcome(proxy).failedOpen, true, "revoked Proxy ledger");

    // A shape-only return is forgeable and proves nothing, so it must NOT be
    // accepted -- confirmation now requires the record to be readable back.
    assert.equal(governedOutcome({ append: () => ({ ok: true }) }).failedOpen, true,
        "shape-only ok:true is not proof of persistence");
    assert.equal(governedOutcome({ append: () => ({ eventId: "e1" }) }).failedOpen, true,
        "a forged eventId is not proof of persistence");

    // Genuine confirmations still pass, against a ledger that really records.
    assert.equal(governedOutcome(recordingLedgerFor()).failedOpen, false);
});

test("FG03-31: authority vocabulary containment is case- and separator-insensitive, without rejecting legitimate advisory fields", () => {
    for (const key of [
        "permitted", "permit", "entitlement", "accessToken", "refreshToken",
        "delegation", "delegated", "mandate", "AUTHORIZATION", "auth_token",
        "Auth-Token", "Permissions", "LEASE"
    ]) {
        assert.throws(
            () => assertNoAuthorityShapedFields({ nested: { [key]: "x" } }, "Probe"),
            /tidak boleh membawa field/,
            `'${key}' must be contained`);
    }
    // Legitimate advisory-shaped projection fields must NOT be collateral damage.
    assert.doesNotThrow(() => assertNoAuthorityShapedFields({
        decisionInfluence: "ADVISORY_ONLY",
        selfModel: { capabilityCount: 0, healthState: "OK" },
        attentionFocus: null
    }, "Probe"));
});

test("FG03-32: the canonical cognition barrel is frozen, so the governed facade cannot be swapped one level up", () => {
    const cognition = require("../../../src/cognition");
    assert.equal(Object.isFrozen(cognition), true);
    assert.equal(Reflect.set(cognition, "governed", { validateGovernedCognitiveProjection: () => true }), false);
    assert.equal(cognition.governed, require("../../../src/cognition/governed"));
    assert.equal(cognition.governed.resolveMode("hostile"), "off");
});

test("FG03-33: the canonical audit-ledger binding actually resolves, so shadow and governed construct with a real ledger", async () => {
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    // The previous revision required a non-existent path, so the binding
    // silently became null and nothing was ever recorded canonically.
    const auditLedger = require("../../../src/runtime/auditLedger");
    assert.equal(typeof auditLedger.createAuditLedger, "function");

    for (const mode of ["shadow", "governed"]) {
        const lh = await createLongHorizonCycle({ mode, capabilityRegistry: fakeRegistry() });
        assert.equal(lh.mode, mode, `${mode} must construct normally against the canonical ledger`);
        assert.equal(lh.auditUnavailable, undefined);
        assert.ok(lh.lanes, `${mode} must have constructed its lanes`);
    }
    // off stays zero-footprint.
    const off = await createLongHorizonCycle({ mode: "off", capabilityRegistry: fakeRegistry() });
    assert.equal(off.lanes, undefined);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 9e7b8df — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("FG03-34: only a positive confirmation SHAPE counts as audited -- arbitrary truthy returns stay fail-open", () => {
    const outcome = (append) => recordModeTransitionChecked(
        { auditLedger: { append }, from: "off", to: "governed" });

    // Every one of these is truthy but is NOT the canonical stored record, so
    // none may be reported as a recorded transition (audit of 9e7b8df found
    // that any truthy return was previously accepted as success).
    assert.equal(outcome(() => 1).failedOpen, true, "number 1");
    assert.equal(outcome(() => "ok").failedOpen, true, "string");
    assert.equal(outcome(() => Symbol("x")).failedOpen, true, "symbol");
    assert.equal(outcome(() => () => {}).failedOpen, true, "function");
    assert.equal(outcome(() => []).failedOpen, true, "array");
    assert.equal(outcome(() => ({ nope: 1 })).failedOpen, true, "unrelated object");
    assert.equal(outcome(() => ({ eventId: "" })).failedOpen, true, "empty eventId is not a record");
    // A shape-only return is forgeable: it must be UNCONFIRMED unless the
    // ledger can prove the record exists by reading it back.
    assert.equal(outcome(() => ({ ok: true })).failedOpen, true,
        "shape-only ok:true cannot prove a durable append");
    assert.equal(outcome(() => ({ eventId: "canonical-record-1" })).failedOpen, true,
        "a forged eventId cannot prove a durable append");
    assert.equal(outcome(() => ({ ok: true, event: { eventId: "e1" } })).failedOpen, true,
        "nested shape without read-back cannot prove a durable append");
});

test("FG03-35: the additional authority vocabulary is contained while legitimate advisory vocabulary is not over-rejected", () => {
    for (const key of [
        "allowed", "denied", "deny", "forbidden", "unauthorized",
        "authentication", "authenticated", "authorizationCode",
        "idToken", "sessionToken", "consent", "scope", "scopes"
    ]) {
        assert.throws(
            () => assertNoAuthorityShapedFields({ nested: { [key]: "x" } }, "Probe"),
            /tidak boleh membawa field/,
            `'${key}' must be contained`);
    }
    // Bare `token`/`tokens` are ordinary advisory vocabulary (e.g. a planning
    // token budget) and must NOT be collateral damage of the denylist.
    assert.doesNotThrow(() => assertNoAuthorityShapedFields({
        plan: { token: 12, tokens: 34 }, decisionInfluence: "ADVISORY_ONLY"
    }, "Probe"));
});

test("FG03-36: a non-recording ledger degrades GOVERNED to off but never degrades SHADOW", async () => {
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    // Shadow is decisionInfluence:false ALWAYS by contract, so an unrecorded
    // shadow initialization cannot influence a decision; degrading it would
    // destroy capability for no safety gain (and would break the frozen W7-L7
    // per-cycle audit cap). Governed, which permits ADVISORY_ONLY influence,
    // must still refuse to start unaudited.
    const nonRecording = { append: () => 1 };

    const shadow = await createLongHorizonCycle({
        mode: "shadow", capabilityRegistry: fakeRegistry(), auditLedger: nonRecording
    });
    assert.equal(shadow.mode, "shadow", "shadow must not be degraded by a non-recording ledger");
    assert.ok(shadow.lanes, "shadow still constructs its lanes");

    const governed = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: fakeRegistry(), auditLedger: nonRecording
    });
    assert.equal(governed.mode, "off", "an unconfirmed transition must not yield governed mode");
    assert.equal(governed.auditUnavailable, true);
    assert.equal(governed.lanes, undefined);

    // A recording ledger keeps governed working.
    const recording = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: fakeRegistry(), auditLedger: recordingLedgerFor()
    });
    assert.equal(recording.mode, "governed");
    assert.ok(recording.lanes);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of d409f56 — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("FG03-37: a confirmation cannot be forged via inheritance, an array, an accessor, or a Proxy", () => {
    const outcome = (append) => recordModeTransitionChecked(
        { auditLedger: { append }, from: "off", to: "governed" });

    // `"ok" in result` walked the prototype chain and `result.ok` was a raw
    // [[Get]], so all four of these previously reported audited:true.
    const inheritedOk = Object.create({ ok: true });
    assert.equal(outcome(() => inheritedOk).failedOpen, true, "inherited ok:true");

    const arrayWithOk = [1, 2];
    arrayWithOk.ok = true;
    assert.equal(outcome(() => arrayWithOk).failedOpen, true, "array carrying a smuggled ok");

    const accessorOk = {};
    Object.defineProperty(accessorOk, "ok", { get() { return true; }, enumerable: true });
    assert.equal(outcome(() => accessorOk).failedOpen, true, "accessor-backed ok");

    const proxyOk = new Proxy({}, {
        get: (t, k) => (k === "ok" ? true : undefined),
        has: (t, k) => (k === "ok"),
        getOwnPropertyDescriptor: (t, k) => (k === "ok"
            ? { value: true, enumerable: true, configurable: true } : undefined)
    });
    assert.equal(outcome(() => proxyOk).failedOpen, true, "Proxy synthesizing ok:true");

    // Boxed strings, Dates, and class instances are NOT plain data objects, so
    // they cannot masquerade as a confirmation either (audit of 321c7b3).
    assert.equal(outcome(() => new String("ok")).failedOpen, true, "boxed string");
    assert.equal(outcome(() => new Date()).failedOpen, true, "Date");
    assert.equal(outcome(() => new Map()).failedOpen, true, "Map");

    // A shape-only return is forgeable and never counts as confirmed.
    assert.equal(outcome(() => ({ ok: true })).failedOpen, true,
        "shape-only ok:true cannot prove persistence");
});

test("FG03-38: every NON-NUMBER `token` form is contained, while a numeric token budget stays legitimate", () => {
    // Only a plain finite number is ordinary advisory vocabulary. Every other
    // representation can carry credential material, so all of these fail closed
    // (audit of 321c7b3 showed an array, an object, and `true` all passed).
    const rejected = [
        "Bearer root-secret",
        ["Bearer root-secret"],
        { value: "Bearer root-secret" },
        true,
        new String("Bearer root-secret"),
        null
    ];
    for (const value of rejected) {
        assert.throws(
            () => assertNoAuthorityShapedFields({ plan: { token: value } }, "Probe"),
            /hanya boleh berupa angka|tidak boleh/,
            `token=${String(value)} must be contained`);
    }

    // The same key as a NUMBER is ordinary advisory vocabulary.
    assert.doesNotThrow(() => assertNoAuthorityShapedFields({
        plan: { token: 12, tokens: 34 }, decisionInfluence: "ADVISORY_ONLY"
    }, "Probe"));

    // A non-finite number is not a legitimate budget either.
    assert.throws(
        () => assertNoAuthorityShapedFields({ plan: { token: Infinity } }, "Probe"),
        /hanya boleh berupa angka/);

    // The additional credential/auth families are contained by name.
    for (const key of [
        "auth", "oauthToken", "jwt", "accessKey", "sessionCredential",
        "bindingSecret", "clientSecret", "secretKey", "apiToken",
        "privateToken", "accessCredential", "authorizationBearer"
    ]) {
        assert.throws(
            () => assertNoAuthorityShapedFields({ nested: { [key]: "v" } }, "Probe"),
            /tidak boleh membawa field|kredensial/,
            `'${key}' must be contained`);
    }
});

test("FG03-39: the canonical owner-trust ledger really confirms a governed transition (not a second, sinkless ledger)", async () => {
    const { composeOwnerTrustForTest } = require("../../../src/authority/ownerTrustComposition");
    const os = require("node:os");
    const path = require("node:path");
    const fs = require("node:fs");

    // DURABLE composition: the owner-trust ledger then owns a real file sink,
    // so its append can actually prove persistence.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-ot-"));
    const stateFile = path.join(dir, "ownertrust.json");
    const comp = await composeOwnerTrustForTest({ stateFile });
    try {
        // The canonical owner exposes the single ledger this repo owns.
        assert.ok(comp.ledger, "owner-trust composition must expose its ledger");
        assert.equal(typeof comp.ledger.append, "function");

        const checked = recordModeTransitionChecked({
            auditLedger: comp.ledger, from: "off", to: "governed", at: 1
        });
        assert.equal(checked.auditSupplied, true);
        assert.equal(checked.audited, true, "the durable canonical ledger must confirm the transition");
        assert.equal(checked.failedOpen, false);
    } finally {
        try { comp.close(); } catch { /* ignore */ }
    }

    // A NON-durable (sinkless) owner-trust ledger is branded but CANNOT prove
    // durability, so it must fail closed rather than claim a durable record
    // that was never written (audit of bd45f18).
    const memoryComp = await composeOwnerTrustForTest({ stateFile: null });
    try {
        const memChecked = recordModeTransitionChecked({
            auditLedger: memoryComp.ledger, from: "off", to: "governed", at: 1
        });
        assert.equal(memChecked.audited, false,
            "a sinkless canonical ledger cannot prove a DURABLE append");
        assert.equal(memChecked.failedOpen, true);
    } finally {
        try { memoryComp.close(); } catch { /* ignore */ }
    }
});

/* ---------------------------------------------------------------------- */
/* Independent audit of c37be79 — repaired classes                        */
/* ---------------------------------------------------------------------- */

test("FG03-40: a ledger that SYNTHESIZES a read-back record cannot prove persistence", () => {
    // Returns an eventId AND fabricates a record carrying that id on read.
    const synthesizer = {
        append: () => ({ eventId: "forged" }),
        getByEventId: (id) => ({ eventId: id, eventType: "whatever", source: "elsewhere", metadata: {} })
    };
    const r = recordModeTransitionChecked({
        auditLedger: synthesizer, from: "off", to: "governed"
    });
    assert.equal(r.auditSupplied, true);
    assert.equal(r.audited, false, "an id-only read-back is forgeable and must not confirm");
    assert.equal(r.failedOpen, true);

    // A ledger that really stores the event still confirms.
    const rec = recordingLedger();
    const ok = recordModeTransitionChecked({ auditLedger: rec.ledger, from: "off", to: "governed" });
    assert.equal(ok.audited, true);
    assert.equal(ok.failedOpen, false);
    assert.equal(rec.ledger.size(), 1, "the transition really was recorded");
    assert.equal(rec.writes().length, 1, "a confirmed transition really reached the durable sink");
    rec.close();
});

test("FG03-41: the repository's own authority vocabulary is contained", () => {
    // FULL PARITY, not a hand-picked subset: every token in the repo's canonical
    // authority vocabulary must also be contained here (audit of cd3dedf found
    // `authorisation`, `ownerapproved`, and `superuser` were missing).
    const { INTENT_AUTHORITY_TOKENS } = require("../../../src/action/intent");
    const missing = [];
    for (const token of INTENT_AUTHORITY_TOKENS) {
        try {
            assertNoAuthorityShapedFields({ nested: { [token]: "v" } }, "Probe");
            missing.push(token);
        } catch { /* contained */ }
    }
    assert.deepEqual(missing, [],
        `every canonical authority token must be contained, missing: ${missing.join(",")}`);
    assert.ok(INTENT_AUTHORITY_TOKENS.size > 0, "the canonical vocabulary must be non-empty");
});

test("FG03-43: a caller-supplied look-alike ledger is refused by the canonical brand, however convincing", () => {
    // A ledger that stores nothing but ECHOES what it was handed: it satisfies
    // every content check yet proves no persistence (audit of cd3dedf).
    let echoed = null;
    const transientEcho = {
        append(evt) { echoed = { ...evt, eventId: "echo-1" }; return echoed; },
        getByEventId(id) { return echoed && echoed.eventId === id ? echoed : null; }
    };
    const forged = recordModeTransitionChecked({
        auditLedger: transientEcho, from: "off", to: "governed"
    });
    assert.equal(forged.audited, false, "an unbranded look-alike cannot prove persistence");
    assert.equal(forged.failedOpen, true);

    // Even a SPREAD CLONE of a genuine ledger loses the brand, so a caller
    // cannot launder authority through a copy of the real object.
    const { createAuditLedger } = require("../../../src/runtime/auditLedger");
    const clone = { ...createAuditLedger({}) };
    const cloned = recordModeTransitionChecked({
        auditLedger: clone, from: "off", to: "governed"
    });
    assert.equal(cloned.audited, false, "a spread clone of a real ledger must not confirm");
    assert.equal(cloned.failedOpen, true);

    // The genuine brand still confirms -- WITH a persistence sink, because a
    // confirmation asserts DURABILITY (audit of bd45f18).
    const genuine = recordModeTransitionChecked({
        auditLedger: recordingLedgerFor(), from: "off", to: "governed"
    });
    assert.equal(genuine.audited, true);
    assert.equal(genuine.failedOpen, false);
});

test("FG03-44: the repository's own authority vocabulary is contained (property name form)", () => {
    // Kept as a plain-name check alongside the parity assertion above, so a
    // regression in normalization is distinguishable from a missing token.
    for (const key of [
        "authorize", "approve", "trusted", "trust", "privileged",
        "admin", "root", "role", "roles", "canExecute", "allowDecision",
        "trustLevel", "trustedBy", "authorisation", "ownerapproved", "superuser"
    ]) {
        assert.throws(
            () => assertNoAuthorityShapedFields({ nested: { [key]: "v" } }, "Probe"),
            /tidak boleh membawa field/,
            `'${key}' must be contained`);
    }
});

test("FG03-42: production refuses governed with NO ledger, while the frozen W7-L7 no-ledger construction still works", async () => {
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    const registry = { get: () => ({ kind: "tool" }), has: () => true, getAvailability: () => { throw new Error("unused"); } };

    // PRODUCTION: resolving a null ledger must not be indistinguishable from success.
    const strict = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry, auditLedger: null, requireAudit: true
    });
    assert.equal(strict.mode, "off", "governed must not start with no ledger when audit is required");
    assert.equal(strict.auditUnavailable, true);
    assert.equal(strict.lanes, undefined, "no lanes are constructed on the degraded path");
    assert.equal(await strict.cycle(), null);

    // The frozen Wave7 L7 convergence contract still constructs governed with
    // no ledger under the default (declared configuration), unchanged.
    const permissive = await createLongHorizonCycle({ mode: "governed", capabilityRegistry: registry });
    assert.equal(permissive.mode, "governed");
    assert.ok(permissive.lanes);

    // With a real ledger the production path works.
    const ok = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry, auditLedger: recordingLedgerFor(), requireAudit: true
    });
    assert.equal(ok.mode, "governed");
    assert.ok(ok.lanes);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of bd45f18 — durable-append requirement               */
/* ---------------------------------------------------------------------- */

test("FG03-45: confirmation asserts DURABILITY -- a branded ledger with no sink cannot confirm", () => {
    const { createAuditLedger } = require("../../../src/runtime/auditLedger");
    const registry = { get: () => ({ kind: "tool" }), has: () => true, getAvailability: () => { throw new Error("unused"); } };

    // The brand proves FACTORY ORIGIN, not persistence. A branded SINKLESS
    // ledger previously reported audited:true, and requireAudit then started
    // governed mode against a ledger that had written nothing (audit of
    // bd45f18). A durable append must be requested, so a sinkless ledger
    // raises NO_SINK and the confirmation fails closed.
    const sinkless = createAuditLedger({});
    const absent = recordModeTransitionChecked({
        auditLedger: sinkless, from: "off", to: "governed"
    });
    assert.equal(absent.audited, false, "a sinkless ledger cannot prove a durable append");
    assert.equal(absent.failedOpen, true);

    // A branded ledger with a sink confirms AND really reaches that sink.
    const rec = recordingLedger();
    const confirmed = recordModeTransitionChecked({
        auditLedger: rec.ledger, from: "off", to: "governed"
    });
    assert.equal(confirmed.audited, true);
    assert.equal(confirmed.failedOpen, false);
    assert.equal(rec.writes().length, 1,
        "a confirmed transition must have produced an actual durable sink write");
    assert.ok(rec.writes()[0].length > 0, "the sink received the stored record");
    rec.close();

    // A sink whose append THROWS is a persistence failure, not a confirmation.
    const failing = createAuditLedger({ sink: { append() { throw new Error("disk full"); } } });
    const failed = recordModeTransitionChecked({
        auditLedger: failing, from: "off", to: "governed"
    });
    assert.equal(failed.audited, false, "a rejecting sink must not confirm");
    assert.equal(failed.failedOpen, true);
});

test("FG03-46: requireAudit refuses to start governed against a sinkless ledger, and starts against a durable one", async () => {
    const { createAuditLedger } = require("../../../src/runtime/auditLedger");
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    const registry = { get: () => ({ kind: "tool" }), has: () => true, getAvailability: () => { throw new Error("unused"); } };

    // Branded but sinkless -> no durability -> governed must degrade to off.
    const sinklessRun = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: createAuditLedger({}), requireAudit: true
    });
    assert.equal(sinklessRun.mode, "off", "a sinkless ledger must not satisfy requireAudit");
    assert.equal(sinklessRun.auditUnavailable, true);
    assert.equal(sinklessRun.lanes, undefined);

    // Branded WITH a sink -> real durability -> governed starts.
    const durableRun = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: recordingLedgerFor(), requireAudit: true
    });
    assert.equal(durableRun.mode, "governed");
    assert.ok(durableRun.lanes);
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 7677a0f — durability acknowledgement + config      */
/* ---------------------------------------------------------------------- */

test("FG03-47: a branded ledger whose sink does not acknowledge a durable write cannot confirm", () => {
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");

    // THE AUDITOR'S EXACT REPRO: a branded ledger backed by a no-op sink. The
    // port contract says append must RETURN TRUE to acknowledge success, and
    // the ledger previously ignored the return value, so `{append(){}}` claimed
    // durability it never performed (audit of 7677a0f).
    const noop = createAuditLedger({ sink: { append() {} } });
    const absent = recordModeTransitionChecked({
        auditLedger: noop, from: "off", to: "governed"
    });
    assert.equal(absent.audited, false, "a no-op sink must not confirm durability");
    assert.equal(absent.failedOpen, true);

    // Explicitly returning `false` is likewise not an acknowledgement.
    const falsy = createAuditLedger({ sink: { append() { return false; } } });
    assert.equal(recordModeTransitionChecked({
        auditLedger: falsy, from: "off", to: "governed"
    }).audited, false, "a false-returning sink must not confirm");

    // A REAL durable sink (file + fsync) confirms and really writes.
    const rec = recordingLedger();
    const confirmed = recordModeTransitionChecked({
        auditLedger: rec.ledger, from: "off", to: "governed"
    });
    assert.equal(confirmed.audited, true);
    assert.equal(confirmed.failedOpen, false);
    assert.equal(rec.writes().length, 1, "the durable file sink received the record");
    rec.close();
});

test("FG03-48: requireAudit fails closed for any truthy value, and a no-op sink cannot satisfy it", async () => {
    const { createAuditLedger } = require("../../../src/runtime/auditLedger");
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    const registry = { get: () => ({ kind: "tool" }), has: () => true, getAvailability: () => { throw new Error("unused"); } };

    // A malformed but truthy `requireAudit` used to DISABLE the guard, which is
    // the opposite of what the caller intended (audit of 7677a0f).
    for (const value of [1, "true", {}, []]) {
        const run = await createLongHorizonCycle({
            mode: "governed", capabilityRegistry: registry, auditLedger: null, requireAudit: value
        });
        assert.equal(run.mode, "off",
            `requireAudit=${JSON.stringify(value)} must still demand an audit ledger`);
        assert.equal(run.auditUnavailable, true);
    }

    // A branded ledger with a NO-OP sink cannot satisfy requireAudit either.
    const noopRun = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: createAuditLedger({ sink: { append() {} } }), requireAudit: true
    });
    assert.equal(noopRun.mode, "off", "a no-op sink must not satisfy requireAudit");
    assert.equal(noopRun.lanes, undefined);

    // A genuinely durable ledger satisfies it.
    const rec = recordingLedger();
    const okRun = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: rec.ledger, requireAudit: true
    });
    assert.equal(okRun.mode, "governed");
    assert.ok(okRun.lanes);
    rec.close();
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 8fbfcdd -- durable brand must mean fsync           */
/* ---------------------------------------------------------------------- */

test("FG03-49: a file sink created with fsync disabled is NOT branded durable and cannot confirm", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");
    const { isDurableAuditSink } = require("../../../src/runtime/auditLedger/fileSink");

    // The durable brand is the basis of the "durably recorded" claim, and that
    // claim names fsync explicitly. A sink built with {fsync:false} writes
    // without flushing, so branding it durable let a deployment obtain governed
    // confirmation without the required durability (audit of 8fbfcdd).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-nofsync-"));
    const noFsyncSink = createFileAuditSink(path.join(dir, "audit.jsonl"), { fsync: false });
    assert.equal(noFsyncSink.describeDurable().fsync, false, "the sink really is non-fsyncing");
    assert.equal(isDurableAuditSink(noFsyncSink), false,
        "a non-fsyncing sink must not carry the durable brand");

    const noFsyncLedger = createAuditLedger({
        sink: noFsyncSink, resume: noFsyncSink.describeDurable()
    });
    assert.equal(noFsyncLedger.hasDurableSink, false, "and its ledger cannot claim a durable sink");
    const checked = recordModeTransitionChecked({
        auditLedger: noFsyncLedger, from: "off", to: "governed"
    });
    assert.equal(checked.audited, false, "a non-fsyncing sink must not confirm a durable append");
    assert.equal(checked.failedOpen, true);
    try { noFsyncSink.close(); } catch { /* ignore */ }

    // The DEFAULT sink (fsync on) is durable and still confirms end to end.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-fsync-"));
    const file = path.join(dir2, "audit.jsonl");
    const durableSink = createFileAuditSink(file);
    assert.equal(durableSink.describeDurable().fsync, true);
    assert.equal(isDurableAuditSink(durableSink), true, "the default sink is durable");
    const durableLedger = createAuditLedger({ sink: durableSink, resume: durableSink.describeDurable() });
    assert.equal(durableLedger.hasDurableSink, true);
    assert.equal(recordModeTransitionChecked({
        auditLedger: durableLedger, from: "off", to: "governed"
    }).audited, true);
    try { durableSink.close(); } catch { /* ignore */ }
});

test("FG03-50: requireAudit refuses a non-fsyncing ledger and accepts a durable one", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");
    const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
    const registry = { get: () => ({ kind: "tool" }), has: () => true, getAvailability: () => { throw new Error("unused"); } };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-nofsync2-"));
    const noFsyncSink = createFileAuditSink(path.join(dir, "audit.jsonl"), { fsync: false });
    const noFsyncLedger = createAuditLedger({ sink: noFsyncSink, resume: noFsyncSink.describeDurable() });
    const refused = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: noFsyncLedger, requireAudit: true
    });
    assert.equal(refused.mode, "off", "a non-fsyncing ledger must not satisfy requireAudit");
    assert.equal(refused.lanes, undefined);
    try { noFsyncSink.close(); } catch { /* ignore */ }

    const rec = recordingLedger();
    const accepted = await createLongHorizonCycle({
        mode: "governed", capabilityRegistry: registry,
        auditLedger: rec.ledger, requireAudit: true
    });
    assert.equal(accepted.mode, "governed");
    assert.ok(accepted.lanes);
    rec.close();
});

/* ---------------------------------------------------------------------- */
/* Independent audit of c894e05 -- caller code must not suppress the flush */
/* ---------------------------------------------------------------------- */

test("FG03-51: an options getter/Proxy cannot suppress the real fsync while the sink stays durably branded", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");
    const { isDurableAuditSink } = require("../../../src/runtime/auditLedger/fileSink");

    // The attack: read options.fsync through an accessor, and inside that getter
    // replace `fs.fsyncSync` so the sink is branded durable while never actually
    // flushing -- which let `requireAudit: true` enter governed mode without the
    // durability it asserts (audit of c894e05).
    const realFsync = fs.fsyncSync;
    let getterReads = 0;
    const hostileOpts = {};
    Object.defineProperty(hostileOpts, "fsync", {
        enumerable: true, configurable: true,
        get() { getterReads += 1; fs.fsyncSync = () => {}; return true; }
    });
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-atk-"));
        const sink = createFileAuditSink(path.join(dir, "audit.jsonl"), hostileOpts);
        assert.equal(getterReads, 0, "the options accessor must never run");
        assert.equal(fs.fsyncSync, realFsync, "the getter therefore never got a chance to replace the primitive");
        assert.equal(isDurableAuditSink(sink), true, "a genuinely fsyncing sink is still branded");
        try { sink.close(); } catch { /* ignore */ }
    } finally {
        fs.fsyncSync = realFsync;
    }

    // A Proxy options object must not run either.
    let proxyReads = 0;
    const proxyOpts = new Proxy({}, {
        get(t, k) { if (k === "fsync") { proxyReads += 1; } return Reflect.get(t, k); }
    });
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-atk2-"));
    const sink2 = createFileAuditSink(path.join(dir2, "audit.jsonl"), proxyOpts);
    assert.equal(proxyReads, 0, "a Proxy options object must not be read through");
    assert.equal(isDurableAuditSink(sink2), true, "omitting fsync keeps the safe default (fsync on)");
    try { sink2.close(); } catch { /* ignore */ }

    // The brand must always agree with the sink's own reported fsync state.
    for (const [label, opts] of [["default", undefined], ["{fsync:true}", { fsync: true }],
        ["{fsync:false}", { fsync: false }], ["{fsync:0}", { fsync: 0 }], ["{fsync:null}", { fsync: null }]]) {
        const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-inv-"));
        const file = path.join(dir3, "audit.jsonl");
        const s = opts === undefined ? createFileAuditSink(file) : createFileAuditSink(file, opts);
        const branded = isDurableAuditSink(s);
        assert.equal(branded, s.describeDurable().fsync,
            `the durable brand must match the real fsync state for ${label}`);
        try { s.close(); } catch { /* ignore */ }
    }
});

test("FG03-52: the sink flushes through primitives captured at load, so later mutation cannot defeat a confirmed append", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");

    // The module captures its file primitives when it loads, so replacing
    // `fs.fsyncSync` AFTER that point cannot suppress the flush of an append
    // that was already confirmed durable.
    const realFsync = fs.fsyncSync;
    let wrapperCalls = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-cap-"));
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = createAuditLedger({ sink, resume: sink.describeDurable() });
    try {
        fs.fsyncSync = function (...args) { wrapperCalls += 1; return realFsync.apply(this, args); };
        const record = ledger.append({ eventType: "a.b", source: "s" }, { durable: true });
        assert.ok(record && record.eventId, "the durable append was confirmed");
        assert.equal(wrapperCalls, 0, "the sink used its captured primitive, not the replacement");
        assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1,
            "the record really reached disk");
    } finally {
        fs.fsyncSync = realFsync;
        try { sink.close(); } catch { /* ignore */ }
    }
});

/* ---------------------------------------------------------------------- */
/* Independent audit of 2712bf3 -- `call` lookup and module-cache swap     */
/* ---------------------------------------------------------------------- */

test("FG03-53: attaching a no-op `call` to the shared primitive cannot suppress a confirmed flush", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");
    const { isDurableAuditSink } = require("../../../src/runtime/auditLedger/fileSink");

    // The previous fix called the captured primitive as `FN.call(...)`. `call` is
    // a PROPERTY of that function object, and the object is still reachable
    // through `fs.fsyncSync` -- so an own no-op `call` suppressed the real flush
    // while the sink stayed branded durable and `requireAudit: true` entered
    // governed mode with zero flushes (audit of 2712bf3). The write path now
    // uses a frozen `Reflect.apply`, which performs no property lookup.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-call-"));
    const file = path.join(dir, "audit.jsonl");
    const sink = createFileAuditSink(file);
    const ledger = createAuditLedger({ sink, resume: sink.describeDurable() });

    let noopRan = 0;
    fs.fsyncSync.call = () => { noopRan += 1; };
    let checked;
    try {
        checked = recordModeTransitionChecked({
            auditLedger: ledger, from: "off", to: "governed"
        });
    } finally {
        delete fs.fsyncSync.call;
    }
    try {
        assert.equal(noopRan, 0, "the replacement `call` must never run");
        assert.equal(checked.audited, true, "the durable append really was confirmed");
        assert.equal(isDurableAuditSink(sink), true);
        assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1,
            "the record really reached disk");
    } finally {
        try { sink.close(); } catch { /* ignore */ }
    }
});

test("FG03-54: a Proxy options object runs no traps, and swapping the ledger module cache cannot forge a confirmation", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { createAuditLedger, createFileAuditSink } = require("../../../src/runtime/auditLedger");
    const { isDurableAuditSink } = require("../../../src/runtime/auditLedger/fileSink");

    // Proxy traps run on EVERY reflective operation, including the descriptor
    // read and the prototype walk used to resolve the option, so a Proxy is now
    // rejected before any read.
    let traps = 0;
    const proxyOpts = new Proxy({}, {
        getOwnPropertyDescriptor() { traps += 1; return undefined; },
        getPrototypeOf(t) { traps += 1; return Object.getPrototypeOf(t); },
        get() { traps += 1; return true; }
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg03-prx-"));
    const sink = createFileAuditSink(path.join(dir, "audit.jsonl"), proxyOpts);
    assert.equal(traps, 0, "no Proxy trap may run while resolving the option");
    assert.equal(isDurableAuditSink(sink), true, "the safe default (fsync on) stays in force");
    try { sink.close(); } catch { /* ignore */ }

    // The canonical brand check and the detach helper are resolved when the
    // governed module LOADS, so replacing the audit-ledger entry in the
    // CommonJS cache afterwards cannot substitute a fake brand.
    const ledgerPath = require.resolve("../../../src/runtime/auditLedger");
    const original = require.cache[ledgerPath];
    const fakeLedger = Object.freeze({
        append() { return { eventId: "forged" }; },
        getByEventId(id) { return { eventId: id, eventType: "trust", source: "elsewhere", metadata: {} }; },
        hasDurableSink: true
    });
    try {
        require.cache[ledgerPath] = {
            id: ledgerPath, filename: ledgerPath, loaded: true,
            exports: { isAuditLedger: () => true }
        };
        const forged = recordModeTransitionChecked({
            auditLedger: fakeLedger, from: "off", to: "governed"
        });
        assert.equal(forged.audited, false,
            "a swapped-out brand check must not confirm a fake ledger");
        assert.equal(forged.failedOpen, true);
    } finally {
        require.cache[ledgerPath] = original;
    }
});
