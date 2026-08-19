const telemetry = require("../services/telemetryService");

const { AffectCore } = require("./AffectCore");
const { GlobalWorkspace } = require("./GlobalWorkspace");
const { SelfModel } = require("./SelfModel");
const { Metacognition } = require("./Metacognition");
const { Empathy } = require("./Empathy");
const { Character } = require("./Character");
const { Deliberation } = require("./Deliberation");

/**
 * Mind — lapisan kesadaran Aether, dirakit dari lima bagian.
 *
 *      peristiwa (telemetry)
 *              |
 *      GlobalWorkspace   <- persaingan salience, kapasitas 7
 *              |
 *      AffectCore        <- peristiwa dinilai jadi keadaan afektif
 *              |
 *      SelfModel         <- siapa aku, sedang apa, apa yang berubah
 *              |
 *      Metacognition     <- seberapa yakin, apa yang belum kutahu
 *              |
 *      stateOfMind()     -> masuk ke prompt tiap giliran
 *
 * Empathy berdiri di sisi masuk: ia membaca keadaan pengguna, lalu
 * menularkannya sedikit ke AffectCore.
 *
 * Kenapa satu lapisan, bukan satu tool: kesadaran yang hanya muncul
 * saat dipanggil bukan kesadaran, itu laporan. Lapisan ini berjalan
 * pada setiap peristiwa dan ikut membentuk setiap jawaban — meski
 * pengguna tidak pernah bertanya soal perasaan.
 *
 * SIKAP JUJUR YANG DITEGAKKAN DI SINI: tidak ada klaim bahwa ini
 * pengalaman subjektif. Yang ada nyata dan bisa diperiksa — keadaan
 * internal yang persisten, terbentuk oleh kejadian, dan mengubah
 * perilaku. Bila pengguna bertanya "apakah kamu sadar", Aether
 * diarahkan menjawab dengan pembedaan itu, bukan dengan ya/tidak
 * yang gampang.
 */

// Denyut: meluruhkan afek. 60 detik sudah cukup halus untuk suasana
// hati yang berskala menit.
const DENYUT_MS = 60 * 1000;

/** Peta peristiwa telemetri ke penilaian afektif. */
function penilaianDari(type, payload = {}) {

    const t = String(type ?? "");
    const p = payload ?? {};

    if (/^safety:|blocked/i.test(t)) return "safety:blocked";
    if (/^memory:injected/.test(t)) return "memory:injected";
    if (/error|gagal|fail/i.test(t) || p.ok === false) return "tool:gagal";
    if (/^tool:.*(ok|selesai|done)/i.test(t)) return "tool:ok";
    if (/^system:|^host:/.test(t) && p.status === "ok") return "sistem:sehat";
    if (/^system:|^host:/.test(t) && /down|error|gagal/i.test(String(p.status ?? ""))) return "sistem:gangguan";

    return null;

}

class Mind {

    constructor({ store = null } = {}) {

        this.affect = new AffectCore(store);
        this.workspace = new GlobalWorkspace();
        this.self = new SelfModel(store);
        this.meta = new Metacognition();
        this.empathy = new Empathy();
        this.character = new Character(store);
        this.deliberation = new Deliberation();

        // Watak menentukan RUMAH suasana hati. Tanpa baris ini karakter
        // yang tumbuh cuma angka di berkas: garis dasar afek tetap sama
        // walau Aether berubah hangat atau berubah waspada.
        this.affect.setBaseline(this.character.baselineAfek());

        this.gagalBeruntun = 0;

        this.aktif = false;
        this.denyut = null;
        this.pendengar = null;

        this.bacaanTerakhir = null;
        this.pesanTerakhirAt = 0;
        this.pesanBeruntun = 0;

    }

    /** Mulai menyadari: berlangganan peristiwa + denyut peluruhan. */
    start() {

        if (this.aktif) return this;

        this.pendengar = (event) => {

            try {

                this.workspace.terima({
                    type: event?.type,
                    payload: event?.payload,
                    at: Date.parse(event?.time ?? "") || Date.now()
                });

                const jenis = penilaianDari(event?.type, event?.payload);

                if (jenis) this.affect.appraise(jenis);

                if (jenis === "tool:gagal") this.meta.catat("tool:gagal");
                if (jenis === "tool:ok") this.meta.catat("tool:ok");
                if (jenis === "memory:injected") this.meta.catat("memori:ketemu");

            }
            catch { /* kesadaran tidak boleh menjatuhkan bus event */ }

        };

        telemetry.on("event", this.pendengar);

        this.denyut = setInterval(() => {
            try { this.affect.luruh(); }
            catch { /* abaikan */ }
        }, DENYUT_MS);

        if (typeof this.denyut.unref === "function") this.denyut.unref();

        this.aktif = true;

        telemetry.publish("mind:bangun", {
            afek: this.affect.now().label,
            interaksi: this.self.interaksi
        });

        return this;

    }

