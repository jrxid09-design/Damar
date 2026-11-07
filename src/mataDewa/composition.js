"use strict";

/**
 * Komposisi Mata Dewa — pemilik singleton (MD-008).
 *
 * HUKUM:
 *  - Permukaan publik (src/mataDewa/index.js) TIDAK mengekspos
 *    setService/resetService: komposisi kanonik tidak bisa diganti oleh
 *    pemanggil arbitrer (anti injection / anti double-composition).
 *  - Modul ini adalah SATU-SATUNYA pemilik singleton. Entry test-only
 *    (setMataDewaServiceForTests / resetMataDewaServiceForTests) ada di
 *    sini — TIDAK di-re-export dari index.js — mirror pola
 *    managerIngressInternal (factory + production-throw).
 *  - Memanggil getOrCreateMataDewaService DENGAN options setelah singleton
 *    berdiri = konflik komposisi → GAGAL KERAS (dua konfigurasi berbeda
 *    tidak boleh saling mengabaikan secara diam-diam).
 */

let singleton = null;

/**
 * Ambil singleton komposisi; buat bila belum ada.
 * @param {object} [options] — HANYA sah pada pembuatan pertama.
 */
function getOrCreateMataDewaService(options = {}) {
    if (singleton) {
        if (options !== null && typeof options === "object" &&
            Object.keys(options).length > 0) {
            throw new Error(
                "MATA_DEWA_COMPOSITION_CONFLICT: singleton sudah berdiri; " +
                "options komposisi hanya sah pada pembuatan pertama");
        }
        return singleton;
    }
    const { MataDewaService } = require("./service");
    singleton = new MataDewaService(options);
    return singleton;
}

/** Getter tanpa efek (server.js shutdown path, controller). */
function getMataDewaService() {
    return singleton;
}

/** TEST-ONLY: pasang instance (trust domain uji). TIDAK diekspor publik. */
function setMataDewaServiceForTests(service) {
    singleton = service;
    return singleton;
}

/** TEST-ONLY: lepaskan singleton. TIDAK diekspor publik. */
function resetMataDewaServiceForTests() {
    singleton = null;
}

module.exports = Object.freeze({
    getOrCreateMataDewaService,
    getMataDewaService,
    setMataDewaServiceForTests,
    resetMataDewaServiceForTests
});
