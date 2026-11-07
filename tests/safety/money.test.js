const test = require("node:test");
const assert = require("node:assert");

const { ProfitEngine } = require("../../src/money/ProfitEngine");

/**
 * Mesin cuan — bagian yang boleh salah dan bagian yang tidak.
 *
 * Arah harga BOLEH salah; itu di luar kendali siapa pun dan tidak ada
 * tes yang bisa menjaminnya. Yang TIDAK boleh salah adalah tiga hal
 * yang menentukan apakah uang nyata bertahan:
 *
 *   - ukuran posisi tidak pernah melebihi risiko yang diizinkan,
 *   - masukan cacat ditolak, bukan diam-diam menghasilkan angka,
 *   - pembukuan menjumlahkan hasil NYATA, sehingga strategi yang rugi
 *     tidak bisa terus dipakai dengan alasan "rasanya untung".
 */

/** Engine dengan jurnal terisolasi (tidak menyentuh configs/money.json). */
function engineBersih() {

    const e = new ProfitEngine();

    let data = { jurnal: [], realisasi: 0, modalTotal: 0 };

    e.store = { read: () => data, write: x => { data = { ...x }; return data; } };

    return e;

}

// ---- Penakar posisi ----------------------------------------------

test("ukuran posisi dihitung dari risiko, bukan dari besar saldo", () => {

    const e = new ProfitEngine();
    const hasil = e.sizing({ saldoUsdt: 1000, entry: 100, stop: 95, risikoPersen: 1 });

    assert.equal(hasil.ok, true);
    assert.equal(hasil.maksRugi, 10, "risiko 1% dari 1000 = 10 USDT");
    assert.equal(hasil.modalUsdt, 200, "10 USDT risiko / stop 5% = modal 200");

});

test("kerugian terburuk TIDAK PERNAH melebihi risiko yang diizinkan", () => {

    const e = new ProfitEngine();

    for (const stopPct of [0.5, 1, 3, 8, 20]) {

        const entry = 100;
        const stop = entry * (1 - stopPct / 100);
        const h = e.sizing({ saldoUsdt: 5000, entry, stop, risikoPersen: 2 });

        const rugiNyata = h.kuantitas * (entry - stop);

        assert.ok(
            rugiNyata <= 100.01,
            `stop ${stopPct}% menghasilkan rugi ${rugiNyata.toFixed(2)} > batas 100`
        );

    }

});

test("stop sangat rapat tidak boleh melahirkan posisi raksasa", () => {

    const e = new ProfitEngine();
    const h = e.sizing({ saldoUsdt: 1000, entry: 100, stop: 99.9, risikoPersen: 1 });

    assert.ok(h.modalUsdt <= 200, `modal ${h.modalUsdt} melewati batas 20% saldo`);

});

test("masukan cacat DITOLAK, bukan diam-diam menghasilkan angka", () => {

    const e = new ProfitEngine();

    assert.equal(e.sizing({ saldoUsdt: 0, entry: 10, stop: 9 }).ok, false);
    assert.equal(e.sizing({ saldoUsdt: 100, entry: 0, stop: 9 }).ok, false);
    assert.equal(e.sizing({ saldoUsdt: 100, entry: 10, stop: 12 }).ok, false, "stop di atas entry tidak masuk akal");
    assert.equal(e.sizing({ saldoUsdt: 100, entry: 10, stop: 10 }).ok, false, "stop = entry berarti bagi nol");

});

test("risiko per posisi dibatasi walau diminta ekstrem", () => {

    const e = new ProfitEngine();
    const h = e.sizing({ saldoUsdt: 1000, entry: 100, stop: 90, risikoPersen: 90 });

    assert.ok(h.maksRugi <= 50, `risiko ${h.maksRugi} melewati batas 5% saldo`);

});

// ---- Pembukuan ---------------------------------------------------

test("jurnal menjumlahkan hasil NYATA, termasuk yang rugi", () => {

    const e = engineBersih();

    const a = e.catat({ sumber: "spot-momentum", simbol: "SOLUSDT", modal: 200 });
    const b = e.catat({ sumber: "spot-momentum", simbol: "ETHUSDT", modal: 200 });
    const c = e.catat({ sumber: "jasa-desain", modal: 0 });

    e.tutup({ id: a.id, hasilUsdt: 35 });
    e.tutup({ id: b.id, hasilUsdt: -60 });
    e.tutup({ id: c.id, hasilUsdt: 500 });

    const r = e.rapor();

    assert.equal(r.realisasiUsdt, 475);
    assert.equal(r.posisiSelesai, 3);
    assert.equal(r.perSumber[0].sumber, "jasa-desain", "sumber paling menghasilkan harus di puncak");

    const momentum = r.perSumber.find(s => s.sumber === "spot-momentum");

    assert.equal(momentum.totalUsdt, -25, "strategi yang rugi harus terlihat rugi");

});

test("entri tidak bisa ditutup dua kali (hasil ganda = pembukuan bohong)", () => {

    const e = engineBersih();
    const x = e.catat({ sumber: "spot-momentum", modal: 100 });

    assert.equal(e.tutup({ id: x.id, hasilUsdt: 10 }).ok, true);
    assert.equal(e.tutup({ id: x.id, hasilUsdt: 10 }).ok, false);
    assert.equal(e.rapor().realisasiUsdt, 10);

});

test("menutup entri yang tidak ada ditolak dengan jelas", () => {

    const e = engineBersih();
    const h = e.tutup({ id: "cuan_palsu", hasilUsdt: 100 });

    assert.equal(h.ok, false);
    assert.match(h.error, /tidak ada/);

});

test("posisi terbuka terhitung terpisah dari yang sudah selesai", () => {

    const e = engineBersih();

    e.catat({ sumber: "spot-momentum", modal: 50 });

    const b = e.catat({ sumber: "spot-momentum", modal: 50 });

    e.tutup({ id: b.id, hasilUsdt: 5 });

    const r = e.rapor();

    assert.equal(r.posisiTerbuka, 1);
    assert.equal(r.posisiSelesai, 1);

});
