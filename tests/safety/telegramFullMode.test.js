const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const totp = require("../../src/core/auth/totp");

/**
 * Mode penuh Telegram via TOTP.
 *
 * Yang dijaga: default terbatas (user), /totp setup membuat secret,
 * /masuk <kode benar> → mode penuh (superadmin), /masuk <kode salah>
 * → tetap terbatas, /keluar → kembali terbatas, TTL kedaluwarsa.
 *
 * TelegramService singleton memakai configs/telegram.json & totp.json
 * di repo. Untuk tes, file di-arahkan ke tmp via DAMAR_TOTP_CONFIG
 * kalau ada — tapi modul sudah require saat awal. Solusi: tes logika
 * lewat instance baru dengan store diisolasi.
 */

/** Buat instance TelegramService terisolasi (config tmp, tak menyalakan polling). */
function makeIsolated() {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-totp-"));

    // Tulis config kosong.
    fs.writeFileSync(path.join(dir, "telegram.json"), JSON.stringify({ token: "dummy", allowed: ["12345"] }));
    fs.writeFileSync(path.join(dir, "totp.json"), JSON.stringify({}));

    // Patch env supai JsonStore baca config di tmp — TAPI modul singleton
    // sudah meng-cache path. Solusi minim: muat ulang modul dengan cache
    // dihapus dan path di-override lewat env.
    delete require.cache[require.resolve("../../src/services/telegramService")];

    // Simpan & override config path lewat env DAMAR_TOTP_CONFIG.
    process.env.DAMAR_TOTP_CONFIG = path.join(dir, "totp.json");

    const svc = require("../../src/services/telegramService");

    // Override totpStore path lewat reflection (pribadi, tapi minim):
    // gunakan write langsung ke file totp.json yang sudah kita pasang.
    svc._totpFile = path.join(dir, "totp.json");

    // Helper: tulis secret ke totp.json (sekarang via svc internal store).
    svc._setTotpSecret = (secret) => {
        fs.writeFileSync(svc._totpFile, JSON.stringify({ secret, setupAt: new Date().toISOString() }));
        // JsonStore meng-cache; matikan cache-nya.
        try { delete require.cache[require.resolve("../../src/core/config/JsonStore")]; } catch {}
    };

    // Pakai konfigurasi allowlist + token dummy.
    svc.allowedIds = () => new Set(["12345"]);
    svc.resolveToken = () => "dummy";
    // Cegah panggilan API nyata: tangkap pesan yang akan dikirim.
    svc._sent = [];
    svc.send = async (chatId, text) => { svc._sent.push({ chatId, text }); };

    return { svc, dir };
}

test("default: chat yang di-allow tetap mode TERBATAS (bukan superadmin)", () => {
    const { svc } = makeIsolated();
    assert.equal(svc.inFullMode("12345"), false, "chat allowlist tanpa /masuk harus terbatas");
});

test("/totp setup membuat secret baru & mengirim URL otpauth", async () => {
    const { svc } = makeIsolated();
    // Baca store asli untuk konfirmasi secret tersimpan.
    const handled = await svc.handleFullModeCommand("12345", "/totp setup");
    assert.equal(handled, true);
    assert.equal(svc._sent.length, 1);
    assert.match(svc._sent[0].text, /otpauth:\/\/totp\//);
    assert.match(svc._sent[0].text, /secret=/);
});

test("/masuk <kode salah> → tetap terbatas, pesan kesalahan", async () => {
    const { svc } = makeIsolated();
    // Pasang secret valid.
    const { secret } = totp.generateSecret({ account: "12345" });
    svc._setTotpSecret(secret);

    const handled = await svc.handleFullModeCommand("12345", "/masuk 000000");
    assert.equal(handled, true);
    assert.equal(svc.inFullMode("12345"), false, "kode salah tidak boleh membuka mode penuh");
    assert.match(svc._sent[0].text, /salah|kedaluwarsa/i);
});

test("/masuk <kode benar> → mode penuh aktif", async () => {
    const { svc } = makeIsolated();
    const { secret } = totp.generateSecret({ account: "12345" });
    svc._setTotpSecret(secret);

    const kode = totp.currentCode(secret);
    const handled = await svc.handleFullModeCommand("12345", `/masuk ${kode}`);
    assert.equal(handled, true);
    assert.equal(svc.inFullMode("12345"), true, "kode benar harus membuka mode penuh");
    assert.match(svc._sent[0].text, /mode penuh aktif/i);
});

test("/keluar menutup mode penuh lebih awal", async () => {
    const { svc } = makeIsolated();
    const { secret } = totp.generateSecret();
    svc._setTotpSecret(secret);

    const kode = totp.currentCode(secret);
    await svc.handleFullModeCommand("12345", `/masuk ${kode}`);
    assert.equal(svc.inFullMode("12345"), true);

    const handled = await svc.handleFullModeCommand("12345", "/keluar");
    assert.equal(handled, true);
    assert.equal(svc.inFullMode("12345"), false);
});

test("mode penuh kedaluwarsa setelah TTL", async () => {
    const { svc } = makeIsolated();
    const { secret } = totp.generateSecret();
    svc._setTotpSecret(secret);

    const kode = totp.currentCode(secret);
    await svc.handleFullModeCommand("12345", `/masuk ${kode}`);
    assert.equal(svc.inFullMode("12345"), true);

    // Majukan waktu: set expiry ke masa lalu.
    svc.fullModeUntil.set("12345", Date.now() - 1000);
    assert.equal(svc.inFullMode("12345"), false, "harus otomatis kedaluwarsa");
});

test("/masuk tanpa secret → arahkan /totp setup", async () => {
    const { svc } = makeIsolated();
    // Tidak set secret.
    const handled = await svc.handleFullModeCommand("12345", "/masuk 123456");
    assert.equal(handled, true);
    assert.match(svc._sent[0].text, /totp setup/i);
});

test("pesan non-perintah tidak dikonsumsi oleh handleFullModeCommand", async () => {
    const { svc } = makeIsolated();
    const handled = await svc.handleFullModeCommand("12345", "halo damar");
    assert.equal(handled, false, "pesan biasa harus lanjut ke converse");
});
