"use strict";

/**
 * WAVE 5 LANE 4 — DSC-R1-005/DSC-R1-004 logical-history seam tests
 * (ChannelManager dsc:* keying against the REAL SessionStore contract).
 *
 * The ChannelManager module now loads without the sqlite3 native module
 * (lazy-load); the REAL SessionStore requires sqlite3 at first open().  This
 * suite injects a contract-compatible store through the EXISTING ChannelManager
 * constructor seam — production ChannelManager logic, not a fake Manager map.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { ChannelManager } = require("../../src/channels/channelManager");

/** Contract-compatible in-memory SessionStore (same seam as the real store). */
function makeInjectedStore() {
  const rows = new Map();
  return {
    async open() {},
    async load(key) {
      const row = rows.get(key);
      if (!row) return [];
      try { return JSON.parse(row.payload); } catch { return []; }
    },
    async append(key, turn, meta = {}) {
      const turns = await this.load(key);
      turns.push({ role: turn.role, content: turn.content });
      while (turns.length > 20) turns.shift();
      rows.set(key, {
        channel: meta.channel ?? "unknown",
        kind: meta.kind ?? "dm",
        peer: String(meta.peer ?? ""),
        updated_at: Date.now(),
        turns: turns.length,
        payload: JSON.stringify(turns)
      });
      return turns;
    },
    async clear(key) { rows.delete(key); },
    async list() { return [...rows.values()]; },
    _rows: rows
  };
}

test("SEAM: ChannelManager logical keys validate the dsc_* shape", () => {
  const cm = new ChannelManager(makeInjectedStore());
  assert.equal(cm.continuityKey("dsc_abc123"), "dsc:dsc_abc123");
  for (const forged of ["ses_forged", "dsc_", "DSC_upper", "dsc_" + "x".repeat(200), "", null, 42]) {
    assert.throws(() => cm.continuityKey(forged), TypeError, JSON.stringify(String(forged)));
  }
});

test("SEAM: continuity remember/read route through the existing store append/load", async () => {
  const store = makeInjectedStore();
  const cm = new ChannelManager(store);
  await cm.continuityRemember("dsc_a1", { role: "user", content: "hi" }, { channel: "telegram" });
  await cm.continuityRemember("dsc_a1", { role: "assistant", content: "hello" }, { channel: "telegram" });
  const history = await cm.continuityHistory("dsc_a1");
  assert.equal(history.length, 2);
  assert.equal(history[0].content, "hi");
  // The stored key is the dsc:* logical key, distinct from legacy channel: keys.
  assert.deepEqual([...store._rows.keys()], ["dsc:dsc_a1"]);
  const row = store._rows.get("dsc:dsc_a1");
  assert.equal(row.channel, "telegram");
  assert.equal(row.kind, "logical");
});

test("SEAM: continuity forget clears only the logical key (no global wipe)", async () => {
  const store = makeInjectedStore();
  const cm = new ChannelManager(store);
  await cm.remember("telegram", "123", { role: "user", content: "legacy" }, "dm");
  await cm.continuityRemember("dsc_b2", { role: "user", content: "logical" }, { channel: "telegram" });
  await cm.continuityForget("dsc_b2");
  assert.equal((await cm.continuityHistory("dsc_b2")).length, 0);
  const legacy = await cm.history("telegram", "123", "dm");
  assert.equal(legacy.length, 1, "legacy per-channel history is untouched");
});
