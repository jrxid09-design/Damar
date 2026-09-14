"use strict";

const SCHEMA_VERSION = "metacog.v1";

const BOUNDS = Object.freeze({
    MAX_OPEN_REVIEWS: 128,
    // Bug diketemukan review independen (Codex, putaran ke-3): review yang
    // sudah EXPIRED/APPLIED/REJECTED tidak pernah dibatasi total retensinya
    // — hanya OPEN yang dihitung terhadap MAX_OPEN_REVIEWS. Ini bisa
    // menghabiskan memori lewat pemicu berulang pasca-anggaran habis.
    MAX_TOTAL_REVIEWS_RETAINED: 512,
    MAX_FINDINGS_PER_REVIEW: 64,
    MAX_PROPOSALS_PER_REVIEW: 32,
    REFLECTION_BUDGET_TOKENS_PER_HOUR: 200_000,
    REFLECTION_BUDGET_MS_PER_HOUR: 120_000,
    REVIEW_COOLDOWN_MS: 5 * 60_000,
    MAX_CALIBRATION_RECORDS: 100000,
    CALIBRATION_WINDOW_DAYS: 90,
    MAX_REVIEW_DEPTH: 1,
    NO_EVIDENCE_CEILING: 0.2,
    // Bug review independen (audit putaran-32, AUD32-P2-5): sanitizer baru
    // buildSafeCognitiveCopy (records.js) butuh anggaran kedalaman/node
    // seperti buildSafeBeliefValue/buildSafePayloadRef di lane lain, supaya
    // DAG referensi-bersama tidak meledak eksponensial.
    MAX_VALUE_SCAN_DEPTH: 16,
    MAX_VALUE_NODES: 512,
    MAX_VALUE_ARRAY_LENGTH: 1024
});

module.exports = { SCHEMA_VERSION, BOUNDS };
