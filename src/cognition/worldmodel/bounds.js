"use strict";

/** W7-L2 WORLD MODEL — batas eksplisit (spec §11, provisional). */

const SCHEMA_VERSION = "worldmodel.v1";

const BOUNDS = Object.freeze({
    MAX_ENTITIES: 100000,
    MAX_ENTITIES_PER_SOURCE: 10000,          // WM-A6: kuota per-sumber, bukan rate limiter penuh
    MAX_RELATIONS: 400000,
    // Bug review independen (audit putaran-7, W7R7-P1-3, eskalasi dari
    // AUD-P2-1/W7R5-P2-4): MAX_BELIEFS_PER_SUBJECT_ATTRIBUTE tidak pernah
    // dipakai (dan tidak cocok dengan bentuk data -- `beliefs` menyimpan
    // SATU belief per kunci subject+attribute, jadi "per subject-attribute"
    // selalu 1 secara struktural). Diganti batas total yang sungguh
    // ditegakkan di applyRecordToBelief.
    MAX_TOTAL_BELIEFS: 100000,
    MAX_OBSERVATIONS_RETAINED_PER_BELIEF: 32,
    MAX_OPEN_CONTRADICTION_SETS: 4096,
    MAX_HYPOTHESES: 4096,
    MAX_ENTITY_LABEL_KEYS: 64,
    MAX_ENTITY_LABEL_CHARS: 256,
    NEIGHBORS_MAX_DEPTH: 3,
    NEIGHBORS_MAX_FANOUT: 256,
    PATH_MAX_DEPTH: 5,
    ENTITIES_BY_KIND_LIMIT: 1024,
    MAX_VALUE_ARRAY_LENGTH: 1024,
    MAX_VALUE_SCAN_DEPTH: 16,
    MAX_VALUE_KEYS: 256,
    MAX_VALUE_NODES: 512
});

module.exports = { SCHEMA_VERSION, BOUNDS };
