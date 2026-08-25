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

/** Jalankan tugas di agent tertentu; lempar bila agent gagal/offline.
 *  N2 Round-2: identitas eksekusi pemanggil tool (ctx.exec) diteruskan —
 *  delegasi dari model mewarisi otoritas pemanggil, bukan 'system'. */
async function run(agent, task, exec = null) {
    const r = await agentHub.run(agent, task, { exec });
    if (!r.ok) throw new Error(r.error || `${agent} gagal / offline`);
    return r.output;
}

/** Orkestrasi lintas-agent (plan → eksekusi → sintesis) → teks akhir. */
async function orchestrate(request, exec = null) {
    let final = "";
    await orchestrator.run(request, ev => {
        if (ev.type === "final") final = ev.final ?? final;
    }, { exec });
    return final;
}

/** Ambil snapshot kamera terdaftar lalu minta model vision membacanya.
 *  D-FINAL: URL berasal dari registry kamera pemilik → trusted-lan.
 *  describe_image (URL dari argumen model/user) TETAP policy public. */
async function seeCam(cameraId, prompt, exec = null) {
    const cam = devices.getCamera(cameraId);
    if (!cam) throw new Error(`Kamera '${cameraId}' tidak terdaftar.`);
    const r = await vision.analyzeUrl({
        url: cam.snapshotUrl,
        headers: cam.headers || {},
        prompt,
        // N2-FINAL: giliran visi mewarisi pemanggil tool.
        exec,
        // D-FINAL: URL berasal dari registry kamera pemilik.
        policy: "trusted-lan"
    });
    return r.text;
}

