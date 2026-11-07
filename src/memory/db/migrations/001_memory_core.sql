-- ============================================================
-- Damar — Local Memory, skema inti
--
-- Tiga lapis yang saling menunjuk:
--   entities   : "siapa/apa" — orang, kendaraan, ruangan, project
--   memories   : "apa yang terjadi / apa yang benar"
--   documents  : sumber pengetahuan panjang, dipecah jadi chunk
--
-- Pencarian memakai FTS5 (kata kunci) dan vektor embedding
-- (kemiripan makna). Keduanya dibutuhkan: kata kunci menang untuk
-- nama/plat/kode, vektor menang untuk parafrase.
-- ============================================================


-- ---- Entitas -------------------------------------------------

CREATE TABLE IF NOT EXISTS entities (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,

    -- person | vehicle | room | device | project | place |
    -- organization | file | pet | other
    kind          TEXT    NOT NULL,

    name          TEXT    NOT NULL,

    -- Nama ternormalisasi (huruf kecil, tanpa tanda baca) supaya
    -- "Honda Vario" dan "honda  vario" tidak jadi dua entitas.
    normalized    TEXT    NOT NULL,

    description   TEXT,

    attributes    TEXT    NOT NULL DEFAULT '{}',   -- JSON

    importance    REAL    NOT NULL DEFAULT 0.5,
    confidence    REAL    NOT NULL DEFAULT 1.0,

    first_seen_at TEXT,
    last_seen_at  TEXT,

    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),

    -- Saat dua entitas ternyata sama, yang kalah diarahkan ke
    -- pemenang alih-alih dihapus, agar referensi lama tetap sah.
    merged_into   INTEGER REFERENCES entities(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_identity
    ON entities(kind, normalized);

CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen_at);


-- Alias: "ayah", "bapak", "Pak Budi" -> entitas yang sama.
CREATE TABLE IF NOT EXISTS entity_aliases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias      TEXT    NOT NULL,
    normalized TEXT    NOT NULL,
    source     TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_unique
    ON entity_aliases(entity_id, normalized);

CREATE INDEX IF NOT EXISTS idx_alias_lookup
    ON entity_aliases(normalized);


-- Relasi antar entitas: "X owns Vario", "Vario parked_in Garasi".
CREATE TABLE IF NOT EXISTS entity_relations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation    TEXT    NOT NULL,
    attributes  TEXT    NOT NULL DEFAULT '{}',
    confidence  REAL    NOT NULL DEFAULT 1.0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_unique
    ON entity_relations(from_id, to_id, relation);


-- ---- Memori ---------------------------------------------------

CREATE TABLE IF NOT EXISTS memories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,

    -- episodic   : sesuatu yang terjadi pada satu waktu
    -- semantic   : fakta yang berlaku umum
    -- preference : selera/kebiasaan pemilik
    -- procedural : cara melakukan sesuatu
    type          TEXT    NOT NULL DEFAULT 'episodic',

    content       TEXT    NOT NULL,

    -- Ringkasan pendek untuk ditempel ke prompt tanpa memakan
    -- konteks; diisi hanya bila content panjang.
    summary       TEXT,

    -- Dari mana memori ini berasal: chat | cctv | sensor | telegram
    -- | docker | immich | document | manual | system
    source        TEXT    NOT NULL DEFAULT 'system',

    -- Penunjuk balik ke asal (id sesi, path file, id kamera, dst).
    source_ref    TEXT,

    importance    REAL    NOT NULL DEFAULT 0.5,   -- 0..1
    confidence    REAL    NOT NULL DEFAULT 1.0,   -- 0..1

    -- Kapan peristiwanya terjadi (bisa berbeda dari kapan dicatat).
    occurred_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),

    -- Dipakai untuk konsolidasi: memori yang sering dipanggil
    -- bertahan, yang tidak pernah dipakai boleh meluruh.
    last_recalled_at TEXT,
    recall_count  INTEGER NOT NULL DEFAULT 0,

    -- Fakta bisa kedaluwarsa ("mobil ada di garasi").
    valid_until   TEXT,

    -- Fakta yang digantikan tidak dihapus, hanya ditandai — riwayat
    -- perubahan sering lebih berguna daripada nilai terakhir saja.
    superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,

    -- Memori sensitif tidak ikut terinjeksi otomatis ke prompt.
    sensitive     INTEGER NOT NULL DEFAULT 0,

    pinned        INTEGER NOT NULL DEFAULT 0,

    metadata      TEXT    NOT NULL DEFAULT '{}',  -- JSON

    document_id   INTEGER REFERENCES documents(id) ON DELETE CASCADE,

    -- Hash isi untuk menolak duplikat persis.
    content_hash  TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);

