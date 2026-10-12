"use strict";

/**
 * W8-L1 lifecycle-trust — the read-only seam the bridge uses to ask
 * "did BodySchema really commit/deliver this event".
 *
 * Modul ini SENGAJA tidak menyediakan cara apa pun untuk MEMBUAT, MENDAFTARKAN,
 * atau MEMUTASI state kepercayaan. Ia hanya menyimpan SATU oracle yang diikat
 * oleh `BodySchema.js` saat modul itu dimuat, dan meneruskan pertanyaan ke sana.
 *
 * Alasannya konkret: versi sebelumnya mengekspor `registerBodyInstance` yang
 * mengembalikan handle state hidup, sehingga siapa pun dapat men-brand objek
 * sembarangan, menyuntikkan event palsu ke state itu, lalu membuka kembali kanal
 * FAILED milik jembatan (audit 41a7006). Memindahkan fungsi itu "ke modul
 * internal" tidak mengamankannya -- selama ia diekspor, ia adalah API.
 *
 * Dengan desain ini:
 *  - state kepercayaan hidup di closure `BodySchema.js` dan tidak pernah
 *    meninggalkannya;
 *  - tidak ada API pendaftaran, jadi tidak ada objek yang bisa di-brand;
 *  - `bindTrustOracle` hanya menerima pengikatan PERTAMA, dan `BodySchema.js`
 *    MELEMPAR bila pengikatan itu gagal (berarti ada yang mengikat lebih dulu),
 *    sehingga hijack membuat runtime gagal dengan keras -- bukan gagal terbuka.
 */

/** Oracle yang diikat sekali. Tidak pernah dapat dibaca dari luar. */
let TRUST_ORACLE = null;

/**
 * Ikat oracle pembaca kepercayaan. Panggilan pertama menang.
 * @returns {boolean} true bila pengikatan ini yang diterima.
 */
function bindTrustOracle(oracle) {
    if (TRUST_ORACLE !== null) return false;
    if (typeof oracle !== "function") return false;
    TRUST_ORACLE = oracle;
    return true;
}

/**
 * Bukti lifecycle untuk `instance`, atau null bila `instance` bukan BodySchema
 * asli (pemanggil dapat membedakan "double tanpa API" dari "instance asli").
 */
function lifecycleTrustOf(instance, event) {
    if (TRUST_ORACLE === null) return null;
    return TRUST_ORACLE(instance, event);
}

module.exports = Object.freeze({
    bindTrustOracle,
    lifecycleTrustOf
});
