-- Knowledge Graph (subsistem 4): sisi (edge) bi-temporal milik Damar Core.
-- Aditif — tabel baru, tak menyentuh tabel yang ada.
--
-- Bi-temporal: valid_from/valid_to = kapan fakta BERLAKU di dunia;
--              recorded_at/superseded_at = kapan Damar MENCATAT/menggantinya.
-- Simpul (subject/object) disimpan sebagai teks bebas dulu; penautan ke
-- tabel entities menyusul bila perlu (ceiling: belum ada resolusi entitas).

CREATE TABLE IF NOT EXISTS memory_edges (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject       TEXT    NOT NULL,
    predicate     TEXT    NOT NULL,
    object        TEXT    NOT NULL,
    confidence    REAL    NOT NULL DEFAULT 1.0,
    source        TEXT    NOT NULL DEFAULT 'damar',
    metadata      TEXT    NOT NULL DEFAULT '{}',
    valid_from    TEXT    NOT NULL DEFAULT (datetime('now')),
    valid_to      TEXT,
    recorded_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    superseded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_subject ON memory_edges(subject);
CREATE INDEX IF NOT EXISTS idx_edges_object  ON memory_edges(object);
CREATE INDEX IF NOT EXISTS idx_edges_pred    ON memory_edges(predicate);

-- Satu sisi "hidup" (valid_to NULL) per triple; versi lama tetap tersimpan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple_live
    ON memory_edges(subject, predicate, object)
    WHERE valid_to IS NULL;
