'use strict';
// First-run onboarding interview (branch A): a bounded, tool-free chat completion through Core's provider
// router, used only while presence.onboardingCompleted is false. The system prompt is fixed here in Core -
// the Presence renderer sends only user/assistant turns, never a system prompt, a tool or a model choice.
// The model conducts the interview; it never writes config. It ends by emitting a DAMAR_SETUP_JSON line,
// which the Presence form shows for Owner confirmation; only the confirmed form values are saved
// (POST /api/r9/presence/onboarding composes the settings update and sets the completion flag).
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
const fail = (status, error) => Object.assign(Error(error), { status });

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MESSAGES) throw fail(400, 'ONBOARDING_MESSAGES_INVALID');
  return input.map(m => {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_CHARS) throw fail(400, 'ONBOARDING_MESSAGES_INVALID');
    return { role: m.role, content: m.content };
  });
}

function createOnboardingChat({ registry, router }) {
  return {
    // One interview turn: { messages } -> { text, model }. 409 when no granted live model is available
    // (the Presence flow then falls back to the deterministic template branch).
    async chat(input) {
      const messages = cleanMessages(input);
      const a = registry.active();
      if (!a || a.kind !== 'live' || !a.baseUrl) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
      let models = [];
      try { models = await registry.models(a.id); } catch { models = []; }
      const model = (Array.isArray(models) ? models.find(m => typeof m === 'string' && m) : null) || a.model;
      if (!model) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
      const targets = registry.targets(a.id, model);
      if (!targets.length) throw fail(409, 'ONBOARDING_MODEL_UNAVAILABLE');
      const r = await router.dispatch({ targets, body: { messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], max_tokens: 600 }, extra: { source: 'first-run-onboarding' } });
      const text = r?.value?.data?.choices?.[0]?.message?.content;
      if (!r?.ok || typeof text !== 'string' || !text.trim()) throw fail(502, 'ONBOARDING_MODEL_ERROR');
      return { text: text.trim().slice(0, 4000), model };
    },
  };
}
module.exports = { createOnboardingChat, ONBOARDING_SYSTEM_PROMPT: SYSTEM_PROMPT };
