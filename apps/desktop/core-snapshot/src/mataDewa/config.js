/**
 * Konfigurasi & mode kredensial Mata Dewa.
 *
 * Hukum inti:
 *   CREDENTIAL AVAILABILITY ≠ CORE AVAILABILITY
 *   PROVIDER FAILURE ≠ MATA DEWA FAILURE
 *
 * Mata Dewa harus boot dan memberi kecerdasan spasial yang BERMAKNA dengan
 * NOL kunci pihak ketiga. Kredensial hanya MENINGKATKAN kemampuan.
 */

const { ACCESS_CLASS } = require("./spatial/accessClass");

/** Mode ketersediaan berdasarkan kredensial yang terpasang. */
const MATA_DEWA_MODE = Object.freeze({
    /** Tanpa kunci pihak ketiga — baseline keyless penuh. */
    ZERO: "ZERO",
    /** Kredensial akun gratis/milik pengguna terpasang. */
    PLUS: "PLUS",
    /** Provider komersial opsional terpasang. */
    PRO: "PRO"
});

/**
 * Mode akses sebuah provider (registry semantics).
 * Menentukan bagaimana provider memperoleh otorisasi — BUKAN apakah ia boleh
 * ditembus. Provider yang butuh kunci melaporkan dirinya tidak tersedia secara
 * jujur bila kredensialnya absen.
 */
const PROVIDER_ACCESS_MODE = Object.freeze({
    /** Terbuka tanpa kunci sama sekali. */
    PUBLIC_NO_KEY: "PUBLIC_NO_KEY",
    /** Terbuka tapi butuh akun gratis/milik pengguna. */
    PUBLIC_ACCOUNT: "PUBLIC_ACCOUNT",
    /** Butuh API key. */
    API_KEY: "API_KEY",
    /** Butuh OAuth. */
    OAUTH: "OAUTH",
    /** Diotorisasi pengguna secara eksplisit (data privat lokal). */
    USER_AUTHORIZED: "USER_AUTHORIZED",
    /** Sumber lokal (berkas, bundled). */
    LOCAL: "LOCAL"
});

const ACCESS_MODE_VALUES = new Set(Object.values(PROVIDER_ACCESS_MODE));

function isAccessMode(value) { return ACCESS_MODE_VALUES.has(value); }

/**
 * Apakah mode akses ini memerlukan kredensial agar bisa beroperasi.
 * PUBLIC_NO_KEY dan LOCAL tidak memerlukan kredensial.
 */
function accessModeRequiresCredential(mode) {
    return mode === PROVIDER_ACCESS_MODE.PUBLIC_ACCOUNT ||
        mode === PROVIDER_ACCESS_MODE.API_KEY ||
        mode === PROVIDER_ACCESS_MODE.OAUTH ||
        mode === PROVIDER_ACCESS_MODE.USER_AUTHORIZED;
}

/** Kelas kredensial untuk menentukan tier ZERO/PLUS/PRO. */
const CREDENTIAL_TIER = Object.freeze({
    PLUS: "PLUS",   // akun gratis / milik pengguna (OpenSky, AISStream, FIRMS, BMKG)
    PRO: "PRO"      // komersial (TomTom, Google, Cesium ion, Vaisala/Xweather)
});

module.exports = Object.freeze({
    MATA_DEWA_MODE,
    PROVIDER_ACCESS_MODE,
    CREDENTIAL_TIER,
    ACCESS_CLASS,
    isAccessMode,
    accessModeRequiresCredential
});
