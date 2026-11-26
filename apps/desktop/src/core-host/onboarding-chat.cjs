'use strict';
// First-run onboarding interview (branch A): a bounded, tool-free chat completion through Core's provider
// router, used only while presence.onboardingCompleted is false. The system prompt is fixed here in Core -
// the Presence renderer sends only user/assistant turns, never a system prompt, a tool or a model choice.
// The model conducts the interview; it never writes config. It ends by emitting a DAMAR_SETUP_JSON line,
// which the Presence form shows for Owner confirmation; only the confirmed form values are saved
// (POST /api/r9/presence/onboarding composes the settings update and sets the completion flag).
//
// V2 addition - capability-first model probing (spec ONBOARDING-V2-SPEC, owner 2026-11-26 18:23): right
// after step 0 connects an endpoint, Core probes every catalog model with three tiny live checks
// (responds at all, tool-calling, streaming) plus latency, then picks the pair Damar runs on:
//   brain  = the most capable model whose latency is acceptable (NOT the lowest latency, NOT the first
//            catalog entry); token-heavy models (Astra class) are never the silent default - they are
//            only chosen when nothing else answers, and that fact is reported so the UI can disclose it.
//   reflex = the fastest responding model, for light/fast duties.
// The choice is disclosed to the user in one line by the Presence flow and can be overridden any time in
// the Control Dashboard (centralized config). Probing spends a handful of tokens per model, metered
// through the router with source 'first-run-onboarding-probe'.
const SYSTEM_PROMPT = [
  'Kamu adalah Damar, asisten AI pribadi yang berjalan di komputer pengguna sendiri. Ini adalah perkenalan pertama setelah instalasi selesai. Tugasmu HANYA melakukan wawancara perkenalan singkat untuk pengaturan awal.',
  'Aturan:',
  '- Berbicaralah dalam Bahasa Indonesia yang hangat dan singkat, kecuali pengguna memakai bahasa lain.',
  '- Perkenalkan dirimu dalam 2-3 kalimat: kamu Damar, asisten pribadi di komputer ini; kamu membantu lewat percakapan dan perintah; pengaturan dapat diubah kapan pun di Control Dashboard.',
  '- Ajukan pertanyaan SATU per satu dan tunggu jawaban sebelum lanjut: (1) nama pengguna; (2) panggilan yang ia sukai untuk disapa Damar (sapaan); (3) bahasa utama: Bahasa Indonesia atau English; (4) apakah percakapan suara (mikrofon) diaktifkan.',
  '- Setiap pertanyaan boleh dilewati; jika dilewati, lanjut ke pertanyaan berikutnya tanpa memaksa.',
  '- Jangan menjanjikan kemampuan di luar asisten pribadi pada umumnya. Jangan meminta data sensitif (kata sandi, nomor telepon, alamat, data keuangan).',
  '- Setelah keempat jawaban terkumpul (atau dilewati), ucapkan penutup singkat, lalu tulis satu baris terakhir persis seperti format ini, tanpa teks lain setelahnya:',
  'DAMAR_SETUP_JSON: {"displayName":"<nama>","salutation":"<sapaan>","language":"id","voiceEnabled":false}',
  'Isi nilai dari jawaban pengguna; string kosong bila dilewati; language "id" atau "en"; voiceEnabled true hanya bila pengguna setuju mengaktifkan percakapan suara.',
].join('\n');

const MAX_MESSAGES = 16, MAX_CHARS = 2000;
const MAX_PROBE_MODELS = 8, PROBE_STREAM_FIRST_CHUNK_MS = 5000;
const fail = (status, error) => Object.assign(Error(error), { status });

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MESSAGES) throw fail(400, 'ONBOARDING_MESSAGES_INVALID');
  return input.map(m => {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_CHARS) throw fail(400, 'ONBOARDING_MESSAGES_INVALID');
    return { role: m.role, content: m.content };
  });
}

// Token-heavy class (owner rule 2026-11-26 11:25: the Astra class is a ceiling/reference, never a silent
// default). Matched on the model id so any future id of the same class is covered.
const TOKEN_HEAVY_RE = /astra/i;
// Capability tiers from the model id - a deterministic heuristic, deliberately coarse: light/fast ids
// (mini/nano/haiku/flash/lite/small/tiny/tiny parameter counts) are tier 1, flagship ids are tier 3,
// everything else tier 2. Live probe results (tools/streaming/latency) refine within a tier.
function capabilityTier(model) {
  const id = String(model || '').toLowerCase();
  if (/(mini|nano|haiku|flash|lite|small|tiny|[-_](3b|7b|8b)\b)/.test(id)) return 1;
  if (/(opus|ultra|sonnet|\bo3\b|\bo4\b|gpt-5|[-_\b]pro\b|[-_\b]max\b|large|70b|405b)/.test(id)) return 3;
  return 2;
}
// Pure selection policy (unit-tested): probes = [{ model, ok, latencyMs, streaming, tools }].
// brain: highest capability tier among models answering within the acceptable-latency window
// (<= max(2.5x fastest, fastest + 1500 ms)); ties break on capability evidence (tools+streaming),
// then latency. Token-heavy models are excluded from brain unless they are the only ones answering
// (then brainTokenHeavy reports it so the choice is disclosed, never silent).
// reflex: the fastest answering model overall.
function selectModels(probes) {
  const ok = (Array.isArray(probes) ? probes : []).filter(p => p && p.ok && typeof p.model === 'string');
  if (!ok.length) return null;
  const lat = p => (Number.isFinite(p.latencyMs) ? p.latencyMs : Infinity);
  const fastest = Math.min(...ok.map(lat));
  const windowMs = Math.max(fastest * 2.5, fastest + 1500);
  const caps = p => (p.tools ? 1 : 0) + (p.streaming ? 1 : 0);
  const byBrain = (x, y) => capabilityTier(y.model) - capabilityTier(x.model) || caps(y) - caps(x) || lat(x) - lat(y);
  const acceptable = ok.filter(p => lat(p) <= windowMs);
  const pool = acceptable.length ? acceptable : ok;
  let brainPool = pool.filter(p => !TOKEN_HEAVY_RE.test(p.model));
  let brainTokenHeavy = false;
  if (!brainPool.length) { brainPool = pool; brainTokenHeavy = true; }
  const brain = [...brainPool].sort(byBrain)[0].model;
  const reflex = [...ok].sort((x, y) => lat(x) - lat(y))[0].model;
  return { brain, reflex, brainTokenHeavy };
}

