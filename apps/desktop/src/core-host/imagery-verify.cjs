'use strict';
// VLM verification for Mata Dewa DINOv3 change candidates: a bounded,
// tool-free vision completion through Core's provider router (the same
// dispatch path as the onboarding interview, onboarding-chat.cjs). The
// DINOv3 engine only ever says "something changed here"; this step is where
// DAMAR looks at the two chips itself and judges whether the change is
// MATERIAL (new or lost structure, land clearing, a clear water or
// shoreline change, a new road) or appearance only (clouds and their
// shadows, seasonal or lighting colour shifts, imaging differences).
// Strict verdict protocol: the first line must be "VERDICT: CHANGED" or
// "VERDICT: UNCHANGED"; anything else is no verdict, and a candidate with
// no confirmed verdict stays an observation, never an alert.
const SYSTEM_PROMPT = [
  'Kamu adalah verifikator citra satelit DAMAR. Kamu menerima dua citra satelit wilayah yang sama pada dua tanggal berbeda (baseline lebih dulu, terbaru sesudahnya).',
  'Tugasmu HANYA menilai apakah ada PERUBAHAN MATERIAL di permukaan: bangunan atau struktur baru/hilang, pembukaan atau penutupan lahan, perubahan badan air atau garis pantai yang jelas, jalan baru.',
  'Bukan perubahan material: awan dan bayangannya, perbedaan warna musim atau cahaya, perbedaan sudut atau ketajaman citra, perubahan warna vegetasi musiman tanpa pembukaan lahan.',
  'Jawab baris pertama PERSIS salah satu dari: VERDICT: CHANGED atau VERDICT: UNCHANGED.',
  'Baris kedua: satu kalimat Bahasa Indonesia berisi bukti utamanya. Jangan menulis teks lain.',
].join('\n');

function createImageryVerifier({ registry, router }) {
  async function verify({ baselineJpeg, latestJpeg, locationLabel = '', baselineDay = '', latestDay = '', score = null } = {}) {
    const a = registry.active();
    if (!a || a.kind !== 'live' || !a.baseUrl) return { confirmed: false, status: 'unavailable', note: null, model: null };
    let models = [];
    try { models = await registry.models(a.id); } catch { models = []; }
    const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string' && m);
    const model = (a.model && list.includes(a.model)) ? a.model : (list[0] || a.model);
    if (!model) return { confirmed: false, status: 'unavailable', note: null, model: null };
    const targets = registry.targets(a.id, model);
    if (!targets.length) return { confirmed: false, status: 'unavailable', note: null, model };
    const img = buf => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64') } });
    const body = { messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: 'Lokasi: ' + String(locationLabel || 'titik pantau') + '. Citra pertama (baseline, ' + String(baselineDay || '?') + '):' },
        img(baselineJpeg),
        { type: 'text', text: 'Citra kedua (terbaru, ' + String(latestDay || '?') + '). Skor perubahan fitur DINOv3: ' + (score === null || score === undefined ? 'tidak terhitung' : score) + '. Nilai perubahan materialnya.' },
        img(latestJpeg),
      ] },
    ], max_tokens: 300 };
    let r;
    try { r = await router.dispatch({ targets, body, extra: { source: 'mata-dewa-imagery-verify' } }); }
    catch { return { confirmed: false, status: 'error', note: null, model }; }
    const text = r?.value?.data?.choices?.[0]?.message?.content;
    if (!r?.ok || typeof text !== 'string' || !text.trim()) return { confirmed: false, status: 'error', note: null, model };
    const lines = text.trim().split('\n').map(s => s.trim()).filter(Boolean);
    const head = (lines[0] || '').toUpperCase();
    const note = lines.slice(1).join(' ').slice(0, 300) || null;
    if (head.startsWith('VERDICT: CHANGED')) return { confirmed: true, status: 'ok', note, model };
    if (head.startsWith('VERDICT: UNCHANGED')) return { confirmed: false, status: 'ok', note, model };
    return { confirmed: false, status: 'unparseable', note: text.trim().slice(0, 300), model };
  }
  return { verify };
}

module.exports = { createImageryVerifier, SYSTEM_PROMPT };
