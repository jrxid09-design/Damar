'use strict';
// Core-owned, persistent agent settings (per selected settings file; production launcher shares one file across
// new Core sessions, while isolated tests may inject a per-run file; Owner credential required to change):
//  - autonomy: 'ask' (card for every consequential call) | 'workspace-auto' (file writes, edits and allowlisted
//    commands inside the workspace / extra directories run without a card; delegation, memory and plugins still ask) |
//    'full-access' (every consequential call runs without a card, still through Core grants, the sandbox and the
//    protected-path rules) | 'read-only' (consequential calls are refused without asking).
//  - extraDirs: additional authorized roots (absolute, existing, never protected, never a drive root; max 8). Agent
//    file tools may read and change files in them (absolute paths); commands still run in the workspace only.
//  - pluginTrust: project plugins (<workspace>/.damar/plugins/<name>/plugin.json + entry file) trusted by digest;
//    a changed plugin is untrusted until the Owner trusts the new digest.
//  - skills: routing 'auto' | 'off' and disabled skill names. Skills are <workspace>/.damar/skills/<name>/SKILL.md and
//    <config dir>/skills/<name>/SKILL.md, with a front matter (name, description, triggers: a, b, c).
// Stored as one JSON document, written atomically (temp + rename). This file contains policy and paths, never secrets.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const PROFILES = ['ask', 'workspace-auto', 'full-access', 'read-only'];
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// presence: Idle Presence / Notch surface config (read by the presence surface via GET /api/r9/presence/settings).
const PRESENCE_DEFAULTS = () => ({ idleToNotchMs: 10000, morphMs: 620, reducedMotion: 'system', notchEnabled: true, notificationPrivacy: 'redacted', display: 'primary', position: 'top-center', voiceEnabled: false, displayName: 'Maronns', salutation: '', onboardingCompleted: false });
const PRESENCE_RULES = {
  idleToNotchMs: v => Number.isSafeInteger(v) && v >= 1000 && v <= 600000,
  morphMs: v => Number.isSafeInteger(v) && v >= 0 && v <= 5000,
  reducedMotion: v => ['system', 'on', 'off'].includes(v),
  notchEnabled: v => typeof v === 'boolean',
  notificationPrivacy: v => ['redacted', 'counts-only', 'hidden'].includes(v),
  display: v => typeof v === 'string' && /^[A-Za-z0-9._:\\-]{1,64}$/.test(v),
  position: v => v === 'top-center',
  voiceEnabled: v => typeof v === 'boolean', // opt-in microphone for the presence surface (Electron 'media' audio only)
  displayName: v => typeof v === 'string' && v.length <= 40 && !/[\x00-\x1f\x7f<>]/.test(v),
  salutation: v => typeof v === 'string' && v.length <= 40 && !/[\x00-\x1f\x7f<>]/.test(v), // how DAMAR addresses the Owner (greeting, alerts); '' = use displayName // greeting name; default is the Owner's name, '' = no name in the greeting
  onboardingCompleted: v => typeof v === 'boolean', // first-run onboarding gate: set by POST /api/r9/presence/onboarding when the first-run flow completes
};
// voice: Voice FX for the local Supertonic TTS output (Owner request 2026-11-26). pitchSemitones is the
// Dashboard pitch slider (spec key voice.pitch_semitones, -12..+12 in 0.5 steps, default 0); style is the
// voice.style selector ('normal' | 'jarvis'). Jarvis is a post-processing preset over the M1 synthesis
// (pitch offset + ring modulation + EQ + short reverb, applied in src/voice/local/voice_fx.py), so it stays
// language-agnostic and Indonesian keeps working. The jarvis* fields are its tuning parameters.
const VOICE_DEFAULTS = () => ({ pitchSemitones: 0, style: 'normal', jarvisPitchSemitones: -2, jarvisRingModHz: 32, jarvisRingModDepth: 0.4, jarvisReverbWet: 0.15, jarvisReverbDecayMs: 110, jarvisEqLowDb: 2, jarvisEqPresenceDb: 3, jarvisEqHighDb: 2 });
const halfStep = (min, max) => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
const numRange = (min, max) => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const intRange = (min, max) => v => Number.isSafeInteger(v) && v >= min && v <= max;
const VOICE_RULES = {
  pitchSemitones: halfStep(-12, 12),
  style: v => ['normal', 'jarvis'].includes(v),
  jarvisPitchSemitones: halfStep(-6, 0),
  jarvisRingModHz: intRange(5, 120),
  jarvisRingModDepth: numRange(0, 0.9),
  jarvisReverbWet: numRange(0, 0.5),
  jarvisReverbDecayMs: intRange(40, 400),
  jarvisEqLowDb: numRange(-6, 6),
  jarvisEqPresenceDb: numRange(-6, 6),
  jarvisEqHighDb: numRange(-6, 6),
};
// cli: DAMAR CLI appearance shared by the CLI Settings Center and Control (null until first set/imported, so the CLI can
// migrate a legacy local profile once). lastSelection: provider/model last accepted by POST /api/r9/provider (recorded by
// that route only; never writable through settings) so a new CLI/Core session can re-apply it through the same route.
const { themes: CLI_THEMES, legacyThemes: CLI_LEGACY_THEMES } = require('../cli/appearance.cjs');
const CLI_DEFAULTS = () => ({ theme: 'damar-ember', animateBanner: true, language: 'en', hudPosition: 'left' });  // language: interface language for the CLI and DAMAR Control (English default; 'id' optional)
const CLI_RULES = {
  theme: v => CLI_THEMES.includes(v) || CLI_LEGACY_THEMES.includes(v),
  animateBanner: v => typeof v === 'boolean',
  language: v => ['id', 'en'].includes(v),
  hudPosition: v => ['left', 'right', 'bottom', 'hidden'].includes(v),
};
const SELECTION = { provider: /^[a-z0-9-]{1,32}$/, model: /^[A-Za-z0-9._:\/@+-]{1,128}$/ };
const validSelection = v => !!v && typeof v === 'object' && SELECTION.provider.test(v.provider || '') && SELECTION.model.test(v.model || '');
// mataDewa: Mata Dewa feeds/areas/refresh/consent (allowlist + validation in src/mata-dewa/feeds.cjs; Owner writes via Control).
const MATA_DEWA = require('../mata-dewa/feeds.cjs');
// cognitive: memory on/off, consent, retention, context budgets and Core's mind block (allowlist + validation in cognitive.cjs).
const COGNITIVE = require('./cognitive.cjs');
// pandawa: per-member models + discussion bounds (allowlist + validation in pandawa-team.cjs).
const TEAM = require('./pandawa-team.cjs');
const DEFAULTS = () => ({ version: 1, revision: 0, autonomy: 'ask', extraDirs: [], pluginTrust: {}, skills: { routing: 'auto', disabled: [] }, presence: PRESENCE_DEFAULTS(), voice: VOICE_DEFAULTS(), cli: null, lastSelection: null, updatedAt: null });
const fail = (status, error) => Object.assign(Error(error), { status });
const lower = p => path.resolve(p).toLowerCase();
const within = (p, root) => lower(p) === lower(root) || lower(p).startsWith(lower(root) + path.sep);

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text); if (!m) return null;
  const meta = {}; for (const line of m[1].split(/\r?\n/)) { const kv = /^([a-z]+):\s*(.*)$/i.exec(line.trim()); if (kv) meta[kv[1].toLowerCase()] = kv[2].trim(); }
  return { meta, body: m[2] };
}

