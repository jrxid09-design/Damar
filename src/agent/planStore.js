const fs = require("node:fs");
const path = require("node:path");

const ExecutionPlan = require("./models/executionPlan");
const telemetry = require("../services/telemetryService");

/**
 * Checkpoint rencana (§29, §30).
 *
 * Tanpa ini, tugas panjang yang mati di tengah jalan harus diulang
 * dari nol — termasuk langkah-langkah yang sudah berhasil dan sudah
 * memakan waktu, token, atau menyentuh dunia luar. Mengulang langkah
 * yang berefek samping bukan cuma boros; ia bisa mengirim pesan dua
 * kali atau menulis berkas yang sama berulang.
 *
 * Satu berkas JSON per rencana. Bukan basis data: rencana berumur
 * pendek, jumlahnya sedikit, dan dapat dibaca manusia saat menelusuri
 * masalah — gerbang Ponytail §56 menolak infrastruktur yang belum
 * terbukti dibutuhkan.
 */

const DIR = path.join(__dirname, "..", "..", "data", "plans");

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

const fileOf = id => path.join(DIR, `${String(id).replace(/[^\w-]/g, "")}.json`);

/**
 * Simpan keadaan rencana saat ini.
 *
 * Ditulis lewat berkas sementara lalu di-rename, supaya proses yang
 * mati di tengah penulisan tidak meninggalkan checkpoint separuh —
 * checkpoint rusak lebih berbahaya daripada tidak ada checkpoint.
 */
function save(plan) {

  ensureDir();

  const target = fileOf(plan.id);
  const tmp = `${target}.tmp`;

  fs.writeFileSync(tmp, JSON.stringify(plan.toJSON(), null, 2), "utf8");
  fs.renameSync(tmp, target);

  return target;

}

/** Muat rencana; null bila tidak ada atau rusak. */
function load(id) {

  try {
    const raw = fs.readFileSync(fileOf(id), "utf8");
    return new ExecutionPlan(JSON.parse(raw));
  }
  catch {
    return null;
  }

}

/**
 * Siapkan rencana untuk dilanjutkan.
 *
 * Langkah yang sedang "running" saat proses mati dikembalikan ke
 * "pending": kita tidak tahu apakah ia sempat selesai. Menganggapnya
 * selesai berisiko melewatkan pekerjaan; menganggapnya gagal berisiko
 * menyerah pada langkah yang sebenarnya berhasil. Mengulanginya
 * adalah pilihan yang paling dapat dipertanggungjawabkan — dan
 * Verification Engine yang akan memastikan hasilnya benar.
 */
function resume(id) {

  const plan = load(id);

  if (!plan) return null;

  let reset = 0;

  for (const step of plan.steps) {
    if (step.status === "running") {
      step.status = "pending";
      step.startedAt = null;
      reset += 1;
    }
  }

  if (reset) {
    telemetry.warn(`[plan] ${id}: ${reset} langkah tergantung dikembalikan ke antrean`);
    save(plan);
  }

  telemetry.publish("plan:resumed", { id, reset, progress: plan.progress });

  return plan;

}

/**
 * Pilah langkah tertunda: mana yang aman diulang sendiri, mana yang
 * harus menunggu pemilik (§30, Konstitusi Pasal 2.1).
 *
 * Dasarnya sederhana: tool aman (baca murni) boleh diulang — paling
 * buruk hanya boros waktu. Tool destruktif tidak boleh diulang tanpa
 * sepengetahuan pemilik: mengulang dapat menulis, mengirim, atau
 * menghapus dua kali.
 *
 * Langkah yang sudah `done` tidak diulang sama sekali; itulah guna
 * checkpoint.
 */
function triage(plan) {

    const riskCatalog = require("../core/safety/riskCatalog");

    const otomatis = [];
    const perluIzin = [];

    for (const step of plan?.steps ?? []) {

        if (step.status === "done") continue;

        const destructive = riskCatalog.riskOf(step.tool);

        (destructive ? perluIzin : otomatis).push({
            id: step.id,
            tool: step.tool,
            risk: destructive ? "destructive" : "safe",
            status: step.status,
            attempts: step.attempts
        });

    }

    return { otomatis, perluIzin };

}

/**
 * Rencana yang tidak berakhir bersih — kandidat untuk ditelusuri
 * saat boot.
 *
 * Berkas yang tersisa berarti pemanggilnya tidak sempat menghapusnya.
 * Itu ada dua rasa, dan hanya satu yang layak dilaporkan:
 *
 *   - masih ada langkah pending/running/failed → benar-benar terhenti
 *     di tengah jalan; inilah yang perlu dilihat pemilik;
 *   - SEMUA langkah `done` → pekerjaannya tuntas, hanya berkasnya
 *     yang tertinggal. Melaporkannya sebagai "terhenti" adalah alarm
 *     palsu, jadi puingnya dibuang di sini alih-alih diteriakkan.
 *
 * Langkah yang GAGAL tetap dihitung belum tuntas: rantai yang tiap
 * langkahnya gagal tidak boleh tampak selesai.
 */
function unfinished() {

  ensureDir();

  const out = [];

  for (const file of fs.readdirSync(DIR)) {

    if (!file.endsWith(".json")) continue;

    const id = file.replace(/\.json$/, "");
    const plan = load(id);

    if (!plan || !plan.steps.length) continue;

    if (plan.steps.every(step => step.status === "done")) {
      remove(id);
      continue;
    }

    out.push(plan);

  }

  return out;

}

function remove(id) {
  try { fs.unlinkSync(fileOf(id)); return true; }
  catch { return false; }
}

/**
 * Buang checkpoint lama.
 *
 * Rencana yang tuntas dihapus saat selesai; yang tertinggal berarti
 * prosesnya mati. Itu berguna untuk ditelusuri — tetapi hanya selagi
 * masih relevan. Tanpa pembersihan, direktori tumbuh selamanya dan
 * `unfinished()` lama-lama melaporkan puing, bukan pekerjaan nyata.
 */
function prune(maxAgeMs = 24 * 60 * 60 * 1000) {

  ensureDir();

  const batas = Date.now() - maxAgeMs;

  let dibuang = 0;

  for (const file of fs.readdirSync(DIR)) {

    if (!file.endsWith(".json")) continue;

    const full = path.join(DIR, file);

    try {
      if (fs.statSync(full).mtimeMs < batas) {
        fs.unlinkSync(full);
        dibuang += 1;
      }
    }
    catch { /* berkas hilang di tengah jalan bukan masalah */ }

  }

  return dibuang;

}

module.exports = { save, load, resume, triage, unfinished, remove, prune, DIR };
