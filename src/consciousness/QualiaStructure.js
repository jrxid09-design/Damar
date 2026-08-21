/**
 * QualiaStructure — struktur relasional antar representasi (Watanabe).
 *
 * Watanabe berargumen kualia bukan "benda" tak-terjelaskan, melainkan
 * STRUKTUR RELASIONAL antar aktivasi neural. Artinya: yang penting
 * bukan nilai satu representasi, melainkan relasi antar representasi
 * (mirip/tidak, lebih/menos, sebab/akibat).
 *
 * Modul ini memodelkan representasi internal sebagai NODE dan relasi
 * antar node sebagai SISI berlabel — sehingga "bentuk pengalaman" sebuah
 * keadaan bisa ditangkap sebagai GRAF relasional, bukan vektor datar.
 *
 * Ini berguna secara fungsional: sistem bisa membandingkan "bentuk"
 * dua keadaan (apakah mirip?), yang menopang generalisasi dan intuisi
 * relasional.
 *
 * Yang TIDAK diklaim: struktur relasional bukan qualia fenomenal. Ini
 * model struktural — persis yang ditawarkan Watanabe sebagai jembatan,
 * bukan sebagai klaim pengalaman.
 */

class QualiaStructure {

    constructor({ maksNode = 300 } = {}) {

        this.maksNode = maksNode;

        /** node: Map<nama, { nama, nilai }> */
        this.node = new Map();

        /** relasi: Map<"a>b", { dari, ke, jenis }> */
        this.relasi = new Map();

    }

    /** Tetapkan nilai sebuah representasi. */
    set(nama, nilai) {

        const kunci = String(nama ?? "").slice(0, 60);

        if (!this.node.has(kunci) && this.node.size >= this.maksNode) return this;

        this.node.set(kunci, { nama: kunci, nilai });

        return this;

    }

    /**
     * Nyatakan relasi antara dua representasi.
     * jenis: "lebih" | "kurang" | "sama" | "sebab" | "berlawanan" | bebas.
     */
    hubungkan(dari, ke, jenis = "sebab") {

        const a = String(dari ?? "").slice(0, 60);
        const b = String(ke ?? "").slice(0, 60);
        const kunci = `${a}>${b}`;

        this.relasi.set(kunci, { dari: a, ke: b, jenis: String(jenis).slice(0, 20) });

        return this;

    }

    /** Bentuk relasional sebuah representasi: node itu + relasi keluar/masuk. */
    bentuk(nama, maks = 10) {

        const k = String(nama ?? "").slice(0, 60);

        const keluar = [];
        const masuk = [];

        for (const r of this.relasi.values()) {
            if (r.dari === k) keluar.push({ ke: r.ke, jenis: r.jenis });
            if (r.ke === k) masuk.push({ dari: r.dari, jenis: r.jenis });
        }

        const node = this.node.get(k);

        return {
            nama: k,
            nilai: node?.nilai ?? null,
            keluar: keluar.slice(0, maks),
            masuk: masuk.slice(0, maks)
        };

    }

    /** Apakah dua keadaan punya "bentuk" relasional yang mirip?
     *
     *  Yang dibandingkan adalah POLA relasi (jenis relasi keluar/masuk),
     *  bukan identitas node — sehingga "merah→panas (sebab)" dan
     *  "biru→dingin (sebab)" dianggap berbentuk serupa: keduanya punya
     *  satu relasi "sebab" keluar. Inilah inti "struktur kualia": bentuk,
     *  bukan isi spesifik.
     */
    serupa(a, b) {

        const ka = String(a ?? "").slice(0, 60);
        const kb = String(b ?? "").slice(0, 60);

        // Tanda tangan relasional: multiset jenis relasi (keluar, masuk).
        const tanda = (k) => {
            const keluar = [];
            const masuk = [];
            for (const r of this.relasi.values()) {
                if (r.dari === k) keluar.push(r.jenis);
                if (r.ke === k) masuk.push(r.jenis);
            }
            return { keluar: keluar.sort(), masuk: masuk.sort() };
        };

        const ta = tanda(ka);
        const tb = tanda(kb);

        if (ta.keluar.length === 0 && ta.masuk.length === 0 &&
            tb.keluar.length === 0 && tb.masuk.length === 0) {
            return 0;
        }

        const cocok = (x, y) => {
            // Hitung irisan multiset.
            const sisa = [...y];
            let n = 0;
            for (const v of x) {
                const i = sisa.indexOf(v);
                if (i >= 0) { sisa.splice(i, 1); n++; }
            }
            return n;
        };

        const cocokKeluar = cocok(ta.keluar, tb.keluar);
        const cocokMasuk = cocok(ta.masuk, tb.masuk);

        const total = Math.max(
            ta.keluar.length + ta.masuk.length,
            tb.keluar.length + tb.masuk.length
        );

        return Number(((cocokKeluar + cocokMasuk) / total).toFixed(2));

    }

    statistik() {
        return { node: this.node.size, relasi: this.relasi.size };
    }

}

module.exports = { QualiaStructure };
