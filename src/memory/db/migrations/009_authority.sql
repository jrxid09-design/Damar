-- AUTHORITY V1 — Capability Lifecycle / Evolution Authority / Ratification.
--
-- Safety-critical: seluruh mutasi lifecycle dilakukan TRANSAKSIONAL oleh
-- AuthorityRegistry (BEGIN IMMEDIATE ... COMMIT), bukan eventual-consistency
-- seperti projeksi ACC.
--
-- Audit log BUKAN sumber otoritas; tabel authority_capabilities adalah state
-- otoritatif. Konsumsi eksekusi dicatat sebagai ledger baris sehingga
-- budget bersifat atomik (hitung baris dalam transaksi yang sama).

CREATE TABLE IF NOT EXISTS authority_capabilities (
    capability_id TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    subject       TEXT NOT NULL,
    generation    INTEGER NOT NULL DEFAULT 0,
    payload       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authority_capabilities_subject
    ON authority_capabilities (subject, generation);

CREATE TABLE IF NOT EXISTS capability_events (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL UNIQUE,
    type          TEXT NOT NULL,
    capability_id TEXT,
    actor         TEXT NOT NULL,
    at            TEXT NOT NULL,
    payload       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capability_events_cap
    ON capability_events (capability_id, seq);

CREATE TABLE IF NOT EXISTS capability_consumption (
    consumption_id TEXT PRIMARY KEY,
    capability_id  TEXT NOT NULL,
    at             TEXT NOT NULL,
    meta           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_capability_consumption_cap
    ON capability_consumption (capability_id);

CREATE TABLE IF NOT EXISTS subject_generations (
    subject    TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_ratifications (
    ratification_id TEXT PRIMARY KEY,
    proposal_digest TEXT NOT NULL,
    decision        TEXT NOT NULL,
    payload         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_proposals (
    proposal_id TEXT PRIMARY KEY,
    revision    INTEGER NOT NULL,
    digest      TEXT NOT NULL,
    status      TEXT NOT NULL,
    payload     TEXT NOT NULL
);
