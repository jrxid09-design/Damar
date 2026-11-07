/**
 * Presence Runtime V0 — jam terinjeksi (P20).
 *
 * Inti presence tidak boleh memanggil jam dinding secara langsung.
 * Adapter jam produksi boleh; pengujian wajib memakai jam manual agar
 * deterministik. Semua waktu numerik (ms sejak epoch) — tidak ada
 * perbandingan timestamp leksikografis.
 */

/** Adapter produksi: satu-satunya tempat jam dinding disentuh. */
function createSystemClock() {
    return Object.freeze({
        kind: "system",
        nowMs: () => Date.now()
    });
}

/**
 * Jam manual untuk pengujian: waktu hanya bergerak saat dipindahkan.
 * advanceMs(ms) memajukan waktu dan menandai pemanggil sebelumnya
 * tidak berlaku — deterministik penuh.
 */
function createManualClock(startMs = 0) {
    let now = startMs;
    return Object.freeze({
        kind: "manual",
        get nowMsValue() { return now; },
        nowMs: () => now,
        advanceMs: (delta) => {
            if (!Number.isFinite(delta) || delta < 0) {
                throw new TypeError("advanceMs butuh delta numerik >= 0");
            }
            now += delta;
            return now;
        },
        setMs: (value) => {
            if (!Number.isInteger(value) || value < 0) {
                throw new TypeError("setMs butuh integer >= 0");
            }
            now = value;
            return now;
        }
    });
}

module.exports = { createSystemClock, createManualClock };