/** Periksa semua kamera dengan satu pertanyaan vision. */
async function sweep(prompt, exec = null) {
    const out = [];
    for (const c of devices.cameras()) {
        try { out.push({ camera: c.id, seen: await seeCam(c.id, prompt, exec) }); }
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

    // ===== Delegasi & Orkestrasi (multi-agent) =====
    { name: "orchestrate", description: "Tugas kompleks lintas-agent: Aether menyusun rencana lalu memberi tiap langkah ke agent paling cocok (Aether & anak buahnya) dan menyatukan hasilnya.",
      parameters: { request: { type: "string", required: true } }, execute: (a, ctx) => orchestrate(a.request, ctx?.exec) },
    { name: "agents_status", description: "Cek kesiapan semua agent Aether beserta skill-nya.",
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
      parameters: { camera: P.camera, question: { type: "string" } }, execute: (a, ctx) => seeCam(a.camera, a.question || "Deskripsikan apa yang terlihat.", ctx?.exec).then(text => ({ camera: a.camera, text })) },
    { name: "count_people_camera", description: "Hitung berapa orang yang terlihat di sebuah kamera.",
      parameters: { camera: P.camera }, execute: (a, ctx) => seeCam(a.camera, "Ada berapa orang di gambar ini? Jawab angka saja bila bisa.", ctx?.exec).then(text => ({ text })) },
    { name: "read_camera_text", description: "Bacakan teks yang terlihat di sebuah kamera (mis. plat nomor, papan).",
      parameters: { camera: P.camera }, execute: (a, ctx) => seeCam(a.camera, "Bacakan semua teks/angka yang terlihat.", ctx?.exec).then(text => ({ text })) },
    { name: "describe_image", description: "Analisis/deskripsikan gambar dari URL.",
      parameters: { url: { type: "string", required: true }, question: { type: "string" } }, execute: (a, ctx) => vision.analyzeUrl({ url: a.url, prompt: a.question, exec: ctx?.exec }).then(r => ({ text: r.text })) },
    { name: "list_cameras", description: "Daftar kamera/CCTV yang terdaftar.",
      parameters: {}, execute: () => ({ cameras: devices.cameras() }) },
    { name: "security_sweep", description: "Periksa SEMUA kamera sekaligus dan laporkan apa yang terlihat di tiap kamera.",
      parameters: {}, execute: (a, ctx) => sweep("Deskripsikan singkat apa/siapa yang terlihat. Sebut bila ada aktivitas mencurigakan.", ctx?.exec).then(results => ({ results })) },
    { name: "security_alert", description: "Sapu semua kamera lalu KIRIM ringkasannya ke WhatsApp pemilik.",
      parameters: {}, execute: async (a, ctx) => {
          const r = await sweep("Ada aktivitas mencurigakan/orang tak dikenal? Jawab singkat.", ctx?.exec);
          const msg = "🛡️ Laporan keamanan:\n" + r.map(x => `• ${x.camera}: ${x.seen || x.error}`).join("\n");
          const recipients = await whatsapp.broadcast(msg);
          return { recipients, results: r };
      } },
    { name: "watch_and_notify", description: "Lihat satu kamera lalu kirim hasilnya ke WhatsApp pemilik.",
      parameters: { camera: P.camera, question: { type: "string" } }, execute: async (a, ctx) => {
          const text = await seeCam(a.camera, a.question || "Deskripsikan yang terlihat.", ctx?.exec);
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
      parameters: {}, execute: (a, ctx) => context.brief(ctx?.exec).then(r => ({ brief: r.brief })) },
    { name: "full_context", description: "Snapshot lengkap seluruh sinyal rumah & sistem.",
      parameters: {}, execute: () => context.snapshot() },
    { name: "system_health", description: "Kesehatan sistem (CPU/RAM/uptime) tempat Aether berjalan.",
      parameters: {}, execute: () => context.snapshot().then(s => s.system) },

    // ===== Komposit powerful (gabungan kemampuan) =====
    { name: "morning_briefing", description: "Susun brief keadaan rumah lalu kirim ke WhatsApp pemilik.",
      parameters: {}, execute: async (a, ctx) => { const { brief } = await context.brief(ctx?.exec); const recipients = await whatsapp.broadcast(`☀️ ${brief}`); return { brief, recipients }; } },
    { name: "daily_report", description: "Laporan harian: konteks + kesehatan sistem, dikirim ke WhatsApp.",
      parameters: {}, execute: async (a, ctx) => { const { brief } = await context.brief(ctx?.exec); const recipients = await whatsapp.broadcast(`📋 Laporan Aether:\n${brief}`); return { recipients }; } },
    { name: "arrive_home", description: "Rutinitas datang: aktifkan scene (bila diberi) lalu kirim brief rumah ke WhatsApp.",
      parameters: { scene: { type: "string", description: "scene HA opsional, mis. scene.pulang." } }, execute: async (a, ctx) => { let scene = null; if (a.scene) { await home.control(a.scene, "turn_on"); scene = a.scene; } const { brief } = await context.brief(ctx?.exec); await whatsapp.broadcast(`🏠 Selamat datang.\n${brief}`); return { scene, done: true }; } },
    { name: "leave_home", description: "Rutinitas pergi: matikan perangkat yang diberikan lalu sapu kamera & kirim ringkasan.",
      parameters: { entities: { type: "string", description: "entity_id dipisah koma untuk dimatikan." } }, execute: async a => {
          const off = [];
          for (const e of String(a.entities || "").split(",").map(s => s.trim()).filter(Boolean)) { try { await home.control(e, "turn_off"); off.push(e); } catch { /* skip */ } }
          const r = await sweep("Pastikan aman: ada orang/aktivitas? Jawab singkat.");
          await whatsapp.broadcast(`🚪 Rumah ditinggal. Dimatikan: ${off.join(", ") || "-"}\n` + r.map(x => `• ${x.camera}: ${x.seen || x.error}`).join("\n"));
          return { off, cameras: r };
      } },
    { name: "ask_home", description: "Tanya apa saja tentang rumah/tugas; Aether berorkestrasi memakai semua tool & agent untuk menjawab/menuntaskan.",
      parameters: { question: { type: "string", required: true } }, execute: (a, ctx) => orchestrate(a.question, ctx?.exec).then(final => ({ answer: final })) },
    { name: "summarize_and_remember", description: "Ringkas sebuah teks lalu simpan ringkasannya ke memori.",
      parameters: { text: { type: "string", required: true } }, execute: async (a, ctx) => { const s = await run("aether", `Ringkas padat teks berikut:\n${a.text}`, ctx?.exec); await saveMemory(s, "semantic", 0.6); return { summary: s, saved: true }; } },
    { name: "translate", description: "Terjemahkan teks ke bahasa target.",
      parameters: { text: { type: "string", required: true }, to: { type: "string", required: true, description: "bahasa target, mis. Inggris." } }, execute: (a, ctx) => run("aether", `Terjemahkan ke ${a.to}, keluarkan terjemahannya saja:\n${a.text}`, ctx?.exec).then(t => ({ translation: t })) },
    { name: "explain_camera_to_owner", description: "Lihat kamera, jelaskan dengan bahasa manusiawi, lalu kirim ke WhatsApp pemilik.",
      parameters: { camera: P.camera }, execute: async (a, ctx) => { const raw = await seeCam(a.camera, "Deskripsikan detail.", ctx?.exec); const nice = await run("aether", `Sampaikan ini ke pemilik rumah dengan ramah & singkat: ${raw}`, ctx?.exec); await whatsapp.broadcast(`📷 ${a.camera}: ${nice}`); return { text: nice }; } },
    { name: "smart_reply", description: "Susun balasan yang tepat untuk sebuah pesan masuk (nada bisa diatur).",
      parameters: { message: { type: "string", required: true }, tone: { type: "string", description: "mis. sopan, santai, tegas." } }, execute: (a, ctx) => run("aether", `Buat balasan (${a.tone || "sopan"}) untuk pesan ini:\n${a.message}`, ctx?.exec).then(reply => ({ reply })) }

];

module.exports = SKILLS.map(def => {
    const tool = new BaseTool({ name: def.name, description: def.description, parameters: def.parameters || {} });
    tool.execute = def.execute;
    return tool;
});
