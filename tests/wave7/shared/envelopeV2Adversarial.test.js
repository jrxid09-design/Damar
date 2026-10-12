const test = require("node:test");
const assert = require("node:assert");

const envelope = require("../../../src/cognition/core/envelope");

/** Cocokkan `error.code`, bukan teks pesan (pesan berbahasa Indonesia
 * dan sengaja tidak menyertakan string kode ACC_* secara verbatim). */
function assertThrowsCode(fn, code) {
    assert.throws(fn, (err) => {
        assert.equal(err.code, code, `expected code '${code}', got '${err.code}': ${err.message}`);
        return true;
    });
}

function fakeLengthArray(items, badLen) {
    return new Proxy(items.slice(), {
        get(t, p, r) { return p === "length" ? badLen : Reflect.get(t, p, r); }
    });
}

test("W7-ENV-repair-8: walkSafe fails closed (not raw-throw) on a revoked-Proxy payload, including nested inside a plain object (independent audit W7R43-P2-6/W7R43-P2-7)", () => {
    const r = Proxy.revocable([1], {});
    r.revoke();
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: r.proxy })), "ACC_INVALID_METADATA");

    const nested = Proxy.revocable({ x: 1 }, {});
    nested.revoke();
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: { extra: nested.proxy } })), "ACC_INVALID_METADATA");
});

test("W7-ENV-repair-9: walkSafe's fail-closed catch itself does not raw-throw when the caught value is a hostile object whose own inspection throws (independent audit W7R44-P2-1)", () => {
    const h = new Proxy({}, { getPrototypeOf() { throw new Error("RAW"); } });
    const hostile = new Proxy({}, {
        getOwnPropertyDescriptor() { throw h; },
        ownKeys() { return ["a"]; },
        getPrototypeOf() { return Object.prototype; }
    });
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: hostile })), "ACC_INVALID_METADATA");
});

test("W7-ENV-repair-10: makeEnvelope rejects a revoked-Proxy epistemicClass with the controlled ACC_INVALID_EPISTEMIC_CLASS code, not a raw TypeError -- isEpistemicClass lacked the typeof short-circuit its sibling isKnownProvenance already had (independent audit W7R47-P2-1)", () => {
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ epistemicClass: r.proxy })), "ACC_INVALID_EPISTEMIC_CLASS");
});

test("W7-ENV-repair-11: makeEnvelope fails closed on a revoked-Proxy TOP-LEVEL spec, and never raw-throws coercing a hostile truthy subject/source/sessionId/missionId/correlationId via String() (independent audit W7R47-ADV-1)", () => {
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsCode(() => envelope.makeEnvelope(r.proxy), "ACC_INVALID_METADATA");

    const revokedFields = Proxy.revocable({}, {});
    revokedFields.revoke();
    const hostile = revokedFields.proxy;
    const env = envelope.makeEnvelope(baseSpec({ subject: hostile, sessionId: hostile, missionId: hostile, correlationId: hostile, source: hostile }));
    assert.equal(env.subject, null, "a truthy non-primitive subject must degrade to null, never invoke String()'s ToPrimitive coercion");
    assert.equal(env.sessionId, null);
    assert.equal(env.missionId, null);
    assert.equal(env.correlationId, null);
    assert.equal(env.source, "unknown", "a truthy non-primitive source must degrade to the same default as a missing source");
});

test("W7-ENV-repair-12: normalizeEnvelopeRecord fails closed on a revoked-Proxy row and a Symbol schemaVersion, and never stores a non-enum epistemicClass forged by a stateful getter (independent audit W7R48-P2-1)", () => {
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsCode(() => envelope.normalizeEnvelopeRecord(r.proxy), "ACC_INVALID_ENVELOPE_RECORD");
    assertThrowsCode(() => envelope.normalizeEnvelopeRecord({ schemaVersion: Symbol("v") }), "ACC_UNKNOWN_SCHEMA_VERSION");

    let n = 0;
    const row = { eventId: "e1", type: "SELF_STATE_UPDATED", payload: {}, schemaVersion: 2 };
    Object.defineProperty(row, "epistemicClass", {
        enumerable: true,
        get() { return ++n === 1 ? "OBSERVED" : { forged: true, toJSON() { return "PWNED"; } }; }
    });
    const out = envelope.normalizeEnvelopeRecord(row);
    assert.equal(typeof out.epistemicClass, "string", "a stateful getter must never let a forged non-string object become the stored epistemicClass");
    assert.equal(out.epistemicClass, "OBSERVED", "the SAME single read used for validation must be the one stored");
});

