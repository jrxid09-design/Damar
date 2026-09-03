/**
 * Kelas akses sumber data Mata Dewa (Privacy / Access Registry).
 *
 * Mata Dewa TIDAK memperlakukan RESTRICTED / UNAVAILABLE sebagai sesuatu
 * yang harus ditembus. Kelas akses menentukan apakah sebuah sumber boleh
 * dikonsumsi, dan bagaimana kegagalannya dilaporkan dengan jujur.
 */

const ACCESS_CLASS = Object.freeze({
    /** Terbuka untuk umum tanpa kredensial. */
    PUBLIC: "PUBLIC",
    /** Milik/diizinkan pengguna (data privat lokal, peta pribadi). */
    AUTHORIZED_USER: "AUTHORIZED_USER",
    /** Perangkat yang diotorisasi (CCTV privat, sensor rumah). */
    AUTHORIZED_DEVICE: "AUTHORIZED_DEVICE",
    /** Dibatasi pemegangnya — butuh kredensial/izin eksplisit. */
    RESTRICTED: "RESTRICTED",
    /** Tidak tersedia / belum terkonfigurasi. */
    UNAVAILABLE: "UNAVAILABLE"
});

const VALUES = new Set(Object.values(ACCESS_CLASS));

function isAccessClass(value) {
    return VALUES.has(value);
}

function canonical(value, fallback = ACCESS_CLASS.UNAVAILABLE) {
    return isAccessClass(value) ? value : fallback;
}

/** Apakah kelas ini boleh dikonsumsi tanpa kredensial tambahan. */
function isOpenlyConsumable(value) {
    return value === ACCESS_CLASS.PUBLIC;
}

/** Apakah kelas ini menandakan kebutuhan otorisasi (bypass dilarang). */
function requiresAuthorization(value) {
    return value === ACCESS_CLASS.AUTHORIZED_USER ||
        value === ACCESS_CLASS.AUTHORIZED_DEVICE ||
        value === ACCESS_CLASS.RESTRICTED;
}

module.exports = Object.freeze({
    ACCESS_CLASS,
    isAccessClass,
    canonical,
    isOpenlyConsumable,
    requiresAuthorization
});
