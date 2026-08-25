const crypto = require("node:crypto");

const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

const telemetry = require("../services/telemetryService");

/**
 * DeviceRegistry — daftar device tertaut (companion) yang boleh memakai
 * tools & skill Aether lewat jaringan (LAN / Bluetooth PAN).
 *
 * Tiap device punya KREDENSIAL SENDIRI (token acak) — bukan token utama
 * AETHER_TOKEN — sehingga bisa dicabut per device tanpa mengganggu yang
 * lain. Ini meniru model "device pairing" yang sudah dikenal (seperti
 * login multi-perangkat WhatsApp).
 *
 * Device = client TIPIS: ia memakai MCP/REST yang sudah ada; registri ini
 * hanya mengelola siapa yang diizinkan, kapan terakhir terlihat, dan
 * kredensialnya.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "companions.json"),
    { devices: [] }
);

/** Token acak panjang (URL-safe, tanpa karakter ambigu). */
function newToken(bytes = 24) {

    return crypto.randomBytes(bytes).toString("base64url");

}

/** Kode pairing 6 digit (tanpa 0/1 agar mudah dibaca). */
function newPairingCode() {

    const digits = "23456789";

    let code = "";

    for (let i = 0; i < 6; i++) {
        code += digits[crypto.randomInt(digits.length)];
    }

    return code;

}

class DeviceRegistry {

    constructor(storeInstance = store) {
        this.store = storeInstance;
    }

    all() {
        return this.store.read().devices ?? [];
    }

    get(id) {
        return this.all().find(d => d.id === id) ?? null;
    }

    /** Buat device baru + token. Belum "aktif" sampai pairing disetujui. */
    create({ name, kind = "device" } = {}) {

        const device = {
            id: crypto.randomUUID(),
            name: String(name ?? "device").slice(0, 60),
            kind: String(kind ?? "device"),
            token: newToken(),
            createdAt: new Date().toISOString(),
            lastSeenAt: null,
            // Izin tool: null = semua (tunduk toolGuard/safety), atau array id.
            allowedTools: null,
            revoked: false
        };

        this.store.write({ devices: [...this.all(), device] });

        telemetry.publish("companion:registered", { id: device.id, name: device.name });

        return device;

    }

    /** Tandai device terlihat (update lastSeenAt). */
    touch(id) {

        const devices = this.all();

        const device = devices.find(d => d.id === id);

        if (!device) return null;

        device.lastSeenAt = new Date().toISOString();

        this.store.write({ devices });

        return device;

    }

    /** Verifikasi token device. Mengembalikan device atau null. */
    authenticate(token) {

        if (!token) return null;

        return this.all().find(d => d.token === token && !d.revoked) ?? null;

    }

    /** Cabut device (revoke) — token tak lagi berlaku. */
    revoke(id) {

        const devices = this.all();

        const device = devices.find(d => d.id === id);

        if (!device) return false;

        device.revoked = true;

        this.store.write({ devices });

        telemetry.publish("companion:revoked", { id });

        return true;

    }

    /** Setel izin tool device (null = semua). */
    setAllowedTools(id, allowedTools) {

        const devices = this.all();

        const device = devices.find(d => d.id === id);

        if (!device) return null;

        device.allowedTools = allowedTools === null ? null : (Array.isArray(allowedTools) ? allowedTools : null);

        this.store.write({ devices });

        return device;

    }

    /** Daftar publik (tanpa token) untuk status/kendali. */
    publicList() {

        return this.all().map(d => ({
            id: d.id,
            name: d.name,
            kind: d.kind,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
            allowedTools: d.allowedTools,
            revoked: d.revoked
        }));

    }

}

module.exports = { DeviceRegistry, newToken, newPairingCode };
