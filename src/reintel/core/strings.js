/**
 * RE Intelligence — ekstraksi printable-string bounded.
 *
 * ASCII (0x20–0x7E) dan UTF-16LE (karakter printable + 0x00). Semua
 * batas dari config: panjang minimum, jumlah maksimum, byte maksimum
 * yang dipindai. Binary adversarial TIDAK boleh menyebabkan memori
 * atau waktu tak terbatas — begitu budget tercapai, berhenti dan
 * tandai truncated.
 *
 * Urutan deteksi: pola UTF-16LE diuji lebih dulu (unit + 0x00);
 * jika run-nya memenuhi panjang minimum diambil sebagai UTF-16,
 * kalau tidak byte yang sama dievaluasi sebagai ASCII.
 */

"use strict";

function isPrintableAscii(b) {
    return b >= 0x20 && b <= 0x7e;
}

/**
 * Ekstrak string dari buffer.
 * Returns { strings: [{ encoding, value, offset }], truncated, scannedBytes }
 */
function extractStrings(buffer, limits) {
    const minLen = Math.max(1, limits.minStringLength);
    const maxStrings = limits.maxStrings;
    const maxScan = Math.min(limits.maxStringScanBytes, buffer.length);

    const strings = [];
    let truncated = false;
    let i = 0;

    while (i < maxScan) {
        if (strings.length >= maxStrings) { truncated = true; break; }

        // ---- kandidat UTF-16LE: printable + 0x00 berulang -------------
        if (i + 1 < maxScan &&
            buffer[i] !== 0 &&
            isPrintableAscii(buffer[i]) &&
            buffer[i + 1] === 0) {
            let j = i;
            let units = 0;
            while (j + 1 < maxScan &&
                   buffer[j] !== 0 &&
                   isPrintableAscii(buffer[j]) &&
                   buffer[j + 1] === 0) {
                j += 2;
                units++;
            }
            if (units >= minLen) {
                strings.push({
                    encoding: "utf16le",
                    value: buffer.toString("utf16le", i, i + units * 2),
                    offset: i
                });
                if (strings.length >= maxStrings) { truncated = true; break; }
                i = j;
                continue;
            }
            // Run pendek → biarkan jatuh ke penanganan ASCII biasa.
        }

        // ---- kandidat ASCII -------------------------------------------
        if (isPrintableAscii(buffer[i])) {
            let j = i;
            while (j < maxScan && isPrintableAscii(buffer[j])) j++;
            const len = j - i;
            if (len >= minLen) {
                strings.push({
                    encoding: "ascii",
                    value: buffer.toString("latin1", i, j),
                    offset: i
                });
                if (strings.length >= maxStrings) { truncated = true; break; }
            }
            i = Math.max(j, i + 1);
            continue;
        }

        i++;
    }

    // Pemindaian berhenti karena budget byte, bukan karena data habis.
    if (!truncated && maxScan < buffer.length) truncated = true;

    return { strings, truncated, scannedBytes: maxScan };
}

module.exports = { extractStrings };
