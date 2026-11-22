'use strict';
// Host-side cognitive layer for agent turns (no Core snapshot file edited).
//  - settings: the Owner-controlled `cognitive.*` keys (allowlist + validation, read by core-settings.cjs).
//  - contextFor(): builds one turn's model context from project memory (relevance-ranked, bounded, wrapped as data),
//    routed skills and the session's replayed history (bounded by turns AND characters), and returns a trace of what
//    was included (emitted to the turn stream as a `cognitive` event, so every turn has a receipt of its context).
//  - installMind(): wraps Core's consciousness singleton so its global "state of mind" (attention, last reading of the
//    user) never carries one CLI session's content into another session's prompt, and so the Owner can turn it off.
//  - hasCredential(): refuses recognisable credentials in persistent memory (same finite approach as the cognitive
//    runtime's privacy guard: labelled/prefixed secrets only, never a universal secret detector).
const DEFAULTS = () => ({ memoryEnabled: true, memoryConsent: 'always', memoryRetentionDays: 0, memoryContextChars: 6000, historyTurns: 20, historyChars: 48000, mind: 'on' });
const int = (lo, hi) => v => Number.isSafeInteger(v) && v >= lo && v <= hi;
const RULES = {
  memoryEnabled: v => typeof v === 'boolean',          // project memory given to the model and the memory tool offered
  memoryConsent: v => ['always', 'autonomy'].includes(v), // 'always': saving a memory note always asks, whatever the autonomy profile
  memoryRetentionDays: int(0, 3650),                     // 0 = keep until forgotten; otherwise older notes are deleted
  memoryContextChars: int(500, 20000),                   // project memory budget per turn
  historyTurns: int(0, 50),                              // completed turns of the session replayed to the model
  historyChars: int(2000, 400000),                       // replayed history budget per turn (oldest dropped first)
  mind: v => ['on', 'off'].includes(v),                  // Core's affect/attention block in the prompt
};
const sanitize = v => ({ ...DEFAULTS(), ...Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([k, x]) => RULES[k]?.(x))) });
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !RULES[k] || !RULES[k](input[k]))) throw Object.assign(Error('COGNITIVE_SETTINGS_INVALID'), { status: 400 });
  return input;
}

