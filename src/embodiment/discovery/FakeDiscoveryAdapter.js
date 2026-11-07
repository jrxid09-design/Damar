/**
 * FakeDiscoveryAdapter — adapter uji deterministik (B§5b).
 *
 * Nol akses perangkat keras, nol waktu-dinding: seluruh siklus hidup
 * penemuan (muncul → berubah → sakit → hilang → muncul lagi) disunting
 * lewat skrip langkah. Inilah bukti bahwa BodySchema bekerja tanpa
 * Console, tanpa Windows API, dan tanpa LLM (invariant G).
 */

const { validateAdapter } = require("./adapter");

/**
 * @param {object} opts
 * @param {string} opts.id            id produsen (default "fake.discovery")
 * @param {Array}  opts.script        daftar langkah; tiap langkah = array operasi
 */
function createFakeDiscoveryAdapter({ id = "fake.discovery", script = [] } = {}) {
    let cursor = 0;
    return validateAdapter({
        id,
        namespaces: ["fake"],
        /** Satu panggilan = satu langkah skrip, urut & habis pakai. */
        next() {
            if (cursor >= script.length) return [];
            return script[cursor++];
        }
    });
}

module.exports = { createFakeDiscoveryAdapter };
