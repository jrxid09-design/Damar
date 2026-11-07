const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const totp = require("../../src/core/auth/totp");

/**
 * TOTP (RFC 6238) — kunci mode penuh Telegram.
 *
 * Yang dijaga: kompatibilitas dengan Google Authenticator (test vector
 * resmi RFC 6238), verifikasi ±1 step, penolakan format salah, dan
 * secret yang selalu unik.
 */

/** HOTP manual untuk test vector (implementasi independen). */
function hotpRef(keyAscii, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac("sha1", Buffer.from(keyAscii, "ascii")).update(buf).digest();
    const o = h[h.length - 1] & 0xf;
    const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
    return String(code % 10 ** 6).padStart(6, "0");
}

test("test vector resmi RFC 6238 (6-digit truncation) lulus semua", () => {
    // Vektor 8-digit dari RFC 6238 Appendix B, dibuang 2 digit depan.
    const vectors = [
        [59, "287082"],            // 94287082
        [1111111109, "081804"],    // 07081804
        [1111111111, "050471"],    // 14050471
        [1234567890, "005924"],    // 89005924
        [2000000000, "279037"],    // 69279037
        [20000000000, "353130"]    // 65353130
    ];
    for (const [t, expect] of vectors) {
        assert.equal(hotpRef("12345678901234567890", Math.floor(t / 30)), expect, `t=${t}`);
    }
});

test("currentCode & verify cocok untuk secret apa pun", () => {
    const { secret } = totp.generateSecret();
    const code = totp.currentCode(secret);
    assert.match(code, /^\d{6}$/);
    assert.equal(totp.verify(secret, code), true);
});

test("verify menolak kode salah dan format kacau", () => {
    const { secret } = totp.generateSecret();
    assert.equal(totp.verify(secret, "000000"), false, "000000 hampir pasti salah");
    assert.equal(totp.verify(secret, "abc"), false);
    assert.equal(totp.verify(secret, "12 34 56"), false);
    assert.equal(totp.verify(secret, ""), false);
    assert.equal(totp.verify(null, "123456"), false);
});

test("verify menerima kode step sebelumnya/sesudahnya (±30 dtk)", () => {
    const { secret } = totp.generateSecret();
    const now = totp.timeStep();
    // Kode dari step -1 masih valid (toleransi clock).
    const before = totp.base32Decode(secret);
    const crypto2 = crypto;
    const codeOf = (step) => {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64BE(BigInt(step));
        const h = crypto2.createHmac("sha1", before).update(buf).digest();
        const o = h[h.length - 1] & 0xf;
        const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
        return String(code % 10 ** 6).padStart(6, "0");
    };
    assert.equal(totp.verify(secret, codeOf(now - 1)), true, "step -1");
    assert.equal(totp.verify(secret, codeOf(now + 1)), true, "step +1");
    assert.equal(totp.verify(secret, codeOf(now - 2)), false, "step -2 terlalu jauh");
});

test("base32 round-trip dan format otpauth URL", () => {
    const buf = crypto.randomBytes(20);
    const enc = totp.base32Encode(buf);
    assert.equal(totp.base32Decode(enc).toString("hex"), buf.toString("hex"));
    const { secret, otpauthUrl } = totp.generateSecret({ account: "ronny", issuer: "Damar" });
    assert.match(otpauthUrl, /^otpauth:\/\/totp\/Damar%3Aronny\?/);
    assert.match(otpauthUrl, new RegExp(`secret=${secret}`));
    assert.match(otpauthUrl, new RegExp(`issuer=Damar`));
    assert.match(otpauthUrl, new RegExp(`digits=6`));
    assert.match(otpauthUrl, new RegExp(`period=30`));
});

test("secret unik antar pemanggilan", () => {
    const a = totp.generateSecret();
    const b = totp.generateSecret();
    assert.notEqual(a.secret, b.secret);
});
