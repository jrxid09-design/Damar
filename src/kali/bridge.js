const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const sandbox = require("../core/safety/codeSandbox");

const pexec = promisify(execFile);

/**
 * bridge — satu-satunya jalur Aether menjalankan Kali Linux.
 *
 * Kali di mesin Windows hidup sebagai distro WSL; di mesin Linux ia
 * mungkin sistem itu sendiri. Modul ini menyembunyikan perbedaan itu:
 * pemanggil cukup memberi perintah, bridge memutuskan `wsl.exe -d
 * kali-linux -- bash -lc "<perintah>"` atau bash lokal.
 *
 * Bukan pintu tanpa pagar: perintah tetap tunduk pada disiplin
 * keamanan (otorisasi target luar milik pemilik) dan kebijakan risiko
 * — kali_run diperlakukan destruktif seperti terminal_run.
 */

const WSL = process.platform === "win32"
    ? `${process.env.SystemRoot || "C:\\Windows"}\\System32\\wsl.exe`
    : "wsl.exe";

let _distro;                                    // cache hasil deteksi ("" = sudah dicari, tak ada)

/** Bersihkan keluaran `wsl -l` (UTF-16 + byte kendali) jadi baris rapi. */
function baris(buf) {
    return String(buf)
        .replace(/\u0000/g, "")
        .split(/\r?\n/)
        .map(s => s.replace(/[^\x20-\x7e]/g, "").trim())
        .filter(Boolean);
}

/**
 * Nama distro Kali. Urutan: paksaan env → distro WSL yang cocok /kali/.
 * Dicache karena `wsl -l` lambat dan jawabannya tak berubah dalam sesi.
 */
async function distro() {

    if (_distro !== undefined) return _distro || null;

    if (process.env.AETHER_KALI_DISTRO) return (_distro = process.env.AETHER_KALI_DISTRO);

    if (process.platform !== "win32") return (_distro = "");   // Linux: jalankan lokal

    try {
        const { stdout } = await pexec(WSL, ["-l", "-q"], { windowsHide: true, timeout: 15000 });
        const kali = baris(stdout).find(n => /kali/i.test(n));
        return (_distro = kali || "");
    }
    catch {
        return (_distro = "");
    }

}

/** Apakah Kali bisa dijalankan di mesin ini sekarang. */
async function available() {
    if (process.platform !== "win32") {
        // Linux: anggap tersedia bila `bash` ada — deteksi ringan.
        try { await pexec("bash", ["-lc", "true"], { timeout: 8000 }); return true; }
        catch { return false; }
    }
    return !!(await distro());
}

/**
 * Jalankan satu perintah DI DALAM Kali.
 *
 * Rahasia daemon TIDAK diwariskan ke proses (sandbox.env) — satu tool
 * yang membaca AETHER_TOKEN dari environment cukup untuk membocorkannya.
 * Login-shell (`bash -lc`) dipakai agar PATH tool Kali (/usr/bin,
 * /usr/sbin, dan paket apt) termuat.
 */
async function run(command, { timeout = 300000, cwd } = {}) {

    if (!command || !String(command).trim()) return { ok: false, error: "Perintah kosong." };

    const d = await distro();
    if (process.platform === "win32" && !d) {
        return { ok: false, error: "Distro Kali WSL tak ditemukan. Pasang: `wsl --install -d kali-linux`, atau set AETHER_KALI_DISTRO." };
    }

    const script = cwd ? `cd ${shq(cwd)} && ${command}` : command;

    const args = process.platform === "win32"
        ? ["-d", d, "-e", "bash", "-lc", script]
        : ["-lc", script];
    const bin = process.platform === "win32" ? WSL : "bash";

    const opts = { ...sandbox.options({ timeout }), maxBuffer: 32 * 1024 * 1024 };

    try {
        const { stdout, stderr } = await pexec(bin, args, opts);
        return { ok: true, code: 0, stdout: potong(stdout), stderr: potong(stderr) };
    }
    catch (e) {
        // Kode keluar ≠ 0 sering bermakna (mis. nmap host down) — bukan
        // kegagalan bridge. Kembalikan apa adanya, jangan mengarang sebab.
        if (typeof e.code === "number") {
            return { ok: false, code: e.code, stdout: potong(e.stdout), stderr: potong(e.stderr) };
        }
        return { ok: false, error: (e.stderr || e.message || "").toString().slice(-2000) };
    }

}

/** Path sebuah tool di dalam Kali, atau null bila tak terpasang. */
async function which(tool) {
    const t = String(tool).replace(/[^\w.-]/g, "");
    if (!t) return null;
    const r = await run(`command -v ${t} || true`, { timeout: 20000 });
    const path = (r.stdout || "").trim().split(/\r?\n/)[0];
    return path && path.startsWith("/") ? path : null;
}

/** Tool arsenal inti yang paling sering dipakai, dikelompokkan per tugas. */
const ARSENAL = {
    "pemetaan-jaringan": ["nmap", "masscan", "netdiscover", "arp-scan"],
    "web": ["nikto", "gobuster", "ffuf", "sqlmap", "wpscan", "whatweb", "dirb"],
    "kata-sandi": ["hydra", "john", "hashcat", "medusa", "crunch"],
    "nirkabel": ["aircrack-ng", "reaver", "kismet", "wifite"],
    "eksploitasi": ["msfconsole", "searchsploit", "setoolkit"],
    "rekayasa-balik": ["radare2", "ghidra", "gdb", "binwalk", "strings"],
    "forensik": ["vol", "foremost", "autopsy", "exiftool", "yara"],
    "osint": ["theharvester", "amass", "recon-ng", "spiderfoot"],
    "sniffing-mitm": ["wireshark", "tcpdump", "bettercap", "ettercap", "responder"],
    "ad": ["crackmapexec", "bloodhound", "impacket-secretsdump", "evil-winrm"]
};

/** Tool mana yang benar-benar terpasang (satu panggilan, di dalam Kali). */
async function tools() {
    const semua = [...new Set(Object.values(ARSENAL).flat())];
    const cek = semua.map(t => `command -v ${t} >/dev/null 2>&1 && echo "${t} OK" || echo "${t} --"`).join("; ");
    const r = await run(cek, { timeout: 60000 });
    if (!r.ok && r.error) return { ok: false, error: r.error };

    const status = {};
    for (const line of (r.stdout || "").split(/\r?\n/)) {
        const m = /^(\S+) (OK|--)$/.exec(line.trim());
        if (m) status[m[1]] = m[2] === "OK";
    }
    const terpasang = Object.entries(status).filter(([, v]) => v).map(([k]) => k);

    return {
        ok: true,
        terpasang,
        hilang: semua.filter(t => !status[t]),
        jumlah: `${terpasang.length}/${semua.length} tool arsenal terpasang`,
        kategori: ARSENAL
    };
}

/** Ringkas kesiapan Kali untuk introspeksi/UI. */
async function status() {
    const d = await distro();
    const ada = await available();
    if (!ada) return { available: false, distro: d || null, note: "Kali tak tersedia di mesin ini." };
    const rel = await run("cat /etc/os-release 2>/dev/null | head -2 || uname -a", { timeout: 20000 });
    return { available: true, distro: d || "(lokal)", release: (rel.stdout || "").trim() };
}

/** Kutip aman untuk konteks bash (dipakai hanya untuk cwd, bukan perintah). */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function potong(s) { return String(s ?? "").slice(-12000); }

module.exports = { available, distro, run, which, tools, status, ARSENAL };
