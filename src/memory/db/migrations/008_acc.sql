-- ACC C0 — Damar Cognitive Core (shadow-only).
--
-- Prinsip:
--   * COGNITION NEVER GRANTS AUTHORITY — tabel di sini menyimpan state
--     kognitif fungsional, BUKAN otorisasi. Tidak ada kolom peran/grant.
--   * Event-sourced: jurnal append-only dengan rantai hash untuk
--     deteksi korupsi (bukan klaim anti-tamper terhadap attacker lokal
--     ber-privilese — lihat docs/security/ACC-boundary.md).
--   * Snapshot untuk replay cepat; state semantik direkonstruksi dari
--     snapshot + replay event berikutnya.
--
-- Tabel mengikuti konvensi repository (snake_case, TEXT id, JSON payload).

CREATE TABLE IF NOT EXISTS acc_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acc_event_journal (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id       TEXT NOT NULL UNIQUE,
    type           TEXT NOT NULL,
    occurred_at    TEXT NOT NULL,
    monotonic      INTEGER NOT NULL,
    source         TEXT NOT NULL,
    provenance     TEXT NOT NULL,
    subject        TEXT,
    session_id     TEXT,
    correlation_id TEXT,
    confidence     REAL NOT NULL DEFAULT 1,
    payload        TEXT NOT NULL,
    prev_hash      TEXT,
    hash           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acc_journal_type
    ON acc_event_journal (type, seq);

CREATE TABLE IF NOT EXISTS acc_snapshot (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    seq_up_to   INTEGER NOT NULL,
    state       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acc_prediction (
    prediction_id TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acc_experience (
    experience_id TEXT PRIMARY KEY,
    significance  REAL NOT NULL,
    payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acc_commitment (
    commitment_id TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acc_substrate_epoch (
    epoch_id TEXT PRIMARY KEY,
    payload  TEXT NOT NULL
);
