const test = require("node:test");
const assert = require("node:assert");

/**
 * Wave7 shared prerequisite — ACC envelope v1 backward-read compatibility.
 * Conservative normalization only: legacy rows never get promoted to a
 * classification they never asserted.
 */

const envelope = require("../../../src/cognition/core/envelope");

function legacyV1Row(overrides = {}) {
    // Bentuk baris jurnal v1 asli: TIDAK ADA schemaVersion, TIDAK ADA
    // epistemicClass sama sekali (kolom belum ada sebelum migrasi 011).
    return {
        eventId: "legacy-1", type: "TOOL_SUCCEEDED", occurredAt: "2026-01-01T00:00:00.000Z",
        monotonic: 1, source: "foundation.adapter", provenance: "OBSERVATION",
        subject: null, sessionId: null, correlationId: null,
        confidence: 1, payload: { ok: true },
        prevHash: null, hash: "legacy-hash",
        ...overrides
    };
}

test("W7-ENV-17: v1 persisted record reads successfully (no throw)", () => {
    assert.doesNotThrow(() => envelope.normalizeEnvelopeRecord(legacyV1Row()));
});

test("W7-ENV-18: v1 normalizes conservatively to v2 shape", () => {
    const normalized = envelope.normalizeEnvelopeRecord(legacyV1Row());
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.epistemicClass, "UNKNOWN");
    // Field v1 asli tetap dipertahankan apa adanya.
    assert.equal(normalized.eventId, "legacy-1");
    assert.equal(normalized.provenance, "OBSERVATION");
});

test("W7-ENV-19: v1 normalization never invents OBSERVED, even from OBSERVATION-flavored provenance", () => {
    const observationLike = envelope.normalizeEnvelopeRecord(
        legacyV1Row({ provenance: "OBSERVATION" }));
    const hypothesisLike = envelope.normalizeEnvelopeRecord(
        legacyV1Row({ provenance: "MODEL_HYPOTHESIS", eventId: "legacy-2" }));

    // Baik provenance yang "kelihatan seperti" observasi maupun yang
    // "kelihatan seperti" hipotesis, keduanya v1 => UNKNOWN. Tidak ada
    // pemetaan heuristik provenance -> epistemicClass (§ kontrak: jangan
    // menciptakan kepastian dari data tak langsung).
    assert.equal(observationLike.epistemicClass, "UNKNOWN");
    assert.equal(hypothesisLike.epistemicClass, "UNKNOWN");
});

test("v1 row with explicit schemaVersion:1 also normalizes to UNKNOWN", () => {
    const normalized = envelope.normalizeEnvelopeRecord(legacyV1Row({ schemaVersion: 1 }));
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.epistemicClass, "UNKNOWN");
});

test("v2 row with a corrupted epistemicClass value fails closed to UNKNOWN, not to a crash", () => {
    const corrupted = envelope.normalizeEnvelopeRecord(
        legacyV1Row({ schemaVersion: 2, epistemicClass: "TOTALLY_CERTAIN" }));
    assert.equal(corrupted.epistemicClass, "UNKNOWN");
});
