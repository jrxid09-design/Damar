-- AUTHORITY V1 — delegable-budget reservation ledger.
--
-- Model reservasi (anti sibling-amplification): setiap delegasi
-- mereservasi kapasitas dari sisa budget delegable parent secara ATOMIK.
-- Total budget anak-anak satu parent tidak pernah bisa melebihi
-- maxExecutions parent. Ledger persisten => restart-safe.

CREATE TABLE IF NOT EXISTS capability_delegations (
    child_capability_id  TEXT PRIMARY KEY,
    parent_capability_id TEXT NOT NULL,
    amount               INTEGER NOT NULL,
    at                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capability_delegations_parent
    ON capability_delegations (parent_capability_id);
