/**
 * Epistemics (§12/§16/§70/§80/§98/§100).
 *
 * Pemisahan kelas: SELF_STATE / USER_CLAIM / MODEL_HYPOTHESIS / dll
 * TIDAK PERNAH collapse. Klaim & hipotesis masuk daftar masing-masing;
 * field otoritatif self hanya ditulis reducer dengan provenance
 * SELF_STATE/SYSTEM_SENSOR/SYSTEM_EVENT.
 */

const { structuredCopy, clamp01 } = require("../core/envelope");

const CONTRADICTION_LIMIT = 50;

function emptySelf() {
    return {
        fields: {},          // nama → {value, provenance, updatedAt, eventId}
        claims: [],          // USER_CLAIM (dipisah, tidak pernah otoritatif)
        hypotheses: [],      // MODEL_HYPOTHESIS (idem)
        limitations: [],     // OBSERVATION tentang batas diri
        capabilitiesReadView: [],
        contradictions: []
    };
}

/** Tulis field otoritatif — hanya untuk provenance tepercaya. */
const TRUSTED_FOR_SELF = new Set(["SELF_STATE", "SYSTEM_SENSOR", "SYSTEM_EVENT", "INFERENCE"]);

function setSelfField(self, name, value, { provenance, eventId, at }) {
    if (!TRUSTED_FOR_SELF.has(provenance)) {
        // Pemanggil salah kelas → tolak keras, bukan fail-open.
        throw new Error(
            `ACC: provenance '${provenance}' tidak berhak menulis ` +
            `field otoritatif '${name}'.`);
    }
    const prev = self.fields[name]?.value;
    const next = structuredCopy(self);
    next.fields[name] = {
        value: typeof value === "number" ? clamp01(value) : structuredCopy(value),
        provenance,
        updatedAt: at,
        eventId
    };
    return { next, previous: prev };
}

/**
 * USER_CLAIM / MODEL_HYPOTHESIS: disimpan TERPISAH. Bila menyentuh nama
 * field otoritatif yang sudah ada dan nilainya bertentangan, catat
 * kontradiksi — tanpa mengubah nilai otoritatif (§98).
 */
function recordClaimOrHypothesis(self, kind, name, claimedValue,
                                 { eventId, at, confidence }) {

    const bucketName = kind === "USER_CLAIM" ? "claims" : "hypotheses";
    const next = structuredCopy(self);
    next[bucketName] = [
        ...next[bucketName],
        { name, value: structuredCopy(claimedValue), eventId, at, confidence }
    ].slice(-200);

    const authoritative = next.fields[name];
    if (authoritative !== undefined &&
        !deepEqual(authoritative.value, claimedValue)) {
        next.contradictions = [
            ...next.contradictions,
            {
                field: name,
                authoritativeValue: structuredCopy(authoritative.value),
                claimedValue: structuredCopy(claimedValue),
                kind,
                eventId,
                at
            }
        ].slice(-CONTRADICTION_LIMIT);
    }

    return next;
}

/** Kontradiksi INTERNAL antar-field otoritatif (§70). */
function recordInternalContradiction(self, entry) {
    const next = structuredCopy(self);
    next.contradictions = [...next.contradictions, entry]
        .slice(-CONTRADICTION_LIMIT);
    return next;
}

function deepEqual(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

module.exports = {
    emptySelf, setSelfField,
    recordClaimOrHypothesis, recordInternalContradiction,
    TRUSTED_FOR_SELF
};