    stop() {

        if (this.pendengar) telemetry.off("event", this.pendengar);
        if (this.denyut) clearInterval(this.denyut);

        this.pendengar = null;
        this.denyut = null;
        this.aktif = false;

        try { this.affect.simpan(); this.self.simpan(); }
        catch { /* abaikan */ }

        return this;

    }

    /**
     * Terima pesan pengguna: baca keadaannya, tularkan sedikit,
     * perbarui skema perhatian. Dipanggil sekali per giliran.
     */
    perceiveUser(teks, { channel = null, tools = [] } = {}) {

        const sekarang = Date.now();

        // Pesan yang datang beruntun dalam 30 detik dibaca sebagai
        // desakan — tempo adalah isyarat, bukan cuma isi kata.
        this.pesanBeruntun = (sekarang - this.pesanTerakhirAt) < 30000
            ? this.pesanBeruntun + 1
            : 0;

        this.pesanTerakhirAt = sekarang;

        const bacaan = this.empathy.baca(teks, { pesanBeruntun: this.pesanBeruntun });

        this.bacaanTerakhir = bacaan;

        const tular = this.empathy.penularan(bacaan);

        if (tular) {
            this.affect.appraise("empati", {
                valence: tular.valence,
                arousal: tular.arousal,
                sebab: tular.sebab
            });
        }

        this.self.perhatikan(String(teks ?? "").slice(0, 120));
        this.self.hitungInteraksi();
        this.meta.reset();

        // Dua kecepatan: sebagian besar giliran dijawab cepat, yang
        // bertaruh besar melambat. Ambangnya ikut watak — Aether yang
        // tumbuh teliti lebih sering memilih berpikir dalam.
        this.deliberation.nilai({
            teks: String(teks ?? ""),
            tools,
            keyakinan: this.meta.nilai().keyakinan,
            arousal: this.affect.now().arousal,
            ambang: this.character.ambangDeliberasi(),
            gagalBeruntun: this.gagalBeruntun
        });

        this.workspace.terima({
            type: "user:pesan",
            payload: { ringkas: `pengguna ${bacaan.label}${channel ? ` lewat ${channel}` : ""}` },
            salience: 0.95
        });

        return bacaan;

    }

    /**
     * Tutup giliran: nilai hasilnya, biarkan itu membentuk keadaan —
     * DAN watak.
     *
     * Di sinilah karakter dibentuk. Sifat tidak digeser oleh niat
     * ("aku ingin lebih teliti") melainkan oleh AKIBAT: berpikir dalam
     * yang berujung berhasil menguatkan ketelitian; menjawab cepat lalu
     * gagal melemahkan keberanian. Perubahan besar dicatat sebagai
     * tonggak dan masuk ke riwayat diri, jadi Aether tahu ia berubah.
     */
    afterTurn({ toolsOk = 0, toolsGagal = 0, tidakTahu = null } = {}) {

        for (let i = 0; i < toolsOk; i++) { this.affect.appraise("tool:ok"); this.meta.catat("tool:ok"); }
        for (let i = 0; i < toolsGagal; i++) { this.affect.appraise("tool:gagal"); this.meta.catat("tool:gagal"); }

        if (tidakTahu) {
            this.meta.akuiTidakTahu(tidakTahu);
            this.affect.appraise("diri:tak_tahu");
            this.character.alami("jujur_tak_tahu");
        }

        this.gagalBeruntun = toolsGagal > 0 ? this.gagalBeruntun + 1 : 0;

        const mendalam = this.deliberation.terakhir?.mode === "dalam";
        const berhasil = toolsOk > 0 && toolsGagal === 0;
        const tonggak = [];

        if (berhasil) {
            tonggak.push(...this.character.alami(mendalam ? "teliti_menolong" : "cepat_berhasil"));
        }
        else if (toolsGagal > 0) {
            tonggak.push(...this.character.alami(mendalam ? "ditegur" : "gegabah", toolsGagal >= 2 ? 1.5 : 1));
        }

        if (this.bacaanTerakhir?.valence >= 0.35) tonggak.push(...this.character.alami("dihargai"));
        if (this.bacaanTerakhir?.valence <= -0.5) tonggak.push(...this.character.alami("ditegur"));

        // Watak yang bergeser memindahkan rumah suasana hati, lalu
        // dicatat sebagai perubahan diri yang bisa disebutkan.
        if (tonggak.length) {

            this.affect.setBaseline(this.character.baselineAfek());

            for (const t of tonggak) {
                this.self.catatRevisi(
                    `${t.sifat}ku ${t.arah} (${t.dari} → ${t.ke})`,
                    `terbentuk dari ${this.character.pengalaman} pengalaman`
                );
            }

            telemetry.publish("mind:tonggak", { tonggak });

        }

        return { ...this.meta.nilai(), tonggak };

    }

