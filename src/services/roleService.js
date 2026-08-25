const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

/**
 * Peran pengguna Aether (ditegakkan pada jalur WhatsApp).
 *
 *   superadmin — kendali penuh tanpa batas (pemilik).
 *   admin      — operasional harian; TAK bisa ubah konfigurasi inti
 *                / kelola skill / tool sistem berbahaya.
 *   user       — anggota grup; asisten AI pribadi (chat + tool aman saja).
 *
 * Console & CLI berjalan lokal di mesin pemilik → selalu superadmin
 * (tak lewat penegakan ini). Nomor disimpan lokal (gitignored).
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "roles.json"),
    { superadmins: [], admins: [] }
);

// Tool yang HANYA boleh superadmin: kelola skill + tool sistem berbahaya.
const SUPERADMIN_ONLY =
    /create_tool|activate_tool|remove_tool|skill_build|filesystem|docker|run.?command|capture.?screen|terminal_|__write|__delete|__remove/i;

// Tool aman untuk user umum (allowlist). Selain ini, user hanya chat biasa.
const USER_ALLOWED =
    /memory_recall|(^|_|__)recall$|describe_image|translate|smart_reply|summarize|currentWeather|weather|currentTime|(^|__)time|calculator|home_brief|full_context|system_health/i;

const digits = v => String(v ?? "").replace(/\D/g, "");

class RoleService {

    read() {
        return store.read();
    }

    /** Peran untuk sebuah nomor. Default aman-kompatibel: bila belum ada
     *  superadmin terdaftar, semua yang diizinkan = superadmin (perilaku lama). */
    roleOf(number) {
        const n = digits(number);
        const { superadmins = [], admins = [] } = store.read();

        // FAIL-CLOSED (temuan C5): install kosong TIDAK lagi otomatis
        // superadmin untuk jalur kanal. Pemilik naik peran lewat
        // /masuk (TOTP) atau configs/roles.json. Permukaan lokal milik
        // pemilik (Console/CLI) menyatakan perannya sendiri secara
        // eksplisit — bukan implisit dari keadaan kosong.
        if (superadmins.length === 0) return "user";
        if (superadmins.map(digits).includes(n)) return "superadmin";
        if (admins.map(digits).includes(n)) return "admin";
        return "user";
    }

    /** Saring daftar AITool sesuai peran. */
    toolsFor(role, tools = []) {
        if (role === "superadmin") return tools;
        return tools.filter(t => this.allows(role, t.name));
    }

    /**
     * Predikat kelayakan satu tool untuk satu peran.
     *
     * Dipakai pipeline seleksi (ai/tools/Pipeline.js) sebagai PAGAR
     * sebelum ranking — bukan lagi penyaring daftar penuh di kanal.
     * Aturan sama dengan toolsFor; kini bisa dinilai per tool tanpa
     * harus menyentuh seluruh registry.
     */
    allows(role, name = "") {
        // Fail-closed: peran hilang/kosong BUKAN izin penuh.
        if (!role) return false;
        if (role === "system") return true;          // otoritas internal eksplisit
        if (role === "superadmin") return true;
        if (role === "admin") return !SUPERADMIN_ONLY.test(name);
        return USER_ALLOWED.test(name);   // user
    }

    setConfig({ superadmins, admins } = {}) {
        const cur = store.read();
        store.write({
            superadmins: superadmins !== undefined ? this.parse(superadmins) : cur.superadmins,
            admins: admins !== undefined ? this.parse(admins) : cur.admins
        });
        return this.describe();
    }

    parse(value) {
        if (Array.isArray(value)) return value.map(digits).filter(Boolean);
        return String(value ?? "").split(",").map(digits).filter(Boolean);
    }

    describe() {
        const { superadmins = [], admins = [] } = store.read();
        return { superadmins, admins, enforced: superadmins.length > 0 };
    }

}

module.exports = new RoleService();
