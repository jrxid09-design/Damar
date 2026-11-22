"use strict";

const SCHEMA_VERSION = "prospective.v1";

const BOUNDS = Object.freeze({
    MAX_ARMED_REMINDERS: 10000,
    MAX_REMINDERS_PER_GOAL: 64,
    MAX_RECURRENCE_OCCURRENCES: 1000,
    MIN_RECURRENCE_INTERVAL_MS: 60_000,   // PM-A3: floor against 1-second-period spam
    MAX_CATCHUP_FIRES_PER_RESTART: 128,
    MAX_PENDING_EXPECTATIONS: 4096,
    MAX_WAKE_EVENTS_PER_MINUTE: 600,
    MAX_PAYLOAD_REF_BYTES: 1024,
    MAX_DEFERRED_WAKE_EVENTS: 2000,
    MAX_TOTAL_REMINDERS_RETAINED: 20000,
    MAX_PAYLOAD_ARRAY_LENGTH: 256,
    // Bug review independen (audit putaran-19, AUD19-P2-3): firedOccurrenceIds
    // sebelumnya hanya dipangkas OPORTUNISTIK saat reminder LAIN dikompaksi
    // (retireFiredOccurrenceIds via prefix) -- tidak ada batas eksplisit
    // sendiri, jadi satu reminder RECURRING dengan maxOccurrences besar bisa
    // menumpuk ratusan ribu kunci string yang ikut diserialisasi setiap
    // persist() sebelum kompaksi lain pernah terpicu.
    MAX_FIRED_OCCURRENCE_IDS: 50000
});

module.exports = { SCHEMA_VERSION, BOUNDS };
