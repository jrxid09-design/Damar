const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

/**
 * SATU penyimpan untuk seluruh keadaan batin.
 *
 * Sebelumnya AffectCore, SelfModel, dan Character masing-masing
 * membuat JsonStore sendiri ke berkas yang sama. JsonStore menyimpan
 * cache isi berkas per instance, jadi penulis terakhir menuliskan
 * salinannya sendiri — dan diam-diam MENGHAPUS kunci milik modul lain.
 * Gejalanya persis seperti amnesia sebagian: watak tersimpan, afek
 * lenyap, tergantung siapa yang kebetulan menulis belakangan.
 *
 * Satu instance dipakai bersama menghapus seluruh kelas bug itu.
 */
module.exports = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "mind.json"),
    {}
);