CREATE INDEX IF NOT EXISTS idx_memories_type      ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_source    ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_occurred  ON memories(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memories_active    ON memories(superseded_by, valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_document  ON memories(document_id);


-- Kaitan memori <-> entitas. `role` menjelaskan peran entitas di
-- dalam memori: actor, object, location, dsb.
CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    role      TEXT    NOT NULL DEFAULT 'mentions',
    PRIMARY KEY (memory_id, entity_id, role)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity
    ON memory_entities(entity_id);


-- ---- Dokumen ---------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uri          TEXT    NOT NULL,
    title        TEXT,
    media_type   TEXT,
    byte_size    INTEGER,

    -- Hash isi: file yang sama tidak di-ingest dua kali.
    content_hash TEXT    NOT NULL,

    char_count   INTEGER NOT NULL DEFAULT 0,
    chunk_count  INTEGER NOT NULL DEFAULT 0,

    status       TEXT    NOT NULL DEFAULT 'pending',
    error        TEXT,

    metadata     TEXT    NOT NULL DEFAULT '{}',

    ingested_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_uri ON documents(uri);


CREATE TABLE IF NOT EXISTS document_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    content     TEXT    NOT NULL,
    heading     TEXT,
    char_start  INTEGER,
    char_end    INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_position
    ON document_chunks(document_id, ordinal);


-- ---- Embedding --------------------------------------------------
--
-- Vektor disimpan sebagai BLOB Float32. SQLite tanpa ekstensi vektor
-- tidak bisa mencari kemiripan, jadi kemiripan dihitung di JS atas
-- kandidat hasil penyaringan kata kunci/waktu — cukup untuk skala
-- satu rumah, dan tidak menambah dependensi native.
--
-- `owner_kind` memisahkan vektor milik memori dan milik chunk
-- dokumen dalam satu tabel agar backfill-nya satu jalur.

CREATE TABLE IF NOT EXISTS embeddings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,

    owner_kind TEXT    NOT NULL,          -- memory | chunk | entity
    owner_id   INTEGER NOT NULL,

    model      TEXT    NOT NULL,
    dim        INTEGER NOT NULL,
    vector     BLOB    NOT NULL,

    -- Norma disimpan agar cosine similarity cukup satu dot product.
    norm       REAL    NOT NULL,

    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_owner
    ON embeddings(owner_kind, owner_id, model);

CREATE INDEX IF NOT EXISTS idx_embedding_model ON embeddings(owner_kind, model);


-- ---- Indeks full-text --------------------------------------------
--
-- FTS5 "external content": isi tetap di tabel aslinya, FTS hanya
-- menyimpan indeks. Trigger menjaga keduanya sinkron.

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    summary,
    content = 'memories',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert
AFTER INSERT ON memories
BEGIN
    INSERT INTO memories_fts(rowid, content, summary)
    VALUES (new.id, new.content, coalesce(new.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete
AFTER DELETE ON memories
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, summary)
    VALUES ('delete', old.id, old.content, coalesce(old.summary, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update
AFTER UPDATE OF content, summary ON memories
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, summary)
    VALUES ('delete', old.id, old.content, coalesce(old.summary, ''));
    INSERT INTO memories_fts(rowid, content, summary)
    VALUES (new.id, new.content, coalesce(new.summary, ''));
END;


CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    heading,
    content = 'document_chunks',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_insert
AFTER INSERT ON document_chunks
BEGIN
    INSERT INTO chunks_fts(rowid, content, heading)
    VALUES (new.id, new.content, coalesce(new.heading, ''));
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_delete
AFTER DELETE ON document_chunks
BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content, heading)
    VALUES ('delete', old.id, old.content, coalesce(old.heading, ''));
END;


CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name,
    description,
    content = 'entities',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS entities_fts_insert
AFTER INSERT ON entities
BEGIN
    INSERT INTO entities_fts(rowid, name, description)
    VALUES (new.id, new.name, coalesce(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_delete
AFTER DELETE ON entities
BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, description)
    VALUES ('delete', old.id, old.name, coalesce(old.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_update
AFTER UPDATE OF name, description ON entities
BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, description)
    VALUES ('delete', old.id, old.name, coalesce(old.description, ''));
    INSERT INTO entities_fts(rowid, name, description)
    VALUES (new.id, new.name, coalesce(new.description, ''));
END;
