/**
 * VadDetector — Voice Activity Detection sederhana (berbasis keheningan).
 *
 * Menentukan kapan pengguna selesai bicara TANPA fixed-duration recording.
 * Implementasi default "silence": menandai ucapan selesai bila tidak ada
 * aktivitas (energy/silence) selama `vadTimeoutMs`.
 *
 * Karena backend audio default adalah "none"/"cli" (tanpa streaming level
 * audio nyata), VAD bekerja pada TINGKAT API: pemanggil memberi sinyal
 * "masih ada suara" (touch) dan VAD menghitung diam. Bila nanti tersedia
 * level audio asli (RMS), tinggal feed angka — antarmuka sama.
 */

class VadDetector {

    /** @param {number} vadTimeoutMs diam (ms) yang dianggap akhir ucapan */
    constructor({ vadTimeoutMs = 1200 } = {}) {
        this.vadTimeoutMs = vadTimeoutMs;
        this.lastVoiceAt = 0;
        this.startedAt = 0;
        this.active = false;
    }

    /** Mulai sesi deteksi. */
    start(now = Date.now()) {
        this.startedAt = now;
        this.lastVoiceAt = now;
        this.active = true;
    }

    /**
     * Sinyal "masih ada suara" (panggil saat terdeteksi aktivitas).
     * Dengan backend tanpa level audio, pemanggil memanggil ini saat ada
     * indikasi bicara; tanpa panggilan, VAD menilai diam.
     */
    touch(now = Date.now()) {
        this.lastVoiceAt = now;
    }

    /**
     * Apakah ucapan dianggap selesai? (diam >= vadTimeoutMs)
     */
    selesai(now = Date.now()) {
        if (!this.active) return false;
        return (now - this.lastVoiceAt) >= this.vadTimeoutMs;
    }

    /** Berapa ms sudah diam. */
    diamMs(now = Date.now()) {
        return now - this.lastVoiceAt;
    }

    stop() {
        this.active = false;
    }

    status() {
        return { vadTimeoutMs: this.vadTimeoutMs, active: this.active, diamMs: this.diamMs() };
    }

}

module.exports = { VadDetector };
