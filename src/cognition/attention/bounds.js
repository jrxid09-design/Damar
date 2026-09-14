"use strict";

const SCHEMA_VERSION = "attention.v1";

const PRIORITY_CLASSES = Object.freeze(["P0_SAFETY", "P1_OWNER", "P2_COMMITMENT", "P3_GOAL", "P4_BACKGROUND"]);

/** §4: kuota cadangan per kelas (persen, jumlah 100). */
const CLASS_QUOTA = Object.freeze({
    P0_SAFETY: 20, P1_OWNER: 35, P2_COMMITMENT: 20, P3_GOAL: 15, P4_BACKGROUND: 10
});

/** Basis effectivePriority — hanya untuk pengurutan DALAM kelas yang sama terpilih. */
const CLASS_BASE = Object.freeze({
    P0_SAFETY: 1000, P1_OWNER: 800, P2_COMMITMENT: 600, P3_GOAL: 400, P4_BACKGROUND: 200
});

const BOUNDS = Object.freeze({
    MAX_QUEUED_TARGETS: 4096,
    MAX_TOTAL_TARGETS: 8192,
    // Bug review independen (audit putaran-19, AUD19-P2-1): tanpa
    // governorPort, pick() memakai `maxRunning = Infinity` -- RUNNING tidak
    // pernah dipurge (memang seharusnya, itu pekerjaan aktif), tapi tanpa
    // batas di sisi MASUKNYA, jumlah target RUNNING bisa tumbuh tak
    // terbatas, membuat MAX_TOTAL_TARGETS tidak bisa ditegakkan sama sekali
    // (blok purge hanya boleh memilih korban non-RUNNING). Batas jatuh diri
    // ini menutup celah itu saat tidak ada governor eksternal yang mengatur.
    MAX_RUNNING_TARGETS: 256,
    MAX_SIGNALS_PER_SOURCE_PER_MINUTE: 120,
    MAX_DISTINCT_SOURCES_COUNTED: 8,
    MAX_WAIT_MS: 60_000,
    MAX_PREEMPTIONS: 3,
    MAX_OVERFLOW_JOURNAL: 100000,
    AGING_BONUS_MAX: 100,
    DECAY_PER_MS: 0.0005,
    CORROBORATION_BONUS_MAX: 50,
    MAX_SUPPORTING_SIGNALS_PER_TARGET: 64,
    MAX_TRACKED_SOURCES: 4096,
    MAX_GOVERNOR_MAPPING_AUDIT: 4096,
    MAX_SEEN_SIGNAL_IDS: 50000,
    // Bug review independen (audit putaran-39, AUD39-P2-1): Symbol
    // evidenceRef adalah primitif (bukan objek), jadi tidak bisa jadi
    // kunci WeakMap -- Map biasa dipakai, yang TIDAK di-garbage-collect
    // sendiri seperti WeakMap. Dibatasi eksplisit dengan eviksi FIFO,
    // sama seperti MAX_SEEN_SIGNAL_IDS.
    MAX_SEEN_SYMBOL_EVIDENCE_REFS: 50000
});

module.exports = { SCHEMA_VERSION, PRIORITY_CLASSES, CLASS_QUOTA, CLASS_BASE, BOUNDS };