test("W7-ENV-repair-13: makeEnvelope fails closed (not raw-throw) on a malformed/revoked/throwing clock -- round 47 hardened this function's destructure and String() coercions but left the sibling clock.nowMs() call unguarded (independent audit W7R48-P2-2)", () => {
    const base = { type: "SELF_STATE_UPDATED", source: "s", provenance: "SELF_STATE", payload: {} };
    assertThrowsCode(() => envelope.makeEnvelope({ ...base, clock: {} }), "ACC_INVALID_METADATA");
    assertThrowsCode(() => envelope.makeEnvelope({ ...base, clock: { nowMs: 1 } }), "ACC_INVALID_METADATA");
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsCode(() => envelope.makeEnvelope({ ...base, clock: r.proxy }), "ACC_INVALID_METADATA");
    assertThrowsCode(() => envelope.makeEnvelope({ ...base, clock: { nowMs() { throw new Error("hostile"); } } }), "ACC_INVALID_METADATA");
    assertThrowsCode(() => envelope.makeEnvelope({ ...base, clock: { nowMs: () => NaN } }), "ACC_INVALID_METADATA");
    // a legitimate clock still works and is honored:
    const env = envelope.makeEnvelope({ ...base, clock: { nowMs: () => 1_000_000 } });
    assert.equal(env.timestamp, new Date(1_000_000).toISOString());
});

test("W7-ENV-repair-7: walkSafe rejects a payload array whose .length is negative/NaN/Infinity/fractional instead of skipping or infinite-looping (independent audit W7R42-P2-1)", () => {
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        const arr = fakeLengthArray([1], badLen);
        assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: { list: arr } })), "ACC_INVALID_METADATA");
    }
});

function baseSpec(overrides = {}) {
    return {
        type: "TOOL_SUCCEEDED",
        source: "test",
        provenance: "SYSTEM_EVENT",
        payload: { ok: true },
        clock: { nowMs: () => 1_000_000 },
        ...overrides
    };
}

test("W7-ENV-03: arbitrary epistemic class rejected", () => {
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ epistemicClass: "DEFINITELY_TRUE" })),
        "ACC_INVALID_EPISTEMIC_CLASS"
    );
});

test("W7-ENV-06/07: confidence out of [0,1] rejected", () => {
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ confidence: -0.001 })),
        "ACC_INVALID_CONFIDENCE");
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ confidence: 1.001 })),
        "ACC_INVALID_CONFIDENCE");
});

test("W7-ENV-repair-6: prototype-shaped provenance strings (__proto__/constructor/toString) are rejected as ACC_UNKNOWN_PROVENANCE, not accepted via an inherited Object.prototype member; a Symbol provenance/type also fails closed (independent audit AUD29-P2-1)", () => {
    for (const p of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
        assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ provenance: p })), "ACC_UNKNOWN_PROVENANCE");
    }
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ provenance: Symbol("p") })), "ACC_UNKNOWN_PROVENANCE");
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ type: Symbol("t") })), "ACC_UNKNOWN_EVENT_TYPE");
});

test("W7-ENV-repair-4: a Symbol confidence/epistemicClass fails closed with an ACC_INVALID_* code, not a raw TypeError (independent audit AUD27-P2-4)", () => {
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ confidence: Symbol("c") })), "ACC_INVALID_CONFIDENCE");
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ epistemicClass: Symbol("e") })), "ACC_INVALID_EPISTEMIC_CLASS");
});

