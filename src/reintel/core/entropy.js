/**
 * RE Intelligence — entropy Shannon atas sampel byte.
 *
 * Dipakai sebagai SALAH SATU bukti (bukan penentu) untuk membedakan
 * data biner terkompresi/terenkripsi dari teks. Deterministik: sampel
 * dibatasi maxBytes pertama.
 */

"use strict";

function shannonEntropy(buffer, maxBytes = buffer.length) {
    if (!buffer || buffer.length === 0) return 0;
    const n = Math.min(buffer.length, maxBytes);
    const freq = new Array(256).fill(0);
    for (let i = 0; i < n; i++) freq[buffer[i]]++;
    let h = 0;
    for (let i = 0; i < 256; i++) {
        if (freq[i] === 0) continue;
        const p = freq[i] / n;
        h -= p * Math.log2(p);
    }
    // Bulatkan ke 3 desimal — cukup untuk banding bukti.
    return Math.round(h * 1000) / 1000;
}

module.exports = { shannonEntropy };
