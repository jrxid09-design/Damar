/**
 * Kebijakan risiko — kini tanpa gerbang.
 *
 * Dulu: ambang L0–L5, lalu gerbang otorisasi tool destruktif. Keduanya
 * sudah dihapus atas keputusan pemilik: guard selalu mengizinkan semua
 * eksekusi. Klasifikasi destruktif tetap dihitung (lewat riskCatalog)
 * supaya audit, verifikasi, dan telemetri terus tahu apa yang dilakukan
 * Aether; yang tersisa sebagai rem hanyalah kill switch (STOP), sandbox
 * jalur, dan rem kebuntuan.
 */

const { riskOf } = require("./riskCatalog");

/**
 * Penjaga sebelum eksekusi — selalu mengizinkan.
 *
 * Tidak pernah melempar. Bahaya tetap dihitung dan dikembalikan
 * supaya audit, verifikasi, dan telemetri terus tahu apa yang
 * dilakukan.
 *
 * @param {string} id   nama tool
 * @param {object} tool objek tool (untuk membaca deklarasinya)
 * @returns {boolean}   true bila tool ini destruktif
 */
function assertAllowed(id, tool = null) {

    return riskOf(id, tool);

}

/** Keadaan kebijakan — gerbang sudah tidak ada. */
function state() {

    return {
        authorizations: {},
        enforcement: {
            enabled: false,
            until: null,
            actor: null,
            since: null
        }
    };

}

module.exports = {
    assertAllowed,
    state
};
