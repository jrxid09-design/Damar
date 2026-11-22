-- 006 AUTONOMY — capability registry, goal engine, checkpoints.
-- Fondasi runtime otonom Damar (transformasi autonomous §54).

CREATE TABLE IF NOT EXISTS capabilities (
    id            TEXT PRIMARY KEY,          -- tool:<name> | skill:<id> | agent:<id> | model:<name> | connector:<id>
    kind          TEXT NOT NULL,             -- tool|skill|agent|model|connector
    name          TEXT NOT NULL,
    description   TEXT,
    source        TEXT,                      -- ai|plugin|forge|temporary|agenthub|provider|external
    version       TEXT NOT NULL DEFAULT '1.0.0',
    meta          TEXT NOT NULL DEFAULT '{}',
    trust         REAL NOT NULL DEFAULT 0.5, -- 0..1 (reliability berjalan §39)
    usage_count   INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    total_ms      INTEGER NOT NULL DEFAULT 0,
    last_used_at  TEXT,
    last_error    TEXT,
    alive         INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_capabilities_kind ON capabilities(kind, alive);

-- Goal Engine (§18): tujuan berjangka, multi-tahap, latar belakang.
CREATE TABLE IF NOT EXISTS goals (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'active',   -- active|paused|completed|failed|impossible|blocked
    priority      TEXT NOT NULL DEFAULT 'normal',   -- low|normal|high|critical
    schedule      TEXT,                              -- cron-ish / interval / null (one-shot)
    success_criteria TEXT NOT NULL DEFAULT '[]',    -- daftar kriteria verifikasi
    constraints   TEXT NOT NULL DEFAULT '[]',
    plan          TEXT NOT NULL DEFAULT '{}',        -- rencana otonom terkini (langkah + status)
    context       TEXT NOT NULL DEFAULT '{}',        -- state loop: langkah selesai/gagal, environment ringkas
    iterations    INTEGER NOT NULL DEFAULT 0,
    last_result   TEXT,
    error         TEXT,
    project_id    TEXT,                              -- opsional: terikat Lab project
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, priority);

-- Checkpoint (§31): titik pemulihan sebelum perubahan signifikan.
CREATE TABLE IF NOT EXISTS checkpoints (
    id            TEXT PRIMARY KEY,
    scope         TEXT NOT NULL,             -- git|fs|config|skill|mission
    target        TEXT NOT NULL,             -- path/repo/objek yang di-checkpoint
    label         TEXT,
    snapshot      TEXT NOT NULL DEFAULT '{}',-- referensi pemulihan (commit/backup path)
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jejak keputusan otonom (§32): ringkas & operasional, bukan CoT.
CREATE TABLE IF NOT EXISTS autonomy_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL DEFAULT (datetime('now')),
    goal_id       TEXT,
    agent_id      TEXT,
    action        TEXT NOT NULL,             -- plan|act|verify|recover|substitute|create_skill|...
    decision      TEXT,
    reason        TEXT,
    evidence      TEXT NOT NULL DEFAULT '[]',
    result        TEXT,
    ok            INTEGER
);