const CREDENTIAL = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}|(?<![A-Za-z0-9])(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})|\b(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S{8,}/i;
const hasCredential = text => CREDENTIAL.test(String(text || ''));

const MSG_CHARS = 16000; // one replayed message never exceeds this (a long answer is cut, the newest text is kept)
// The session history replayed to the model: the newest `turns` turns that fit `chars`, oldest dropped first, always
// starting on a user message.
function boundHistory(history, { turns, chars }) {
  const rows = (turns > 0 ? history.slice(-turns * 2) : []).map(m => m.content.length > MSG_CHARS ? { ...m, content: '[…] ' + m.content.slice(-MSG_CHARS) } : m);
  let total = 0, i = rows.length;
  while (i > 0 && total + rows[i - 1].content.length <= chars) total += rows[--i].content.length;
  while (i < rows.length && rows[i].role !== 'user') total -= rows[i++].content.length;
  return { rows: rows.slice(i), chars: total, dropped: history.length - (rows.length - i) };
}

function contextFor({ settings, projectMemory, root, text, history = [], skills = [] }) {
  const c = sanitize(settings?.cognitive?.());
  const memory = !c.memoryEnabled || !projectMemory ? null : projectMemory.select ? projectMemory.select(root, text, { maxChars: c.memoryContextChars, retentionDays: c.memoryRetentionDays })
    : { text: projectMemory.context(root), used: null, of: null };
  const memoryNote = memory?.text || null;
  const skillNote = skills.length ? skills.map(s => `Skill ${s.name}: ${s.body}`).join('\n\n').slice(0, 8000) : null;
  const h = boundHistory(history, { turns: c.historyTurns, chars: c.historyChars });
  const messages = [...(memoryNote ? [{ role: 'system', content: memoryNote }] : []), ...(skillNote ? [{ role: 'system', content: skillNote }] : []), ...h.rows, { role: 'user', content: text }];
  return { messages, trace: { type: 'cognitive', memory: c.memoryEnabled ? { notes: memory?.used ?? 0, of: memory?.of ?? 0, chars: memoryNote?.length ?? 0 } : 'off',
    skills: skills.map(s => s.name), history: { messages: h.rows.length, chars: h.chars, dropped: h.dropped }, mind: c.mind } };
}

// Core's consciousness module is one process-wide singleton. A new CLI session (sessionOf() changes) starts with an
// empty attention stage and no reading of the previous user; with mind 'off' it neither perceives nor injects.
function installMind({ mind, settings, sessionOf }) {
  if (!mind || mind.__damarCognitive || typeof mind.stateOfMind !== 'function' || typeof mind.perceiveUser !== 'function') return false;
  const perceive = mind.perceiveUser.bind(mind), state = mind.stateOfMind.bind(mind);
  let last;
  const on = () => sanitize(settings?.cognitive?.()).mind === 'on';
  const scope = () => {
    const s = sessionOf() ?? 'pandawa-or-core';
    if (s !== last) { last = s; try { mind.workspace?.bersihkan?.(); } catch {} mind.bacaanTerakhir = null; }
  };
  mind.perceiveUser = (...a) => { if (!on()) return null; scope(); return perceive(...a); };
  mind.stateOfMind = (...a) => { if (!on()) return null; scope(); return state(...a); };
  mind.__damarCognitive = true;
  return true;
}

// Scope of host work that runs outside an agent turn (a Pandawa run): { root, route }. Read by the memory bridge (root)
// and by the provider router's per-member route override (route).
const runScope = new (require('node:async_hooks').AsyncLocalStorage)();

// Language: Core's own prompt text is Indonesian; the reply follows the user's message, English when unclear
// (Indonesian when the Owner's interface language is 'id').
// ponytail: stop-word heuristic for the two product languages only (English, Indonesian); others fall back to the model.
const ID_WORDS = new Set('yang dan untuk dengan tidak ini itu apa saya kamu anda bagaimana adalah akan dari pada sudah belum bisa tolong buat jelaskan'.split(' '));
const EN_WORDS = new Set('the and for with not this that what you your how is are will from have has can please make explain of to'.split(' '));
function detectLanguage(text) {
  const w = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  const id = w.filter(x => ID_WORDS.has(x)).length, en = w.filter(x => EN_WORDS.has(x)).length;
  return id > en ? 'Indonesian' : en > id ? 'English' : null;
}
function languageDirective(settings) {
  const fallback = settings?.cli?.()?.cli?.language === 'id' ? 'Indonesian' : 'English';
  // A Pandawa run's user message is Core's Indonesian role wrapper around the Owner's task: use the task's language.
  const task = runScope.getStore()?.lang;
  if (task) return `Language: reply in ${task} (the language of the Owner's task), whatever language this prompt, the role text or any context block is written in.`;
  return `Language: always reply in the language of the user's latest message, whatever language this prompt or any context block is written in. If the language is unclear, reply in ${fallback}.`;
}

// Core's assemble() keeps its system prompt (persona, safety authority, tool guidance) only when the caller sends no
// system message; host context (project memory, routed skills) is therefore appended to Core's system message instead
// of replacing it, followed by the language directive. Applies to agent turns and Pandawa runs alike.
function installAssemble({ aiRuntime, settings }) {
  if (!aiRuntime || aiRuntime.assemble.__damarCognitive) return false;
  const original = aiRuntime.assemble.bind(aiRuntime);
  const wrapped = async (args = {}) => {
    const all = Array.isArray(args.messages) ? args.messages : [];
    const extra = all.filter(m => m.role === 'system' && typeof m.content === 'string').map(m => m.content);
    const r = await original({ ...args, messages: all.filter(m => m.role !== 'system') });
    const add = [...extra, languageDirective(settings)].join('\n\n');
    const i = r.messages.findIndex(m => m.role === 'system');
    const messages = i < 0 ? [{ role: 'system', content: add }, ...r.messages] : r.messages.map((m, j) => (j === i ? { ...m, content: `${m.content}\n\n${add}` } : m));
    return { ...r, messages };
  };
  wrapped.__damarCognitive = true; aiRuntime.assemble = wrapped;
  return true;
}

// One memory system: Core's MemoryService (an always-empty SQLite store in the R product path) reads the profile project
// memory instead. Outside a Pandawa run scope it returns nothing (an agent turn already carries project memory); inside a Pandawa
// run it returns the run's workspace notes as the same fenced data block.
function installMemoryBridge({ memoryService, projectMemory, settings }) {
  if (!memoryService || memoryService.__damarCognitive) return false;
  const empty = { text: '', memoryCount: 0, documentCount: 0, strategies: [] };
  memoryService.buildContext = async (query, { maxChars = 2400 } = {}) => {
    const c = sanitize(settings?.cognitive?.()), root = runScope.getStore()?.root;
    if (!root || !c.memoryEnabled) return empty;   // a turn (no run scope) already carries project memory itself
    const s = projectMemory.select(root, String(query || ''), { maxChars: Math.min(maxChars, c.memoryContextChars), retentionDays: c.memoryRetentionDays });
    return s.text ? { text: s.text, memoryCount: s.used, documentCount: 0, strategies: ['project-memory'] } : empty;
  };
  memoryService.__damarCognitive = true;
  return true;
}

module.exports = { detectLanguage, DEFAULTS, RULES, sanitize, validate, contextFor, boundHistory, installMind, hasCredential, runScope, languageDirective, installAssemble, installMemoryBridge };