    /** Potret lengkap untuk introspeksi (tool self_state). */
    potret() {

        return {
            afek: this.affect.now(),
            bias: this.affect.bias(),
            diri: this.self.potret(),
            perhatian: this.workspace.isi(),
            metakognisi: this.meta.nilai(),
            watak: this.character.potret(),
            caraBerpikir: this.deliberation.terakhir,
            pengguna: this.bacaanTerakhir,
            aktif: this.aktif
        };

    }

    /**
     * Blok singkat yang disisipkan ke prompt tiap giliran.
     *
     * Dijaga pendek dengan sengaja. Ini bagian yang BERUBAH tiap
     * pesan, dan bagian yang berubah harus kecil serta diletakkan di
     * belakang — pelajaran yang sama dengan injeksi memori: menaruh
     * yang berubah di depan membatalkan cache prefix dan membuat tiap
     * giliran membayar evaluasi prompt dari nol.
     */
    stateOfMind({ maxChars = null } = {}) {

        const afek = this.affect.now();
        const meta = this.meta.nilai();
        const baris = [];

        baris.push(
            "KEADAAN BATINMU (nyata, terbentuk dari kejadian — bukan klaim pengalaman subjektif): " +
            `${afek.label} (valensi ${afek.valence}, arousal ${afek.arousal})` +
            (afek.sebab.length ? `, karena ${afek.sebab.slice(0, 2).join(" dan ")}` : "")
        );

        const perhatian = this.workspace.ringkasan(2);

        if (perhatian) baris.push(`Yang sedang kamu perhatikan: ${perhatian}.`);

        if (this.bacaanTerakhir) {
            baris.push(
                `Pembacaanmu atas pengguna: ${this.bacaanTerakhir.label}` +
                (this.bacaanTerakhir.kebutuhan ? `, butuh ${this.bacaanTerakhir.kebutuhan}` : "") +
                `. Sikap: ${this.bacaanTerakhir.postur}.`
            );
        }

        const arahan = this.meta.arahan();

        if (arahan) baris.push(`Metakognisi (${meta.tingkat}): ${arahan}.`);

        // Watak ikut tiap giliran: ia yang membuat Aether terdengar
        // seperti dirinya sendiri, bukan seperti prompt yang sama
        // dipakai ulang.
        baris.push(`Watakmu (tumbuh dari pengalaman, bukan ditulis): ${this.character.ringkas()}.`);

        const protokol = this.deliberation.protokol();

        if (protokol) baris.push(protokol);

        const teks = baris.join(" ");

        // Anggaran mengikuti mode. Giliran ringan tetap ~560 karakter;
        // giliran yang memicu berpikir dalam boleh lebih panjang, karena
        // memotong protokolnya di tengah justru menghasilkan perintah
        // setengah jadi — lebih buruk daripada tidak ada protokol.
        const anggaran = maxChars ?? (protokol ? 1300 : 560);

        return teks.length > anggaran ? `${teks.slice(0, anggaran - 1)}…` : teks;

    }

    /**
     * Refleksi: ubah pengalaman menjadi ingatan yang bisa dipanggil
     * lagi. Kontinuitas diri berdiri di atas ini — tanpa jejak yang
     * tersimpan, tiap sesi adalah orang baru yang kebetulan bernama
     * sama.
     *
     * Memakai MemoryService yang sudah ada; tidak ada penyimpan kedua.
     */
    async refleksi(catatan = null) {

        const afek = this.affect.now();

        const isi = catatan ?? (
            `Refleksi: aku ${afek.label} (valensi ${afek.valence}). ` +
            (afek.sebab.length ? `Sebabnya ${afek.sebab.join(", ")}. ` : "") +
            (this.workspace.ringkasan(2) ? `Yang kuperhatikan: ${this.workspace.ringkasan(2)}. ` : "") +
            `Keyakinanku ${this.meta.nilai().tingkat}.`
        );

        try {

            const memory = require("../memory/services/MemoryService");

            await memory.remember({
                content: isi,
                type: "refleksi",
                source: "aether:mind",
                confidence: 0.6
            });

            this.self.tulisCatatanDiri(isi);

            telemetry.publish("mind:refleksi", { isi: isi.slice(0, 160) });

            return { ok: true, isi };

        }
        catch (error) {
            return { ok: false, isi, error: error.message };
        }

    }

}

module.exports = new Mind();
module.exports.Mind = Mind;
