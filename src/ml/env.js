const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const pexec = promisify(execFile);

/**
 * env — probe lingkungan ML/AI berbasis BUKTI.
 *
 * Insinyur ML yang baik tidak menebak apakah ada GPU, versi CUDA, atau
 * framework mana yang terpasang — ia memeriksa. Modul ini menjalankan
 * interpreter Python nyata dan melaporkan apa yang benar-benar ada,
 * supaya Aether tak pernah mengarang "training di GPU" di mesin yang
 * hanya punya CPU (§ integritas diagnosa).
 */

/** Kandidat pemanggil Python per-OS. `py -3` khas Windows. */
const KANDIDAT = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];

/** Skrip probe: satu keluaran JSON, tiap impor dibungkus try sendiri. */
const PROBE = [
    "import json,sys,importlib",
    "libs=['numpy','pandas','scipy','sklearn','torch','tensorflow','jax','transformers','datasets','accelerate','matplotlib','xgboost','lightgbm','onnxruntime']",
    "out={'python':sys.version.split()[0],'executable':sys.executable,'libs':{},'cuda':None}",
    "for L in libs:",
    "    try:",
    "        m=importlib.import_module(L); out['libs'][L]=getattr(m,'__version__','?')",
    "    except Exception: pass",
    "try:",
    "    import torch",
    "    out['cuda']={'available':torch.cuda.is_available(),'version':getattr(torch.version,'cuda',None),'devices':[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]}",
    "except Exception: pass",
    "print(json.dumps(out))"
].join("\n");

let _interp;                                    // cache [bin, preargs] pertama yang bekerja

/**
 * Interpreter Python pertama yang benar-benar jalan. Dicache: hasilnya
 * tetap sama sepanjang sesi, dan tiap deteksi men-spawn proses.
 */
async function interpreter() {
    if (_interp !== undefined) return _interp;
    for (const [bin, pre] of KANDIDAT) {
        try {
            await pexec(bin, [...pre, "-c", "import sys"], { timeout: 20000, windowsHide: true });
            return (_interp = [bin, pre]);
        }
        catch { /* coba kandidat berikutnya */ }
    }
    return (_interp = null);
}

/** Jalankan skrip dengan pemanggil pertama yang bekerja. */
async function jalankanPython() {
    const it = await interpreter();
    if (!it) return null;
    const [bin, pre] = it;
    try {
        const { stdout } = await pexec(bin, [...pre, "-c", PROBE], { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        const data = JSON.parse(stdout.trim().split(/\r?\n/).pop());
        return { bin: [bin, ...pre].join(" "), ...data };
    }
    catch { return null; }
}

/**
 * Jalankan kode/berkas Python DI LINGKUNGAN ML nyata (interpreter yang
 * sama dengan yang di-probe). Untuk eksperimen, training, dan evaluasi.
 *
 * Balikan { ok, code, seconds, stdout, stderr } — apa adanya. Kode
 * keluar ≠ 0 dikembalikan, bukan dilempar: kegagalan training adalah
 * DATA (stack trace, NaN loss), bukan alasan menyembunyikan keluaran.
 */
async function run({ code, file, cwd, timeout = 600000 } = {}) {

    const it = await interpreter();
    if (!it) return { ok: false, error: "Interpreter Python tak ditemukan (dicoba: " + KANDIDAT.map(k => k[0]).join(", ") + ")." };

    if (!code && !file) return { ok: false, error: "Beri `code` (potongan Python) atau `file` (path skrip)." };

    const [bin, pre] = it;
    const args = file ? [...pre, "-u", String(file)] : [...pre, "-u", "-c", String(code)];
    const opts = { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: cwd || undefined };

    const mulai = Date.now();
    try {
        const { stdout, stderr } = await pexec(bin, args, opts);
        return { ok: true, code: 0, seconds: +((Date.now() - mulai) / 1000).toFixed(1), stdout: potong(stdout), stderr: potong(stderr) };
    }
    catch (e) {
        const seconds = +((Date.now() - mulai) / 1000).toFixed(1);
        if (typeof e.code === "number") {
            return { ok: false, code: e.code, seconds, stdout: potong(e.stdout), stderr: potong(e.stderr) };
        }
        if (e.killed) return { ok: false, error: `Timeout ${timeout}ms terlewati`, seconds, stdout: potong(e.stdout), stderr: potong(e.stderr) };
        return { ok: false, error: (e.stderr || e.message || "").toString().slice(-2000), seconds };
    }

}

/** GPU tingkat OS (nvidia-smi) — independen dari framework Python. */
async function nvidia() {
    try {
        const { stdout } = await pexec(
            "nvidia-smi",
            ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
            { timeout: 15000, windowsHide: true }
        );
        return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    catch { return []; }
}

/**
 * Laporan lingkungan ML. Balikan { ok, python?, libs, cuda, gpu, catatan }.
 *
 * Ketiadaan Python BUKAN kegagalan Aether — dilaporkan apa adanya agar
 * pemilik tahu harus memasangnya, bukan diberi tebakan bahwa "torch
 * tidak terpasang" padahal interpreternya sendiri belum ada.
 */
async function probe() {

    const [py, gpu] = await Promise.all([jalankanPython(), nvidia()]);

    if (!py) {
        return {
            ok: false,
            python: null,
            gpu,
            catatan: "Interpreter Python tak ditemukan (dicoba: " + KANDIDAT.map(k => k[0]).join(", ") + "). Pasang Python 3 lalu ulangi."
        };
    }

    const terpasang = Object.keys(py.libs);
    const cudaSiap = py.cuda?.available === true;

    return {
        ok: true,
        interpreter: py.bin,
        python: py.python,
        executable: py.executable,
        frameworks: py.libs,
        cuda: py.cuda,
        gpu,
        catatan:
            `Python ${py.python}, ${terpasang.length} pustaka ML terpasang` +
            (terpasang.length ? ` (${terpasang.join(", ")})` : "") +
            (cudaSiap
                ? `. CUDA siap: ${py.cuda.devices.join(", ") || "GPU terdeteksi"}.`
                : gpu.length
                    ? `. GPU ada (${gpu[0]}) tetapi torch.cuda TIDAK aktif — jalur CUDA belum siap.`
                    : ". Tak ada GPU CUDA terdeteksi — anggap CPU-only kecuali terbukti lain.")
    };

}

function potong(s) { return String(s ?? "").slice(-14000); }

module.exports = { probe, run, interpreter };
