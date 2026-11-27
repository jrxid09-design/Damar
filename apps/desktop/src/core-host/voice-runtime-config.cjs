'use strict';
// Bridge: Core settings `voice` -> the voice runtime's configs/voice.json.
//
// The Control Dashboard owns voice FX through Core settings (core-settings.cjs,
// written via POST /api/r9/settings). The voice runtime (src/voice/config.js)
// is an in-process engine of the canonical runtime: it has no Core session and
// no settings read route of its own (unlike the Presence surface, a separate
// process that polls GET /api/r9/presence/settings). Its config source is the
// JsonStore file <canonical root>/configs/voice.json — the same directory this
// host already stages configs/providers.json into for the runtime. So the host
// copies the voice section there: once at startup and on every voice save
// (core-settings `onVoiceSettings` hook). The runtime notices the rewrite via
// the file mtime and re-reads it without a restart (src/voice/config.js).
//
// Keys, defaults and ranges are identical on both sides by design; values
// arriving here were already validated by core-settings (VOICE_RULES), so
// this module only picks the known keys, merges them into the file's
// `runtime` section (other sections and runtime keys are preserved) and
// writes atomically (temp + rename, like core-settings.save / JsonStore).
const fs = require('node:fs'), path = require('node:path');

const VOICE_RUNTIME_KEYS = Object.freeze(['pitchSemitones', 'style', 'jarvisPitchSemitones', 'jarvisRingModHz', 'jarvisRingModDepth', 'jarvisReverbWet', 'jarvisReverbDecayMs', 'jarvisEqLowDb', 'jarvisEqPresenceDb', 'jarvisEqHighDb']);

function pickVoiceRuntime(voice) {
  const out = {};
  if (voice && typeof voice === 'object' && !Array.isArray(voice)) {
    for (const k of VOICE_RUNTIME_KEYS) if (voice[k] !== undefined) out[k] = voice[k];
  }
  return out;
}

function writeVoiceRuntimeConfig(file, voice) {
  const picked = pickVoiceRuntime(voice);
  let existing = {};
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) existing = v; } catch {}
  const prevRuntime = existing.runtime && typeof existing.runtime === 'object' && !Array.isArray(existing.runtime) ? existing.runtime : {};
  const next = { ...existing, runtime: { ...prevRuntime, ...picked }, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return picked;
}

module.exports = { writeVoiceRuntimeConfig, pickVoiceRuntime, VOICE_RUNTIME_KEYS };
