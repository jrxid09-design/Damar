-- Governance (subsistem 7): proposal + audit. Aditif.
--
-- Aturan inti: Aether TAK PERNAH mengubah memori jangka panjang ber-tier
-- "ask" tanpa persetujuan eksplisit. Tulis ask-tier ditahan di sini sebagai
-- PROPOSAL sampai pengguna menyetujui; audit mencatat setiap keputusan.

CREATE TABLE IF NOT EXISTS memory_proposals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT    NOT NULL,                      -- memory|edge|update|forget
    payload      TEXT    NOT NULL,                      -- JSON aksi yang diusulkan
    memory_type  TEXT,
    writer       TEXT    NOT NULL DEFAULT 'aether',
    role         TEXT    NOT NULL DEFAULT 'superadmin',
    status       TEXT    NOT NULL DEFAULT 'pending',    -- pending|approved|rejected
    reason       TEXT,
    committed_id INTEGER,                               -- id hasil commit (bila disetujui)
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    decided_at   TEXT,
    decided_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON memory_proposals(status);

CREATE TABLE IF NOT EXISTS memory_audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    action  TEXT NOT NULL,          -- propose|approve|reject|commit|rollback|forget
    actor   TEXT,
    target  TEXT,                   -- id proposal / memori terkait
    detail  TEXT NOT NULL DEFAULT '{}',
    at      TEXT NOT NULL DEFAULT (datetime('now'))
);
