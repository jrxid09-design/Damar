const crypto = require("node:crypto");

/**
 * TOTP — Time-based One-Time Password (RFC 6238), kompatibel dengan
 * Google Authenticator dan aplikasi serupa.
 *
 * Implementasi murni node:crypto (HMAC-SHA1), tanpa dependensi
 * eksternal. Dipakai untuk mode penuh Telegram: pengguna masukkan
 * kode 6-digit dari app authenticator di HP-nya untuk membuka
 * kemampuan penuh Aether lewat Telegram — sama seperti Console.
 *
 *   generateSecret()  → secret base32 20-byte + otpauth:// URL
 *                       untuk QR code (scan dengan Google Authenticator)
 *   verify(token)     → true bila kode cocok (±1 step 30-detik)
 *   currentCode()    → kode saat ini (untuk testing/debug)
 *
 * Secret disimpan di configs/totp.json (terenkripsi-tidak; ia sudah
 * acak dan lokal. Lindungi akses berkasnya).
 */

const STEP = 30;          // detik per kode
const DIGITS = 6;
const WINDOW = 1;         // izinkan ±1 step (30 dtk toleransi)
const ALGO = "sha1";

/** Base32 encode (RFC 4648) — kompatibel Google Authenticator. */
function base32Encode(buf) {
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0, value = 0, out = "";
    for (const b of buf) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += ALPHA[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
    return out;
}

/** Base32 decode — untuk verifikasi dari secret tersimpan. */
function base32Decode(str) {
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0, value = 0, out = [];
    for (const ch of str.toUpperCase().replace(/=+$/, "")) {
        const idx = ALPHA.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/**
 * HOTP (RFC 4226) — inti TOTP. counter = integer 8-byte big-endian.
 */
function hotp(secretBytes, counter) {
    const buf = Buffer.alloc(8);
    // Tulis counter sebagai 64-bit big-endian (JS bit-shift aman sampai 32).
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac(ALGO, secretBytes).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    const padded = String(code % 10 ** DIGITS).padStart(DIGITS, "0");
    return padded;
}

/** Step TOTP saat ini (detik sejak epoch / STEP). */
function timeStep(ts = Date.now()) {
    return Math.floor(ts / 1000 / STEP);
}

/**
 * Verifikasi token 6-digit yang dimasukkan pengguna.
 * Menerima kode saat ini ±WINDOW step (toleransi clock ±30 detik).
 */
function verify(secret, token) {
    if (!secret || !token) return false;
    const clean = String(token).replace(/\s/g, "");
    if (!/^\d{6}$/.test(clean)) return false;
    const secretBytes = base32Decode(secret);
    const step = timeStep();
    for (let delta = -WINDOW; delta <= WINDOW; delta++) {
        if (hotp(secretBytes, step + delta) === clean) return true;
    }
    return false;
}

/** Kode TOTP saat ini (untuk testing/debug). */
function currentCode(secret) {
    return hotp(base32Decode(secret), timeStep());
}

/**
 * Buat secret baru (20 byte acak) + URL otpauth:// untuk QR code.
 *
 * URL ini bisa di-encode jadi QR (mis. pakai library `qrcode` atau
 * layanan online). Formatnya kompatibel Google Authenticator.
 */
function generateSecret({ account = "aether", issuer = "Aether" } = {}) {
    const raw = crypto.randomBytes(20);
    const secret = base32Encode(raw);
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: "SHA1",
        digits: String(DIGITS),
        period: String(STEP)
    });
    const otpauthUrl = `otpauth://totp/${label}?${params}`;
    return { secret, otpauthUrl, raw };
}

module.exports = {
    generateSecret,
    verify,
    currentCode,
    timeStep,
    base32Encode,
    base32Decode,
    STEP,
    DIGITS
};
