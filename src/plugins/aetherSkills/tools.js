const BaseTool = require("../../core/tools/BaseTool");

// Layanan inti yang dipakai skill (semua sudah ada; skill hanya merakit).
const agentHub = require("../../services/agentHub");
const orchestrator = require("../../services/orchestrator");
const whatsapp = require("../../services/whatsappService");
const vision = require("../../services/visionService");
const devices = require("../../services/deviceService");
const home = require("../../services/homeService");
const immich = require("../../services/immichService");
const context = require("../../services/contextService");
const memory = require("../../memory/services/MemoryService");

// ---- Pembantu ------------------------------------------------------

const jid = n => `${String(n).replace(/\D/g, "")}@s.whatsapp.net`;

/** Jalankan tugas di agent tertentu; lempar bila agent gagal/offline. */
async function run(agent, task) {
    const r = await agentHub.run(agent, task);
    if (!r.ok) throw new Error(r.error || `${agent} gagal / offline`);
    return r.output;
}

/** Orkestrasi lintas-agent (plan → eksekusi → sintesis) → teks akhir. */
async function orchestrate(request) {
    let final = "";
    await orchestrator.run(request, ev => {
        if (ev.type === "final") final = ev.final ?? final;
    });
    return final;
}

/** Ambil snapshot kamera terdaftar lalu minta model vision membacanya. */
async function seeCam(cameraId, prompt) {
    const cam = devices.getCamera(cameraId);
    if (!cam) throw new Error(`Kamera '${cameraId}' tidak terdaftar.`);
    const r = await vision.analyzeUrl({ url: cam.snapshotUrl, headers: cam.headers || {}, prompt });
    return r.text;
}

/** Periksa semua kamera dengan satu pertanyaan vision. */
async function sweep(prompt) {
    const out = [];
    for (const c of devices.cameras()) {
        try { out.push({ camera: c.id, seen: await seeCam(c.id, prompt) }); }
        catch (e) { out.push({ camera: c.id, error: e.message }); }
    }
    return out;
}

const saveMemory = (content, type = "semantic", importance = 0.6) =>
    memory.remember({ content, type, importance, source: "skill" });

// ---- Definisi skill (data-driven) ----------------------------------
// { name, description, parameters, execute } — dibungkus jadi BaseTool.

const P = {
    number: { type: "string", description: "Nomor WhatsApp (mis. 62812...).", required: true },
    text: { type: "string", description: "Teks pesan.", required: true },
    task: { type: "string", description: "Deskripsi tugas.", required: true },
    camera: { type: "string", description: "Id kamera terdaftar.", required: true }
};

