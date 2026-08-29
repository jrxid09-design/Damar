/**
 * AssociativeMemory — asosiasi Hebbian antar konsep (Haikonen).
 *
 * Haikonen menolak simbol abstrak yang terlepas (ungrounded). Makna
 * muncul dari ASOSIASI antar representasi yang sering aktif bersama:
 * neuron asosiatif memperkuat koneksi antar pola yang sering muncul
 * bersamaan (ko-aktivasi). Makin sering A dan B bersama, makin kuat
 * ikatannya — dan makin mudah yang satu memanggil yang lain.
 *
 * Ini BUKAN pengganti MemoryService (FTS5+embedding) yang sudah ada;
 * ini lapisan asosiatif ringan di atasnya: jejaring ko-aktivasi yang
 * menangkap "X sering muncul bersama Y" dalam satu sesi hidup Damar.
 *
 * Yang TIDAK diklaim: asosiasi bukan pemahaman; ia hanya statistik
 * ko-aktivasi yang ter-ground pada peristiwa nyata.
 */

const BATAS = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

class AssociativeMemory {

    constructor({ maksNode = 500, maksSisi = 2000 } = {}) {

        this.maksNode = maksNode;
        this.maksSisi = maksSisi;

        /** node: Map<kunci, { kunci, muncul }> */
        this.node = new Map();

        /** sisi: Map<"a|b", { a, b, kuat }> (kuat = ko-aktivasi) */
        this.sisi = new Map();

    }

    /**
     * Catat bahwa sekumpulan konsep aktif BERSAMA (co-activation).
     * Semua pasangan dalam himpunan diperkuat ikatannya.
     */
    aktifkanBersama(konsep = []) {

        const kunci = [...new Set((konsep ?? []).map(k => String(k).slice(0, 60)).filter(Boolean))];

        for (const k of kunci) {

            const ada = this.node.get(k);

            if (ada) ada.muncul += 1;
            else {
                if (this.node.size >= this.maksNode) return this;
                this.node.set(k, { kunci: k, muncul: 1 });
            }

        }

        for (let i = 0; i < kunci.length; i++) {
            for (let j = i + 1; j < kunci.length; j++) {
                this._kuatkan(kunci[i], kunci[j]);
            }
        }

        return this;

    }

    _kuatkan(a, b) {

        const kunci = a < b ? `${a}|${b}` : `${b}|${a}`;

        const ada = this.sisi.get(kunci);

        if (ada) {
            ada.kuat = BATAS(ada.kuat + 1, 0, 100);
        }
        else {
            if (this.sisi.size >= this.maksSisi) return;
            this.sisi.set(kunci, { a: a < b ? a : b, b: a < b ? b : a, kuat: 1 });
        }

    }

    /**
     * Ingatkan: konsep apa yang paling kuat diasosiasikan dengan ini?
     * (recall asosiatif — satu konsep memanggil yang lain)
     */
    asosiasi(konsep, maks = 5) {

        const k = String(konsep ?? "").slice(0, 60);

        const hasil = [];

        for (const sisi of this.sisi.values()) {

            if (sisi.a !== k && sisi.b !== k) continue;

            const lain = sisi.a === k ? sisi.b : sisi.a;

            hasil.push({ konsep: lain, kuat: sisi.kuat });

        }

        return hasil
            .sort((a, b) => b.kuat - a.kuat)
            .slice(0, maks);

    }

    /** Ringkasan untuk prompt: asosiasi terkuat dari konsep yang ditanya. */
    ringkas(konsep = null) {

        if (!konsep) return null;

        const a = this.asosiasi(konsep, 3);

        if (!a.length) return null;

        return a.map(x => `${x.konsep} (${x.kuat})`).join(", ");

    }

    statistik() {
        return { node: this.node.size, sisi: this.sisi.size };
    }

}

module.exports = { AssociativeMemory };
