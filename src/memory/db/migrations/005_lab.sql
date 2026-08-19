-- 005 AETHER LAB — project/mission/artifact/decision/experiment/event.
-- Laboratorium kolaboratif human + Aether + agents (lihat
-- docs/aether-lab-audit.md). Semua tabel BARU; tidak menyentuh
-- skema memori lama.

CREATE TABLE IF NOT EXISTS lab_projects (
    id          TEXT PRIMARY KEY,
    dir         TEXT NOT NULL,
    title       TEXT NOT NULL,
    goal        TEXT,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active',   -- active|paused|archived
    phase       TEXT NOT NULL DEFAULT 'IDEA',     -- IDEA..MAINTENANCE
    config      TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_missions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES lab_projects(id),
    title       TEXT NOT NULL,
    objective   TEXT,
    status      TEXT NOT NULL DEFAULT 'PLANNING', -- PLANNING|QUEUED|RUNNING|BLOCKED|WAITING_USER|VERIFYING|COMPLETED|FAILED|CANCELLED
    priority    INTEGER NOT NULL DEFAULT 3,
    owner_agent TEXT,
    plan        TEXT NOT NULL DEFAULT '{}',       -- rencana orchestrator (JSON)
    progress    REAL NOT NULL DEFAULT 0,          -- dihitung deterministik dari tasks
    opencode_session TEXT,
    opencode_dir TEXT,
    opencode_branch TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_tasks (
    id          TEXT PRIMARY KEY,
    mission_id  TEXT NOT NULL REFERENCES lab_missions(id),
    title       TEXT NOT NULL,
    agent       TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|skipped
    output      TEXT,
    tool_trace  TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_artifacts (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES lab_projects(id),
    mission_id  TEXT,
    agent_id    TEXT,
    kind        TEXT NOT NULL,                    -- code|document|report|image|dataset|test|build|config|research
    name        TEXT NOT NULL,
    path        TEXT,
    uri         TEXT,
    summary     TEXT,
    provenance  TEXT NOT NULL DEFAULT '{}',       -- {source, tool, decisions[], experiment}
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_decisions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES lab_projects(id),
    mission_id  TEXT,
    question    TEXT NOT NULL,
    options     TEXT NOT NULL DEFAULT '[]',
    chosen      TEXT,
    reason      TEXT,
    evidence    TEXT NOT NULL DEFAULT '[]',
    decision_maker TEXT NOT NULL DEFAULT 'aether', -- user|aether|user+aether|<agent>
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_experiments (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES lab_projects(id),
    hypothesis  TEXT NOT NULL,
    objective   TEXT,
    variables   TEXT NOT NULL DEFAULT '{}',
    method      TEXT,
    metrics     TEXT NOT NULL DEFAULT '{}',
    runs        TEXT NOT NULL DEFAULT '[]',
    conclusion  TEXT,
    status      TEXT NOT NULL DEFAULT 'draft',    -- draft|running|completed|failed
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (datetime('now')),
    type        TEXT NOT NULL,                    -- vocabulary §33 (project./mission./agent./tool./...)
    project_id  TEXT,
    mission_id  TEXT,
    agent_id    TEXT,
    tool        TEXT,
    payload     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_lab_events_project ON lab_events(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_lab_events_mission ON lab_events(mission_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_lab_missions_project ON lab_missions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_tasks_mission ON lab_tasks(mission_id, updated_at DESC);

-- §23 Time Machine MVP: data model snapshot (non-destruktif).
CREATE TABLE IF NOT EXISTS lab_snapshots (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES lab_projects(id),
    label       TEXT,
    git_commit  TEXT,
    mission_states TEXT NOT NULL DEFAULT '[]',    -- [{id,status,progress}]
    artifact_ids   TEXT NOT NULL DEFAULT '[]',
    decision_ids   TEXT NOT NULL DEFAULT '[]',
    memory_refs    TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