function createCoreSettings({ file, isProtected, skillsDir = path.join(path.dirname(file), 'skills'), onVoiceSettings = null }) {
  let state = DEFAULTS();
  let loadedExisting = false, loadedPresenceHasFlag = false;
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (v && v.version === 1) { loadedExisting = true; loadedPresenceHasFlag = !!v.presence && typeof v.presence === 'object' && Object.hasOwn(v.presence, 'onboardingCompleted'); state = { ...DEFAULTS(), ...v, skills: { ...DEFAULTS().skills, ...(v.skills || {}) }, presence: { ...PRESENCE_DEFAULTS(), ...Object.fromEntries(Object.entries(v.presence || {}).filter(([k, x]) => PRESENCE_RULES[k]?.(x))) }, voice: { ...VOICE_DEFAULTS(), ...Object.fromEntries(Object.entries(v.voice || {}).filter(([k, x]) => VOICE_RULES[k]?.(x))) },
    cli: v.cli && typeof v.cli === 'object' ? { ...CLI_DEFAULTS(), ...Object.fromEntries(Object.entries(v.cli).filter(([k, x]) => CLI_RULES[k]?.(x))) } : null, lastSelection: validSelection(v.lastSelection) ? { provider: v.lastSelection.provider, model: v.lastSelection.model } : null }; } } catch {}
  // First-run gate: a settings file that predates the flag (no onboardingCompleted key) belongs to an existing
  // install, so its onboarding must never fire; only a genuinely fresh install (no readable file -> DEFAULTS)
  // starts uncompleted. Once any save happens the key is serialized and this inference never runs again.
  if (loadedExisting && !loadedPresenceHasFlag) state.presence.onboardingCompleted = true;
  state.mataDewa = MATA_DEWA.sanitizeSettings(state.mataDewa);
  state.cognitive = COGNITIVE.sanitize(state.cognitive);
  state.pandawa = TEAM.sanitize(state.pandawa);
  const save = () => { state.updatedAt = new Date().toISOString(); state.revision = (Number.isSafeInteger(state.revision) ? state.revision : 0) + 1; fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file); };

  function validDir(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.length > 260 || p.includes('\0')) throw fail(400, 'EXTRA_DIR_INVALID');
    let real; try { real = fs.realpathSync.native(p); } catch { throw fail(400, 'EXTRA_DIR_NOT_FOUND'); }
    if (!fs.statSync(real).isDirectory()) throw fail(400, 'EXTRA_DIR_NOT_A_FOLDER');
    if (path.dirname(real) === real) throw fail(400, 'EXTRA_DIR_DRIVE_ROOT');
    if (isProtected(real)) throw fail(403, 'EXTRA_DIR_PROTECTED');
    return real;
  }

  // Project plugins of a workspace with a digest over the complete, bounded plugin tree.
  // Hashing dependencies as well as the declared entry prevents an unchanged manifest/entry
  // from silently loading a tampered adjacent module at runtime.
  function pluginFiles(base) {
    const files = []; let total = 0;
    const walk = dir => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name), st = fs.lstatSync(full);
        if (st.isSymbolicLink()) throw Error('LINK_REFUSED');
        if (item.isDirectory()) walk(full);
        else if (item.isFile()) {
          total += st.size; if (total > 2 * 1024 * 1024 || files.length >= 64) throw Error('PLUGIN_TOO_LARGE');
          files.push({ rel: path.relative(base, full), bytes: fs.readFileSync(full) });
        }
      }
    };
    walk(base); files.sort((a, b) => a.rel.localeCompare(b.rel)); return files;
  }
  function pluginDigest(files) {
    const h = crypto.createHash('sha256');
    for (const f of files) h.update(f.rel).update('\0').update(f.bytes).update('\0');
    return h.digest('hex');
  }
  function plugins(root) {
    const dir = path.join(root, '.damar', 'plugins'), list = [];
    let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME.test(e.name)).map(e => e.name).slice(0, 32); } catch {}
    for (const name of names) {
      const base = path.join(dir, name);
      try {
        const files = pluginFiles(base), manifestPath = path.join(base, 'plugin.json'), raw = fs.readFileSync(manifestPath), m = JSON.parse(raw);
        const command = m?.tool?.command, entry = m?.tool?.entry;
        if (!['python', 'node'].includes(command) || typeof entry !== 'string' || !/^[A-Za-z0-9_.-]{1,64}\.(py|c?js|mjs)$/.test(entry)) throw Error('MANIFEST_INVALID');
        const entryPath = path.join(base, entry);
        const digest = pluginDigest(files);
        const key = crypto.createHash('sha256').update(lower(base)).digest('hex').slice(0, 24);
        const rec = state.pluginTrust[key];
        list.push({ key, name, description: String(m.description || '').slice(0, 200), command, entry, entryPath, digest,
          trusted: !!rec?.trusted && rec.digest === digest, changedSinceTrust: !!rec?.trusted && rec.digest !== digest, root });
      } catch (error) { list.push({ key: null, name, error: String(error.message).slice(0, 60), trusted: false, root }); }
    }
    return list;
  }

  // Skills available for a workspace (workspace first, then profile), with their enabled state.
  function skills(root) {
    const out = [], seen = new Set();
    for (const [dir, source] of [[root && path.join(root, '.damar', 'skills'), 'workspace'], [skillsDir, 'profile']]) {
      if (!dir) continue;
      let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME.test(e.name)).map(e => e.name).slice(0, 64); } catch {}
      for (const name of names) {
        if (seen.has(name)) continue;
        try {
          const fm = frontMatter(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8').slice(0, 16384)); if (!fm) continue;
          const triggers = String(fm.meta.triggers || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s.length >= 3).slice(0, 12);
          seen.add(name);
          out.push({ name, source, description: String(fm.meta.description || '').slice(0, 200), triggers, body: fm.body.trim().slice(0, 4000), enabled: !state.skills.disabled.includes(name) });
        } catch {}
      }
    }
    return out;
  }

  const api = {
    PROFILES,
    view: () => ({ autonomy: state.autonomy, extraDirs: [...state.extraDirs], skills: { routing: state.skills.routing, disabled: [...state.skills.disabled] }, presence: { ...state.presence }, voice: { ...state.voice }, cli: state.cli ? { ...state.cli } : null, lastSelection: state.lastSelection ? { ...state.lastSelection } : null, mataDewa: MATA_DEWA.sanitizeSettings(state.mataDewa), cognitive: { ...state.cognitive }, pandawa: TEAM.sanitize(state.pandawa), revision: state.revision, updatedAt: state.updatedAt }),
    cognitive: () => ({ ...state.cognitive }),
    pandawa: () => TEAM.sanitize(state.pandawa),
    cli: () => ({ cli: state.cli ? { ...state.cli } : null, defaults: CLI_DEFAULTS(), lastSelection: state.lastSelection ? { ...state.lastSelection } : null, revision: state.revision, updatedAt: state.updatedAt }),
    // Called by POST /api/r9/provider after Core accepted a selection (the selection itself stays in the registry).
    recordSelection(provider, model) { if (!validSelection({ provider, model })) return; if (state.lastSelection?.provider === provider && state.lastSelection?.model === model) return; state.lastSelection = { provider, model }; save(); },
    presence: () => ({ presence: { ...state.presence }, revision: state.revision, updatedAt: state.updatedAt }),
    voice: () => ({ voice: { ...state.voice }, revision: state.revision, updatedAt: state.updatedAt }),
    mataDewa: () => ({ mataDewa: MATA_DEWA.sanitizeSettings(state.mataDewa), revision: state.revision, updatedAt: state.updatedAt }),
    autonomy: () => state.autonomy,
    extraDirs: () => state.extraDirs.filter(d => { try { return fs.statSync(d).isDirectory() && !isProtected(d); } catch { return false; } }),
    // Owner update. Every field is validated before anything is stored.
    update(input) {
      const next = JSON.parse(JSON.stringify(state));
      if (input.autonomy !== undefined) { if (!PROFILES.includes(input.autonomy)) throw fail(400, 'AUTONOMY_INVALID'); next.autonomy = input.autonomy; }
      if (input.extraDirs !== undefined) {
        if (!Array.isArray(input.extraDirs) || input.extraDirs.length > 8) throw fail(400, 'EXTRA_DIRS_INVALID');
        next.extraDirs = [...new Map(input.extraDirs.map(validDir).map(d => [lower(d), d])).values()];
      }
      if (input.skills !== undefined) {
        const s = input.skills || {};
        if (s.routing !== undefined && !['auto', 'off'].includes(s.routing)) throw fail(400, 'SKILL_ROUTING_INVALID');
        if (s.disabled !== undefined && (!Array.isArray(s.disabled) || s.disabled.length > 64 || s.disabled.some(n => !NAME.test(n)))) throw fail(400, 'SKILLS_INVALID');
        next.skills = { routing: s.routing ?? next.skills.routing, disabled: s.disabled ? [...new Set(s.disabled)] : next.skills.disabled };
      }
      if (input.presence !== undefined) {
        const p = input.presence;
        if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !PRESENCE_RULES[k] || !PRESENCE_RULES[k](p[k]))) throw fail(400, 'PRESENCE_SETTINGS_INVALID');
        next.presence = { ...next.presence, ...p };
      }
      if (input.voice !== undefined) {
        const vc = input.voice;
        if (!vc || typeof vc !== 'object' || Array.isArray(vc) || Object.keys(vc).some(k => !VOICE_RULES[k] || !VOICE_RULES[k](vc[k]))) throw fail(400, 'VOICE_SETTINGS_INVALID');
        next.voice = { ...next.voice, ...vc };
      }
      if (input.cli !== undefined) {
        const c = input.cli;
        if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !CLI_RULES[k] || !CLI_RULES[k](c[k]))) throw fail(400, 'CLI_SETTINGS_INVALID');
        next.cli = { ...(next.cli || CLI_DEFAULTS()), ...c };
      }
      if (input.mataDewa !== undefined) next.mataDewa = MATA_DEWA.mergeSettings(next.mataDewa, input.mataDewa);
      if (input.pandawa !== undefined) next.pandawa = TEAM.merge(next.pandawa, input.pandawa);
      if (input.cognitive !== undefined) next.cognitive = { ...next.cognitive, ...COGNITIVE.validate(input.cognitive) };
      state = next; save();
      // Voice FX bridge: notify the host after a voice save so it can stage the
      // section into the voice runtime's configs/voice.json (voice-runtime-config.cjs).
      // Best-effort: the settings saved above stay the source of truth even if the
      // copy fails (the host logs the failure and re-syncs at startup).
      if (input.voice !== undefined && typeof onVoiceSettings === 'function') { try { onVoiceSettings({ ...state.voice }); } catch {} }
      return api.view();
    },
    plugins,
    // Return the exact bounded tree only after a fresh digest/trust check. Callers stage these
    // bytes into a separate read-only AppContainer root before execution.
    pluginSnapshot(root, key) {
      const p = plugins(root).find(x => x.key === key);
      if (!p) throw fail(404, 'PLUGIN_NOT_FOUND');
      if (!p.trusted) throw fail(403, p.changedSinceTrust ? 'PLUGIN_TAMPERED_OR_CHANGED' : 'PLUGIN_NOT_TRUSTED');
      const files = pluginFiles(path.join(root, '.damar', 'plugins', p.name));
      if (pluginDigest(files) !== p.digest) throw fail(409, 'PLUGIN_CHANGED_DURING_READ');
      return { plugin: p, files };
    },
    // Owner trusts (pins the current digest) or untrusts a project plugin of the workspace.
    trustPlugin(root, key, trusted) {
      const p = plugins(root).find(x => x.key && x.key === key); if (!p) throw fail(404, 'PLUGIN_NOT_FOUND');
      if (trusted) state.pluginTrust[key] = { trusted: true, digest: p.digest, name: p.name, at: new Date().toISOString() }; else delete state.pluginTrust[key];
      save(); return plugins(root).find(x => x.key === key);
    },
    skills,
    // Routing for a turn: enabled skills whose trigger words appear in the request (max 2), unless routing is off.
    route(root, text) {
      if (state.skills.routing !== 'auto') return [];
      const t = String(text || '').toLowerCase();
      return skills(root).filter(s => s.enabled && s.triggers.some(w => t.includes(w))).slice(0, 2);
    },
    // Which root holds an absolute path: the workspace or an authorized extra directory (null when neither).
    rootFor: (workspace, abs) => [workspace, ...api.extraDirs()].find(r => within(abs, r)) || null,
  };
  return api;
}
module.exports = { createCoreSettings, PROFILES, PRESENCE_DEFAULTS, CLI_DEFAULTS, VOICE_DEFAULTS };
