const fs = require("node:fs");
const crypto = require("node:crypto");

/**
 * Kumpulan verifier per tool (§46, §192, §194, Konstitusi Pasal 5).
 *
 * Prinsipnya satu kalimat: **keluaran tool bukan bukti**. Sebuah
 * tool yang mengembalikan `{ success: true }` hanya memberi tahu
 * bahwa kodenya selesai berjalan tanpa melempar error — bukan
 * bahwa dunia benar-benar berubah seperti yang diklaim.
 *
 * Setiap verifier memeriksa keadaan NYATA setelah eksekusi, lewat
 * jalur yang berbeda dari tool itu sendiri. Menanyakan hasil pada
 * tool yang sama sama saja dengan tidak memverifikasi.
 *
 * Kontrak verifier:
 *   async (args, result) => { checks: [{name, passed, detail}] }
 *
 * Verifier TIDAK boleh melempar. Kegagalan memeriksa berarti
 * "tidak terverifikasi", bukan "operasi gagal" — membedakan
 * keduanya penting supaya Damar tidak melapor palsu ke dua arah.
 */

const check = (name, passed, detail = null) => ({ name, passed, detail });

function sha256(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

// Ekstraksi jalur memakai satu sumber bersama di pathPolicy —
// dua daftar kunci yang terpisah pasti menyimpang diam-diam.
const { pathFrom: pathOf } = require("../safety/pathPolicy");

const VERIFIERS = {

    // ---- Berkas: paling jelas dapat dibuktikan --------------------

    "filesystem.writeFile": async (args) => {

        const p = pathOf(args, "path", "file", "filePath");
        if (!p) return { checks: [check("jalur terbaca", false, "argumen path tidak ditemukan")] };

        const checks = [];

        const exists = fs.existsSync(p);
        checks.push(check("berkas ada", exists, p));

        if (exists) {
            const st = fs.statSync(p);
            checks.push(check("ukuran > 0", st.size > 0, `${st.size} byte`));

            // Bila isi yang diminta diketahui, buktikan isinya cocok —
            // bukan sekadar ada berkas dengan nama itu.
            const wanted = args?.content ?? args?.data;
            if (typeof wanted === "string") {
                const actual = fs.readFileSync(p);
                const same = sha256(actual) === sha256(Buffer.from(wanted));
                checks.push(check("isi cocok", same, same ? "hash sama" : "hash berbeda"));
            }
        }

        return { checks };

    },

    "filesystem.createDirectory": async (args) => {

        const p = pathOf(args, "path", "dir", "directory");
        if (!p) return { checks: [check("jalur terbaca", false)] };

        const ok = fs.existsSync(p) && fs.statSync(p).isDirectory();
        return { checks: [check("direktori ada", ok, p)] };

    },

    "filesystem.deleteFile": async (args) => {

        const p = pathOf(args, "path", "file", "filePath");
        if (!p) return { checks: [check("jalur terbaca", false)] };

        // Untuk penghapusan, bukti keberhasilan adalah KETIADAAN.
        const gone = !fs.existsSync(p);
        return { checks: [check("berkas sudah tidak ada", gone, p)] };

    },

    "filesystem.copyFile": async (args) => {

        const dst = pathOf(args, "destination", "dest", "to", "target");
        if (!dst) return { checks: [check("jalur tujuan terbaca", false)] };

        const checks = [check("salinan ada", fs.existsSync(dst), dst)];

        const src = pathOf(args, "source", "src", "from");
        if (src && fs.existsSync(src) && fs.existsSync(dst)) {
            const same = sha256(fs.readFileSync(src)) === sha256(fs.readFileSync(dst));
            checks.push(check("isi identik dengan sumber", same));
        }

        return { checks };

    },

    "filesystem.moveFile": async (args) => {

        const src = pathOf(args, "source", "src", "from");
        const dst = pathOf(args, "destination", "dest", "to", "target");

        const checks = [];
        if (dst) checks.push(check("tujuan ada", fs.existsSync(dst), dst));
        // Pindah berarti sumber TIDAK boleh tersisa.
        if (src) checks.push(check("sumber sudah pindah", !fs.existsSync(src), src));

        return { checks: checks.length ? checks : [check("jalur terbaca", false)] };

    },

    // ---- Memori: klaim "sudah diingat" harus dapat dipanggil ulang

    "damarSkills.remember": async (args, result) => {

        const text = args?.content ?? args?.text ?? args?.fact;
        if (!text) return { checks: [check("isi memori terbaca", false)] };

        try {
            const memory = require("../../memory/services/MemoryService");
            const found = await memory.recall(String(text).slice(0, 60), { limit: 5 });
            const items = found?.items ?? found ?? [];
            const hit = Array.isArray(items) && items.length > 0;

            // Bukti sebenarnya: memori dapat DITEMUKAN KEMBALI,
            // bukan sekadar operasi simpan mengembalikan sukses.
            return { checks: [check("dapat dipanggil ulang", hit, `${items.length} hasil`)] };
        }
        catch (e) {
            return { checks: [check("dapat dipanggil ulang", false, `recall gagal: ${e.message}`)] };
        }

    },

    // ---- Dunia fisik: baca ulang keadaan perangkat ---------------
    //
    // "Lampu sudah dinyalakan" hanya berarti perintah terkirim.
    // Bukti sebenarnya adalah perangkatnya MELAPOR menyala — dibaca
    // lewat jalur berbeda (getState), bukan dari balikan perintah.

    "damarSkills.device_on":     (args) => deviceState(args, "on"),
    "damarSkills.device_off":    (args) => deviceState(args, "off"),
    "damarSkills.home_control":  (args) => deviceState(args, args?.action === "off" ? "off" : "on"),

    "damarSkills.device_toggle": async (args) => {

        // Toggle tidak punya keadaan akhir yang dapat diprediksi;
        // yang dapat dibuktikan hanya bahwa perangkatnya terbaca.
        const id = entityOf(args);
        if (!id) return { checks: [check("entitas terbaca", false)] };

        const now = await readState(id);

        return {
            checks: [check(
                "perangkat merespons",
                now.ok,
                now.ok ? `keadaan sekarang: ${now.state}` : now.error
            )]
        };

    },

    "damarSkills.set_temperature": async (args) => {

        const id = entityOf(args);
        const wanted = Number(args?.value ?? args?.temperature);

        if (!id || !Number.isFinite(wanted)) {
            return { checks: [check("entitas & nilai terbaca", false)] };
        }

        const now = await readState(id);

        if (!now.ok) {
            return { checks: [check("perangkat merespons", false, now.error)] };
        }

        const actual = Number(now.attributes?.temperature);

        return {
            checks: [check(
                "suhu sesuai permintaan",
                Number.isFinite(actual) && Math.abs(actual - wanted) < 0.6,
                `diminta ${wanted}, terbaca ${Number.isFinite(actual) ? actual : "—"}`
            )]
        };

    },

    // ---- Pesan: bukti diterima, bukan sekadar dikirim ------------

    "damarSkills.wa_send":     (args, result) => messageSent(result),
    "damarSkills.wa_broadcast": (args, result) => messageSent(result),
    "damarSkills.wa_notify_owner": (args, result) => messageSent(result),
    "whatsapp_send_photo":      (args, result) => messageSent(result),
    "whatsapp_send_document":   (args, result) => messageSent(result),
    "whatsapp_send_sticker":    (args, result) => messageSent(result),

    // ---- HTTP: status yang diklaim harus masuk akal --------------

    "http.get": async (args, result) => httpCheck(result),
    "http.post": async (args, result) => httpCheck(result),
    "http.put": async (args, result) => httpCheck(result),
    "http.patch": async (args, result) => httpCheck(result),
    "http.download": async (args, result) => {

        const checks = httpCheck(result).checks;
        const p = pathOf(args, "path", "destination", "output", "to");

        if (p) {
            const ok = fs.existsSync(p);
            checks.push(check("berkas unduhan ada", ok, p));
            if (ok) checks.push(check("ukuran > 0", fs.statSync(p).size > 0));
        }

        return { checks };

    },

    // ---- Git: repositori yang bicara, bukan tool ------------------
    //
    // Di sinilah "keluaran tool bukan bukti" paling nyata. `restore()`
    // menelan kegagalan git (`.catch(() => {})`) lalu tetap
    // mengembalikan `{ restored: [...] }` — rollback yang gagal total
    // tetap terbaca berhasil. Verifier ini bertanya pada git secara
    // langsung, lewat proses terpisah dari tool.

    "code_commit": async (args, result) => {

        const project = repoOf(args);
        const checks = [];

        // Tool sendiri sudah mengaku gagal — hormati pengakuan itu.
        const claimed = result?.committed ?? result?.data?.committed;
        if (claimed === false) {
            return { checks: [check("tool mengaku commit gagal", false, String(result?.out ?? "").slice(0, 200))] };
        }

        const head = git(["log", "-1", "--pretty=%H%x1f%s"], project);

        if (head === null) {
            return { checks: [check("git dapat dibaca", false, "git tidak merespons di " + project)] };
        }

        const [sha, subject] = head.split("\x1f");

        checks.push(check("HEAD menunjuk commit", Boolean(sha), sha?.slice(0, 8)));

        // Pesan yang diminta harus benar-benar menjadi pesan commit
        // teratas; kalau tidak, yang terlihat mungkin commit lama.
        const wanted = args?.message;
        if (typeof wanted === "string" && wanted.trim()) {
            const baris = wanted.split("\n")[0].trim();
            checks.push(check(
                "pesan commit cocok",
                subject === baris,
                subject === baris ? baris : `HEAD: "${subject}" ≠ diminta: "${baris}"`
            ));
        }

        // Setelah `git add -A` + commit, tidak boleh ada sisa yang
        // ter-stage. Sisa berarti commit tidak mencakup semuanya.
        const staged = git(["diff", "--cached", "--name-only"], project);
        if (staged !== null) {
            checks.push(check(
                "tidak ada sisa ter-stage",
                staged === "",
                staged === "" ? null : staged.split("\n").slice(0, 5).join(", ")
            ));
        }

        return { checks };

    },

    "code_rollback": async (args) => {

        const project = repoOf(args);

        const files = Array.isArray(args?.files) && args.files.length
            ? args.files
            : ["."];

        const sisa = git(["status", "--porcelain", "--", ...files], project);

        if (sisa === null) {
            return { checks: [check("git dapat dibaca", false, "git tidak merespons di " + project)] };
        }

        // Berkas yang belum terlacak tidak dipulihkan oleh
        // `git checkout --`, jadi keberadaannya bukan tanda gagal.
        const berubah = sisa
            .split("\n")
            .filter(b => b.trim() && !b.startsWith("??"));

        return {
            checks: [check(
                "berkas kembali seperti HEAD",
                berubah.length === 0,
                berubah.length ? berubah.slice(0, 5).join(", ") : "tidak ada selisih"
            )]
        };

    },

    "code_branch": async (args, result) => {

        const project = repoOf(args);

        if (result?.ok === false) {
            return { checks: [check("tool mengaku gagal", false, result?.note ?? null)] };
        }

        const now = git(["rev-parse", "--abbrev-ref", "HEAD"], project);

        if (now === null) {
            return { checks: [check("git dapat dibaca", false, "git tidak merespons di " + project)] };
        }

        // Nama dibersihkan di dalam tool; bandingkan dengan yang
        // dilaporkannya, lalu jatuh ke argumen bila tak ada.
        const wanted = result?.branch ?? result?.data?.branch ?? args?.name;

        return {
            checks: [check(
                "berada di branch yang diminta",
                Boolean(wanted) && now === String(wanted),
                `HEAD di "${now}"${wanted ? `, diminta "${wanted}"` : ""}`
            )]
        };

    }

};

/**
 * Tanya git secara langsung.
 *
 * Jalur yang berbeda dari tool yang sedang diperiksa — menanyakan
 * hasil pada tool yang sama sama saja dengan tidak memverifikasi.
 * Mengembalikan `null` bila git tak dapat dijalankan, sehingga
 * "tidak dapat diperiksa" tidak tertukar dengan "terbukti gagal".
 */
function git(argv, project) {

    try {

        return require("node:child_process")
            .execFileSync("git", argv, {
                cwd: project,
                encoding: "utf8",
                timeout: 5000,
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true
            })
            .trim();

    }
    catch {
        return null;
    }

}

function repoOf(args) {
    return args?.project ?? args?.cwd ?? args?.path ?? process.cwd();
}

/** Ambil id entitas dari argumen dengan nama yang bervariasi. */
function entityOf(args) {
    return args?.entity_id ?? args?.entityId ?? args?.entity ?? args?.device ?? null;
}

/**
 * Baca keadaan perangkat dari Home Assistant.
 *
 * Kegagalan menghubungi HA dikembalikan sebagai `ok:false`, BUKAN
 * dilempar — supaya Verification Engine dapat membedakan "tidak
 * dapat diverifikasi" dari "terbukti gagal". Menyamakan keduanya
 * akan menuduh perintah yang sebenarnya berhasil.
 */
async function readState(entityId) {

    try {
        const home = require("../../services/homeService");
        const st = await home.getState(entityId);

        if (!st) return { ok: false, error: "entitas tidak ditemukan" };

        return {
            ok: true,
            state: st.state ?? st.value ?? "?",
            attributes: st.attributes ?? {}
        };
    }
    catch (e) {
        return { ok: false, error: `Home Assistant tak terjangkau: ${e.message}` };
    }

}

async function deviceState(args, expected) {

    const id = entityOf(args);

    if (!id) {
        return { checks: [check("entitas terbaca", false, "argumen entity_id tidak ditemukan")] };
    }

    const now = await readState(id);

    if (!now.ok) {
        // Tak terjangkau ≠ gagal. Satu pemeriksaan yang tidak lulus
        // akan membuat state "failed"; di sini yang benar adalah
        // membiarkan engine menandainya belum terverifikasi.
        return { checks: [] };
    }

    return {
        checks: [check(
            `perangkat melapor "${expected}"`,
            String(now.state).toLowerCase() === expected,
            `terbaca: ${now.state}`
        )]
    };

}

/** Pesan dianggap terkirim hanya bila ada id dari WhatsApp. */
function messageSent(result) {

    const data = result?.data ?? result;
    const ids = data?.messageIds ?? data?.result?.messageIds;
    const errors = data?.errors ?? data?.result?.errors;

    if (Array.isArray(errors) && errors.length) {
        return {
            checks: [check("terkirim tanpa error", false, errors.join("; "))]
        };
    }

    if (!Array.isArray(ids)) {
        // Tool lama belum melaporkan id — jangan mengklaim terkirim.
        return { checks: [] };
    }

    return {
        checks: [check(
            "WhatsApp mengembalikan id pesan",
            ids.length > 0,
            ids.length ? `${ids.length} pesan` : "tidak ada id — pesan mungkin tidak sampai"
        )]
    };

}

function httpCheck(result) {

    const status = result?.status ?? result?.statusCode ?? result?.data?.status;

    if (status == null) {
        return { checks: [check("status HTTP terbaca", false, "tidak ada status di hasil")] };
    }

    return {
        checks: [check("status HTTP 2xx/3xx", status >= 200 && status < 400, `HTTP ${status}`)]
    };

}

/** Verifier untuk sebuah tool, atau null bila belum ada. */
function verifierFor(id) {
    return VERIFIERS[id] ?? null;
}

module.exports = { verifierFor, VERIFIERS };
