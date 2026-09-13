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

test("W7-ENV-15: hostile Proxy rejected safely (no crash, no bypass)", () => {
    const target = { a: 1 };
    const hostile = new Proxy(target, {
        get() { throw new Error("hostile trap fired"); },
        ownKeys() { return ["a"]; },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: 1 }; }
    });

    assert.throws(() => envelope.makeEnvelope(baseSpec({ payload: hostile })));
    // Sengaja tidak mensyaratkan kode ACC_* spesifik di sini: syaratnya
    // hanya bahwa proses tidak crash dan tidak ada amplop yang terbentuk.
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