test("W7-ENV-08: NaN/Infinity/-Infinity confidence rejected", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
        assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ confidence: bad })),
            "ACC_INVALID_CONFIDENCE");
    }
});

test("W7-ENV-11: functions in payload rejected, not silently dropped", () => {
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: { handler: () => 1 } })),
        "ACC_INVALID_METADATA"
    );
});

test("W7-ENV-11b: Symbols in payload (value and key) rejected", () => {
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: { v: Symbol("x") } })),
        "ACC_INVALID_METADATA"
    );
    const withSymbolKey = { a: 1 };
    withSymbolKey[Symbol("k")] = 1;
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: withSymbolKey })),
        "ACC_INVALID_METADATA"
    );
});

test("W7-ENV-12: prototype-pollution keys rejected", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}');
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: hostile })),
        "ACC_INVALID_METADATA"
    );
    assert.equal({}.polluted, undefined, "prototype global tidak boleh tercemar");
});

test("W7-ENV-13: cyclic payload rejected (shared non-cyclic refs still allowed)", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: cyclic })),
        "ACC_INVALID_METADATA"
    );

    const shared = { v: 1 };
    const dagNotCyclic = { x: shared, y: shared };
    assert.doesNotThrow(() => envelope.makeEnvelope(baseSpec({ payload: dagNotCyclic })),
        "referensi bersama (DAG) yang sah bukan siklus, tidak boleh ditolak");
});

test("W7-ENV-14: accessor properties rejected without invoking the getter", () => {
    let invoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "trap", {
        enumerable: true,
        get() { invoked = true; return "should-not-run"; }
    });

    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: hostile })),
        "ACC_INVALID_METADATA"
    );
    assert.equal(invoked, false, "getter tidak boleh pernah dipanggil");
});

test("W7-ENV-15: hostile Proxy is neutralized safely (no crash, no bypass)", () => {
    // Bug review independen (audit putaran-3, AUD3-P1-1): pagar sekarang
    // membaca nilai HANYA dari `getOwnPropertyDescriptor(...).value`, tidak
    // pernah lewat `value[key]` -- jadi trap `get` proxy ini (yang dulu
    // ikut terpanggil lewat walk lama dan melempar) TIDAK PERNAH terpanggil
    // sama sekali. Ini properti keamanan yang lebih kuat daripada sekadar
    // "melempar": envelope terbentuk aman, hanya dari data yang benar-benar
    // dideklarasikan lewat descriptor, trap get tidak pernah dieksekusi.
    const target = { a: 1 };
    let getTrapCalled = false;
    const hostile = new Proxy(target, {
        get() { getTrapCalled = true; throw new Error("hostile trap fired"); },
        ownKeys() { return ["a"]; },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: 1 }; }
    });

    const env = envelope.makeEnvelope(baseSpec({ payload: hostile }));
    assert.equal(getTrapCalled, false, "trap get proxy tidak boleh pernah terpanggil");
    assert.deepEqual(env.payload, { a: 1 });
});

test("W7-ENV-16: authority-shaped payload keys stay inert opaque data", () => {
    const env = envelope.makeEnvelope(baseSpec({
        payload: {
            authorityDecision: "ALLOW", allow: true, grant: "root",
            owner: "me", authProof: "forged", capabilityGrant: "*",
            executionLease: "lease-1", executor: "acc", route: "/admin",
            trustedNode: "node-1", rootAuthority: true
        }
    }));

    // Amplop tidak pernah menginterpretasikan isi payload — ia tetap data
    // buram. Tidak ada field authority di LEVEL AMPLOP itu sendiri.
    const authorityShapedKeys = [
        "authorityDecision", "allow", "grant", "owner", "authProof",
        "capabilityGrant", "executionLease", "executor", "route",
        "trustedNode", "rootAuthority"
    ];
    for (const key of authorityShapedKeys) {
        assert.equal(Object.prototype.hasOwnProperty.call(env, key), false,
            `amplop tidak boleh punya field level-atas '${key}'`);
    }
    assert.equal(env.payload.authorityDecision, "ALLOW",
        "payload tetap tersimpan apa adanya, tapi tidak pernah dibaca sebagai otoritas oleh amplop");
});