function createOnboardingChat({ registry, router }) {
  async function liveConnection() {
    const a = registry.active();
    if (!a || a.kind !== 'live' || !a.baseUrl) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
    let models = [];
    try { models = await registry.models(a.id); } catch { models = []; }
    const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string' && m);
    return { a, list };
  }
  // One model probe: three tiny dispatches (basic completion, tool-calling, streaming first chunk).
  async function probeOne(a, model) {
    const targets = registry.targets(a.id, model);
    if (!targets.length) return { model, ok: false, error: 'NOT_AUTHORIZED', latencyMs: null, streaming: false, tools: false };
    const extra = { source: 'first-run-onboarding-probe' };
    const t0 = Date.now();
    let r;
    try { r = await router.dispatch({ targets, body: { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }, extra }); }
    catch (e) { return { model, ok: false, error: e?.message || 'PROBE_FAILED', latencyMs: Date.now() - t0, streaming: false, tools: false }; }
    const latencyMs = Date.now() - t0;
    const text = r?.value?.data?.choices?.[0]?.message?.content;
    if (!r?.ok || typeof text !== 'string') return { model, ok: false, error: 'PROBE_NO_RESPONSE', latencyMs, streaming: false, tools: false };
    let tools = false;
    try {
      const rt = await router.dispatch({ targets, body: { messages: [{ role: 'user', content: 'Call the damar_probe_ping tool now.' }], tools: [{ type: 'function', function: { name: 'damar_probe_ping', description: 'Capability probe. Call this tool.', parameters: { type: 'object', properties: {} } } }], tool_choice: 'auto', max_tokens: 32 }, extra });
      const msg = rt?.value?.data?.choices?.[0]?.message;
      tools = !!(rt?.ok && Array.isArray(msg?.tool_calls) && msg.tool_calls.length);
    } catch { tools = false; }
    let streaming = false;
    try {
      const rs = await router.dispatch({ targets, body: { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }, stream: true, extra });
      if (rs?.ok && rs.value && typeof rs.value.getReader === 'function') {
        const reader = rs.value.getReader();
        const first = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res(null), PROBE_STREAM_FIRST_CHUNK_MS))]);
        if (first && !first.done) streaming = true;
        try { await reader.cancel(); } catch {}
      }
    } catch { streaming = false; }
    return { model, ok: true, latencyMs, streaming, tools };
  }
  return {
    // One interview turn: { messages } -> { text, model }. 409 when no granted live model is available
    // (the Presence flow then falls back to the deterministic template branch). The interview runs on the
    // model Core selected for the connection (the v2 probe's brain, written by the step-0 select) when it
    // is in the catalog; otherwise the first catalog model (v1 behavior).
    async chat(input) {
      const messages = cleanMessages(input);
      const { a, list } = await liveConnection();
      const model = (a.model && list.includes(a.model)) ? a.model : (list[0] || a.model);
      if (!model) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
      const targets = registry.targets(a.id, model);
      if (!targets.length) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
      const r = await router.dispatch({ targets, body: { messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], max_tokens: 600 }, extra: { source: 'first-run-onboarding' } });
      const text = r?.value?.data?.choices?.[0]?.message?.content;
      if (!r?.ok || typeof text !== 'string' || !text.trim()) throw fail(502, 'ONBOARDING_MODEL_ERROR');
      return { text: text.trim().slice(0, 4000), model };
    },
    // V2 step-0 probing: probe the whole catalog (bounded) and apply the capability-first policy.
    // -> { results, brain, reflex, brainTokenHeavy }. 409 when no live connection / empty catalog;
    // 502 when not a single model answers (the client then falls back to the v1 first-model select).
    async probeAll() {
      const { a, list } = await liveConnection();
      if (!list.length) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
      const results = [];
      for (const model of list.slice(0, MAX_PROBE_MODELS)) results.push(await probeOne(a, model));
      const sel = selectModels(results);
      if (!sel) throw fail(502, 'ONBOARDING_PROBE_ALL_FAILED');
      return { results, ...sel };
    },
  };
}
module.exports = { createOnboardingChat, ONBOARDING_SYSTEM_PROMPT: SYSTEM_PROMPT, capabilityTier, selectModels };
