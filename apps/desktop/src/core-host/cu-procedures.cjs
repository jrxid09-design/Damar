'use strict';
// PROCEDURAL MEMORY for Computer-Use (blueprint section 9, PROCEDURAL class).
//
// Frontier computer-use agents are stateless per session: every task is
// re-planned from zero. Damar instead stores each VERIFIED successful task as
// a reusable procedure for the same app, and replays it deterministically
// (the REFLEX layer) without calling the model at all. A procedure is a
// template, not a transcript: the literal goal values (typed text, file
// paths) are stored as {{slots}} and filled at replay time.
//
// Procedures never carry authority: replay goes through the exact same
// authorized tool runner as the original task, so every step is re-authorized
// and re-verified by the broker on each replay.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

function goalSignature(goal) {
  return String(goal || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function slotify(text, slots) {
  let out = String(text);
  for (const [name, value] of Object.entries(slots || {})) {
    if (typeof value === 'string' && value) out = out.split(value).join('{{' + name + '}}');
  }
  return out;
}

function fillSlots(value, slots) {
  if (typeof value === 'string') {
    let out = value;
    for (const [name, replacement] of Object.entries(slots || {})) {
      out = out.split('{{' + name + '}}').join(String(replacement));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(v => fillSlots(v, slots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillSlots(v, slots)]));
  }
  return value;
}

function digestOf(proc) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ app: proc.app, goal: proc.goalSignature, steps: proc.steps, verify: proc.verify }))
    .digest('hex').slice(0, 24);
}

function createProcedureStore({ file } = {}) {
  if (!file || !path.isAbsolute(file)) throw Error('PROCEDURE_STORE_PATH_INVALID');
  let records = [];
  function load() {
    try { records = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(records)) records = []; }
    catch { records = []; }
    return records;
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
  }
  load();
  return {
    file,
    list() { return records.map(r => ({ ...r })); },
    record({ app, goal, steps, verify = null, source = 'model' } = {}) {
      if (!app || !goal || !Array.isArray(steps) || !steps.length) throw Error('PROCEDURE_INVALID');
      const proc = {
        id: 'proc-' + crypto.randomUUID().slice(0, 8),
        app: String(app), goal: String(goal), goalSignature: goalSignature(goal),
        steps, verify, source,
        createdAt: new Date().toISOString(), uses: 0, successes: 0,
      };
      proc.digest = digestOf(proc);
      records.push(proc); save();
      return { ...proc };
    },
    find(app, goal) {
      const sig = goalSignature(goal);
      const hit = records.find(r => r.app === app && r.goalSignature === sig);
      return hit ? { ...hit } : null;
    },
    noteReplay(id, ok) {
      const rec = records.find(r => r.id === id);
      if (!rec) return false;
      rec.uses += 1; if (ok) rec.successes += 1;
      rec.lastReplayAt = new Date().toISOString();
      save();
      return true;
    },
  };
}

// Reflex replay: run the stored steps through the caller's authorized tool
// runner, in order, stopping at the first failed step. No model is involved;
// the caller proves that by counting its own model calls around this function.
async function replayProcedure(proc, slots, runTool) {
  const results = [];
  const steps = fillSlots(proc.steps, slots);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let parsed = null;
    try {
      const raw = await runTool(step.tool, step.args);
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      results.push({ step: i, tool: step.tool, ok: false, error: String(e?.message || e).slice(0, 160) });
      return { ok: false, failedStep: i, results };
    }
    const ok = parsed && parsed.ok !== false;
    results.push({ step: i, tool: step.tool, ok });
    if (!ok) return { ok: false, failedStep: i, results };
  }
  return { ok: true, results };
}

module.exports = { createProcedureStore, replayProcedure, goalSignature, slotify, fillSlots };
