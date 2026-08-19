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
    /create_tool|activate_tool|remove_tool|filesystem|docker|run.?command|capture.?screen|terminal_|__write|__delete|__remove/i;

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
        if (superadmins.length === 0) return "superadmin";
        if (superadmins.map(digits).includes(n)) return "superadmin";
        if (admins.map(digits).includes(n)) return "admin";
        return "user";
    }

    /** Saring daftar AITool sesuai peran. */
    toolsFor(role, tools = []) {
        if (role === "superadmin") return tools;
        if (role === "admin") return tools.filter(t => !SUPERADMIN_ONLY.test(t.name));
        return tools.filter(t => USER_ALLOWED.test(t.name));   // user
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
