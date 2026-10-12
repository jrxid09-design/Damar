"use strict";

const SCHEMA_VERSION = "longhorizon.v1";

const BOUNDS = Object.freeze({
    MAX_AUDIT_EVENTS_PER_CYCLE: 256
    // Bug review independen (audit putaran-49, W7R49-ADV-1, kelas sama
    // dengan AUD38-ADV-3): `MAX_TRACKED_CAPABILITY_IDS` dideklarasikan
    // tapi tidak pernah dikonsumsi -- longhorizon tidak menyimpan Map
    // per-kapabilitas sendiri; satu-satunya Map-nya (previousAssessments)
    // sudah dibatasi transitif lewat selfmodel's MAX_CAPABILITY_ASSESSMENTS
    // (lihat komentar AUD29-ADV-1). Dihapus.
});

// FG-03: MODES is now owned by src/cognition/governed/bounds.js (single
// source of truth for every mode-bearing lane); re-exported here
// unchanged so existing callers of longhorizon/bounds.js see no change.
const { MODES } = require("../governed/bounds");

module.exports = { SCHEMA_VERSION, BOUNDS, MODES };