const SKILLS = [

    // ===== Delegasi & Orkestrasi (OpenClaw / Hermes / multi-agent) =====
    { name: "openclaw_do", description: "Suruh OpenClaw mengoperasikan desktop/aplikasi tanpa API (klik, ketik, isi form). Untuk AKSI di antarmuka komputer.",
      parameters: { task: P.task }, execute: a => run("openclaw", a.task) },
    { name: "openclaw_open_app", description: "Minta OpenClaw membuka sebuah aplikasi/desktop program.",
      parameters: { app: { type: "string", required: true, description: "Nama aplikasi." } }, execute: a => run("openclaw", `Buka aplikasi ${a.app}.`) },
    { name: "openclaw_web", description: "Minta OpenClaw membuka URL di browser lalu melakukan sesuatu di halaman itu.",
      parameters: { url: { type: "string", required: true }, task: { type: "string", required: true } }, execute: a => run("openclaw", `Buka ${a.url} di browser lalu ${a.task}.`) },
    { name: "openclaw_type", description: "Minta OpenClaw mengetik teks di jendela yang sedang aktif.",
      parameters: { text: P.text }, execute: a => run("openclaw", `Ketik teks berikut di jendela aktif:\n${a.text}`) },
    { name: "hermes_run", description: "Delegasikan tugas agentik berlapis ke Hermes (runtime agent terpisah).",
      parameters: { task: P.task }, execute: a => run("hermes", a.task) },
    { name: "hermes_research", description: "Minta Hermes meneliti sebuah topik secara mendalam dan merangkum temuannya.",
      parameters: { topic: { type: "string", required: true } }, execute: a => run("hermes", `Riset mendalam tentang "${a.topic}". Rangkum temuan penting dalam poin-poin.`) },
    { name: "orchestrate", description: "Tugas kompleks lintas-agent: Aether menyusun rencana lalu memberi tiap langkah ke agent paling cocok (Aether/OpenClaw/Hermes) dan menyatukan hasilnya.",
      parameters: { request: { type: "string", required: true } }, execute: a => orchestrate(a.request) },
    { name: "agents_status", description: "Cek kesiapan semua agent (Aether/OpenClaw/Hermes) beserta skill-nya.",
      parameters: {}, execute: () => agentHub.health() },

    // ===== WhatsApp =====
    { name: "wa_send", description: "Kirim pesan WhatsApp ke sebuah nomor.",
      parameters: { number: P.number, text: P.text }, execute: async a => { await whatsapp.send(jid(a.number), a.text); return { sent: true }; } },
    { name: "wa_broadcast", description: "Kirim pesan WhatsApp ke semua nomor yang diizinkan (broadcast).",
      parameters: { text: P.text }, execute: async a => ({ recipients: await whatsapp.broadcast(a.text) }) },
    { name: "wa_notify_owner", description: "Beri tahu pemilik via WhatsApp (broadcast ke nomor terizin).",
      parameters: { text: P.text }, execute: async a => ({ recipients: await whatsapp.broadcast(`🔔 ${a.text}`) }) },
    { name: "wa_send_image", description: "Kirim gambar (via URL) ke nomor WhatsApp.",
      parameters: { number: P.number, url: { type: "string", required: true }, caption: { type: "string" } }, execute: async a => { await whatsapp.sendPhoto(jid(a.number), a.url, a.caption); return { sent: true }; } },
    { name: "wa_send_document", description: "Kirim dokumen/berkas (via URL) ke nomor WhatsApp.",
      parameters: { number: P.number, url: { type: "string", required: true }, caption: { type: "string" } }, execute: async a => { await whatsapp.sendDocument(jid(a.number), a.url, a.caption); return { sent: true }; } },
    { name: "wa_status", description: "Status koneksi WhatsApp Aether (tersambung, nomor, dll).",
      parameters: {}, execute: () => whatsapp.status() },

    // ===== Vision / CCTV =====
    { name: "see_camera", description: "Lihat kamera/CCTV terdaftar dan jawab pertanyaan tentang isinya.",
      parameters: { camera: P.camera, question: { type: "string" } }, execute: a => seeCam(a.camera, a.question || "Deskripsikan apa yang terlihat.").then(text => ({ camera: a.camera, text })) },
    { name: "count_people_camera", description: "Hitung berapa orang yang terlihat di sebuah kamera.",
      parameters: { camera: P.camera }, execute: a => seeCam(a.camera, "Ada berapa orang di gambar ini? Jawab angka saja bila bisa.").then(text => ({ text })) },
    { name: "read_camera_text", description: "Bacakan teks yang terlihat di sebuah kamera (mis. plat nomor, papan).",
      parameters: { camera: P.camera }, execute: a => seeCam(a.camera, "Bacakan semua teks/angka yang terlihat.").then(text => ({ text })) },
    { name: "describe_image", description: "Analisis/deskripsikan gambar dari URL.",
      parameters: { url: { type: "string", required: true }, question: { type: "string" } }, execute: a => vision.analyzeUrl({ url: a.url, prompt: a.question }).then(r => ({ text: r.text })) },
    { name: "list_cameras", description: "Daftar kamera/CCTV yang terdaftar.",
      parameters: {}, execute: () => ({ cameras: devices.cameras() }) },
    { name: "security_sweep", description: "Periksa SEMUA kamera sekaligus dan laporkan apa yang terlihat di tiap kamera.",
      parameters: {}, execute: () => sweep("Deskripsikan singkat apa/siapa yang terlihat. Sebut bila ada aktivitas mencurigakan.").then(results => ({ results })) },
    { name: "security_alert", description: "Sapu semua kamera lalu KIRIM ringkasannya ke WhatsApp pemilik.",
      parameters: {}, execute: async () => {
          const r = await sweep("Ada aktivitas mencurigakan/orang tak dikenal? Jawab singkat.");
          const msg = "🛡️ Laporan keamanan:\n" + r.map(x => `• ${x.camera}: ${x.seen || x.error}`).join("\n");
          const recipients = await whatsapp.broadcast(msg);
          return { recipients, results: r };
      } },
    { name: "watch_and_notify", description: "Lihat satu kamera lalu kirim hasilnya ke WhatsApp pemilik.",
      parameters: { camera: P.camera, question: { type: "string" } }, execute: async a => {
          const text = await seeCam(a.camera, a.question || "Deskripsikan yang terlihat.");
          const recipients = await whatsapp.broadcast(`📷 ${a.camera}: ${text}`);
          return { text, recipients };
      } },

    // ===== Home automation (Home Assistant) =====
    { name: "home_control", description: "Kendali perangkat rumah: nyalakan/matikan/atur (mis. lampu, AC, saklar).",
      parameters: { entity: { type: "string", required: true, description: "entity_id Home Assistant." }, action: { type: "string", required: true, description: "turn_on|turn_off|toggle|set_temperature|..." }, value: { type: "string" } }, execute: a => home.control(a.entity, a.action, a.value) },
    { name: "device_on", description: "Nyalakan sebuah perangkat rumah.",
      parameters: { entity: { type: "string", required: true } }, execute: a => home.control(a.entity, "turn_on") },
    { name: "device_off", description: "Matikan sebuah perangkat rumah.",
      parameters: { entity: { type: "string", required: true } }, execute: a => home.control(a.entity, "turn_off") },
    { name: "device_toggle", description: "Balik keadaan perangkat rumah (on↔off).",
      parameters: { entity: { type: "string", required: true } }, execute: a => home.control(a.entity, "toggle") },
    { name: "scene_activate", description: "Aktifkan sebuah scene Home Assistant (mis. scene.malam).",
      parameters: { scene: { type: "string", required: true } }, execute: a => home.control(a.scene, "turn_on") },
    { name: "set_temperature", description: "Atur suhu target sebuah perangkat (mis. AC/thermostat).",
      parameters: { entity: { type: "string", required: true }, value: { type: "string", required: true } }, execute: a => home.control(a.entity, "set_temperature", a.value) },
    { name: "home_status", description: "Ringkasan keadaan rumah (perangkat menyala, dll).",
      parameters: {}, execute: () => home.summary() },
    { name: "home_health", description: "Status koneksi ke Home Assistant.",
      parameters: {}, execute: () => home.health() },

    // ===== Memori =====
    { name: "remember", description: "Simpan fakta ke memori jangka panjang Aether.",
      parameters: { content: { type: "string", required: true } }, execute: a => saveMemory(a.content).then(m => ({ saved: true, id: m?.id })) },
    { name: "remember_person", description: "Ingat sesuatu tentang seseorang.",
      parameters: { name: { type: "string", required: true }, detail: { type: "string", required: true } }, execute: a => saveMemory(`${a.name}: ${a.detail}`, "semantic", 0.7).then(() => ({ saved: true })) },
    { name: "remember_preference", description: "Ingat preferensi/kebiasaan pemilik.",
      parameters: { preference: { type: "string", required: true } }, execute: a => saveMemory(a.preference, "preference", 0.7).then(() => ({ saved: true })) },
    { name: "note_idea", description: "Catat ide/catatan cepat ke memori.",
      parameters: { idea: { type: "string", required: true } }, execute: a => saveMemory(`Ide: ${a.idea}`, "episodic", 0.5).then(() => ({ saved: true })) },
    { name: "recall", description: "Cari memori yang relevan dengan sebuah pertanyaan/kata kunci.",
      parameters: { query: { type: "string", required: true } }, execute: a => memory.recall(a.query, { limit: 8 }).then(r => ({ items: (r.items || []).map(i => i.content) })) },

    // ===== Orang & foto (Immich) =====
    { name: "list_known_people", description: "Daftar orang yang dikenali di galeri (Immich).",
      parameters: {}, execute: () => immich.people() },
    { name: "photos_summary", description: "Ringkasan galeri foto (Immich).",
      parameters: {}, execute: () => immich.summary() },

    // ===== Kesadaran / konteks =====
    { name: "home_brief", description: "Aether merangkum keadaan rumah secara naratif (gaya sapaan).",
      parameters: {}, execute: () => context.brief().then(r => ({ brief: r.brief })) },
    { name: "full_context", description: "Snapshot lengkap seluruh sinyal rumah & sistem.",
      parameters: {}, execute: () => context.snapshot() },
    { name: "system_health", description: "Kesehatan sistem (CPU/RAM/uptime) tempat Aether berjalan.",
      parameters: {}, execute: () => context.snapshot().then(s => s.system) },

    // ===== Komposit powerful (gabungan kemampuan) =====
    { name: "morning_briefing", description: "Susun brief keadaan rumah lalu kirim ke WhatsApp pemilik.",
      parameters: {}, execute: async () => { const { brief } = await context.brief(); const recipients = await whatsapp.broadcast(`☀️ ${brief}`); return { brief, recipients }; } },
    { name: "daily_report", description: "Laporan harian: konteks + kesehatan sistem, dikirim ke WhatsApp.",
      parameters: {}, execute: async () => { const { brief } = await context.brief(); const recipients = await whatsapp.broadcast(`📋 Laporan Aether:\n${brief}`); return { recipients }; } },
    { name: "arrive_home", description: "Rutinitas datang: aktifkan scene (bila diberi) lalu kirim brief rumah ke WhatsApp.",
      parameters: { scene: { type: "string", description: "scene HA opsional, mis. scene.pulang." } }, execute: async a => { let scene = null; if (a.scene) { await home.control(a.scene, "turn_on"); scene = a.scene; } const { brief } = await context.brief(); await whatsapp.broadcast(`🏠 Selamat datang.\n${brief}`); return { scene, done: true }; } },
    { name: "leave_home", description: "Rutinitas pergi: matikan perangkat yang diberikan lalu sapu kamera & kirim ringkasan.",
      parameters: { entities: { type: "string", description: "entity_id dipisah koma untuk dimatikan." } }, execute: async a => {
          const off = [];
          for (const e of String(a.entities || "").split(",").map(s => s.trim()).filter(Boolean)) { try { await home.control(e, "turn_off"); off.push(e); } catch { /* skip */ } }
          const r = await sweep("Pastikan aman: ada orang/aktivitas? Jawab singkat.");
          await whatsapp.broadcast(`🚪 Rumah ditinggal. Dimatikan: ${off.join(", ") || "-"}\n` + r.map(x => `• ${x.camera}: ${x.seen || x.error}`).join("\n"));
          return { off, cameras: r };
      } },
    { name: "research_and_send", description: "Hermes meneliti topik, hasilnya dikirim ke WhatsApp.",
      parameters: { topic: { type: "string", required: true }, number: P.number }, execute: async a => { const out = await run("hermes", `Riset "${a.topic}" dan rangkum.`); await whatsapp.send(jid(a.number), out); return { sent: true }; } },
    { name: "desktop_and_report", description: "OpenClaw menjalankan tugas desktop, hasil/laporannya dikirim ke WhatsApp.",
      parameters: { task: P.task, number: P.number }, execute: async a => { const out = await run("openclaw", a.task); await whatsapp.send(jid(a.number), `🖥️ ${out}`); return { sent: true }; } },
    { name: "ask_home", description: "Tanya apa saja tentang rumah/tugas; Aether berorkestrasi memakai semua tool & agent untuk menjawab/menuntaskan.",
      parameters: { question: { type: "string", required: true } }, execute: a => orchestrate(a.question).then(final => ({ answer: final })) },
    { name: "summarize_and_remember", description: "Ringkas sebuah teks lalu simpan ringkasannya ke memori.",
      parameters: { text: { type: "string", required: true } }, execute: async a => { const s = await run("aether", `Ringkas padat teks berikut:\n${a.text}`); await saveMemory(s, "semantic", 0.6); return { summary: s, saved: true }; } },
    { name: "translate", description: "Terjemahkan teks ke bahasa target.",
      parameters: { text: { type: "string", required: true }, to: { type: "string", required: true, description: "bahasa target, mis. Inggris." } }, execute: a => run("aether", `Terjemahkan ke ${a.to}, keluarkan terjemahannya saja:\n${a.text}`).then(t => ({ translation: t })) },
    { name: "explain_camera_to_owner", description: "Lihat kamera, jelaskan dengan bahasa manusiawi, lalu kirim ke WhatsApp pemilik.",
      parameters: { camera: P.camera }, execute: async a => { const raw = await seeCam(a.camera, "Deskripsikan detail."); const nice = await run("aether", `Sampaikan ini ke pemilik rumah dengan ramah & singkat: ${raw}`); await whatsapp.broadcast(`📷 ${a.camera}: ${nice}`); return { text: nice }; } },
    { name: "smart_reply", description: "Susun balasan yang tepat untuk sebuah pesan masuk (nada bisa diatur).",
      parameters: { message: { type: "string", required: true }, tone: { type: "string", description: "mis. sopan, santai, tegas." } }, execute: a => run("aether", `Buat balasan (${a.tone || "sopan"}) untuk pesan ini:\n${a.message}`).then(reply => ({ reply })) }

];

module.exports = SKILLS.map(def => {
    const tool = new BaseTool({ name: def.name, description: def.description, parameters: def.parameters || {} });
    tool.execute = def.execute;
    return tool;
});