test("W7-ENV-24: payload bounds enforced (depth/keys/string/array/bytes)", () => {
    let deep = { v: 1 };
    for (let i = 0; i < envelope.ENVELOPE_BOUNDS.MAX_PAYLOAD_DEPTH + 2; i++) {
        deep = { nested: deep };
    }
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: deep })),
        "ACC_INVALID_METADATA");

    const manyKeys = {};
    for (let i = 0; i < envelope.ENVELOPE_BOUNDS.MAX_PAYLOAD_KEYS + 1; i++) manyKeys[`k${i}`] = 1;
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: manyKeys })),
        "ACC_INVALID_METADATA");

    const longString = "x".repeat(envelope.ENVELOPE_BOUNDS.MAX_PAYLOAD_STRING_CHARS + 1);
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: { s: longString } })),
        "ACC_INVALID_METADATA");

    const longArray = new Array(envelope.ENVELOPE_BOUNDS.GLOBAL_MAX_ARRAY_LENGTH + 1).fill(1);
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: { a: longArray } })),
        "ACC_INVALID_METADATA");

    // Ukuran total amplop: setiap field di bawah batas per-field-nya
    // sendiri (64 kunci di batas MAX_PAYLOAD_KEYS, tiap string di batas
    // MAX_PAYLOAD_STRING_CHARS) tetapi totalnya melewati MAX_ENVELOPE_BYTES.
    const atFieldLimits = Object.fromEntries(
        Array.from({ length: envelope.ENVELOPE_BOUNDS.MAX_PAYLOAD_KEYS },
            (_, i) => [`k${i}`, "z".repeat(envelope.ENVELOPE_BOUNDS.MAX_PAYLOAD_STRING_CHARS)]));
    assertThrowsCode(() => envelope.makeEnvelope(baseSpec({ payload: atFieldLimits })),
        "ACC_ENVELOPE_TOO_LARGE");
});

test("W7-ENV-repair-1: accessor on an ARRAY index is rejected without invoking the getter (Codex P1 finding)", () => {
    let invoked = false;
    const hostileArray = [1, 2];
    Object.defineProperty(hostileArray, 0, {
        enumerable: true, configurable: true,
        get() { invoked = true; return "should-not-run"; }
    });
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: { arr: hostileArray } })),
        "ACC_INVALID_METADATA"
    );
    assert.equal(invoked, false, "getter pada indeks array tidak boleh pernah dipanggil");
});

test("W7-ENV-repair-2: array with a non-index toJSON hook cannot execute during serialization (Codex P1 round 3)", () => {
    const hostileArray = [1, 2];
    let invoked = false;
    hostileArray.toJSON = () => { invoked = true; return []; };
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: { arr: hostileArray } })),
        "ACC_INVALID_METADATA"
    );
    assert.equal(invoked, false, "toJSON pada array tidak boleh pernah dipanggil");
});

test("W7-ENV-repair-3: array with a redefined (non-standard) prototype carrying inherited toJSON is rejected (independent audit AUD2-P2-3)", () => {
    const arr = [1, 2, 3];
    Object.setPrototypeOf(arr, { toJSON() { return { capabilityId: "cap.x" }; } });
    assertThrowsCode(
        () => envelope.makeEnvelope(baseSpec({ payload: { arr } })),
        "ACC_INVALID_METADATA"
    );
});

test("W7-ENV-25: malformed schemaVersion on a persisted row fails closed", () => {
    assertThrowsCode(
        () => envelope.normalizeEnvelopeRecord({ schemaVersion: "not-a-version" }),
        "ACC_UNKNOWN_SCHEMA_VERSION"
    );
});

test("W7-ENV-26: unknown future schemaVersion never silently downgrades", () => {
    assertThrowsCode(
        () => envelope.normalizeEnvelopeRecord({ schemaVersion: 99, epistemicClass: "OBSERVED" }),
        "ACC_UNKNOWN_SCHEMA_VERSION"
    );
});
