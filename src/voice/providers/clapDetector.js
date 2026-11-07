/**
 * ClapDetector — deteksi "tepuk tangan 2x" (double clap) sebagai wake trigger.
 *
 * Tepuk tangan = ledakan energi akustik yang singkat (transient). Dua tepukan
 * berurutan dalam jendela waktu singkat adalah isyarat "bangun" yang umum
 * (seperti Google Home / asisten suara). Ini trigger ALTERNATIF wake word,
 * berguna saat bicara tidak memungkinkan atau ingin panggilan diam.
 *
 * Bekerja pada LEVEL audio (RMS 0..1), bukan pada transkrip — sehingga standby
 * TIDAK memanggil STT/LLM. Deteksi dilakukan pada TINGKAT API:
 *   feedLevel(rms, t)  — beri satu sampel level audio.
 *   detect()           — periksa apakah 2 clap terdeteksi dalam jendela.
 *
 * Dengan backend audio nyata (ffmpeg/arecord → analisis RMS), level diambil
 * dari stream; tanpa backend (default "none"), input programatik memakai
 * feedLevel yang sama — antarmuka identik.
 */

// Level (RMS 0..1) di atas ini dianggap "bunyi keras" (kandidat clap).
const DEFAULT_THRESHOLD = 0.6;

// Jendela maksimum antar dua clap (ms) agar dihitung sebagai "double clap".
const DEFAULT_WINDOW_MS = 800;

// Lebar minimum satu clap (ms) — mencegah noise pendek dianggap clap.
const DEFAULT_MIN_CLAP_MS = 30;

// Jeda minimum setelah clap selesai sebelum clap berikutnya (ms).
const DEFAULT_MIN_GAP_MS = 100;

class ClapDetector {

    constructor({
        threshold = DEFAULT_THRESHOLD,
        windowMs = DEFAULT_WINDOW_MS,
        minClapMs = DEFAULT_MIN_CLAP_MS,
        minGapMs = DEFAULT_MIN_GAP_MS
    } = {}) {

        this.threshold = threshold;
        this.windowMs = windowMs;
        this.minClapMs = minClapMs;
        this.minGapMs = minGapMs;

        this.name = "local";

        // Status deteksi.
        this._loud = false;        // sedang dalam "bunyi keras"
        this._loudStart = 0;       // kapan bunyi keras dimulai
        this._claps = [];          // timestamp akhir tiap clap (ms)
        this.lastAt = 0;

    }

    /**
     * Beri satu sampel level audio (RMS 0..1) pada waktu `t` (ms epoch).
     * Mendeteksi tepi naik/turun untuk mengenali clap sebagai transient.
     */
    feedLevel(rms, t = Date.now()) {

        const level = Number(rms);

        if (!Number.isFinite(level)) return;

        const loud = level >= this.threshold;

        if (loud && !this._loud) {
            // Tepi naik: mulai bunyi keras.
            this._loud = true;
            this._loudStart = t;
        }
        else if (!loud && this._loud) {
            // Tepi turun: bunyi keras selesai. Apakah cukup panjang = clap?
            const dur = t - this._loudStart;
            this._loud = false;

            if (dur >= this.minClapMs) {
                this._claps.push(t);
                // Jaga hanya clap terakhir yang masih dalam jendela.
                this._trim(t);
            }
        }

        this.lastAt = t;

    }

    /** Buang clap yang sudah terlalu lama (di luar jendela). */
    _trim(now) {
        this._claps = this._claps.filter(c => (now - c) <= this.windowMs + this.minGapMs);
    }

    /**
     * Apakah dua clap berurutan terdeteksi dalam jendela?
     *
     * Dua clap harus: (a) terpisah setidaknya minGapMs (bukan satu bunyi
     * panjang), dan (b) dalam windowMs satu sama lain.
     *
     * @returns {object} { detected, claps, gapMs }
     */
    detect(now = Date.now()) {

        this._trim(now);

        if (this._claps.length < 2) {
            return { detected: false, claps: this._claps.length, gapMs: null };
        }

        const a = this._claps[this._claps.length - 2];
        const b = this._claps[this._claps.length - 1];
        const gap = b - a;

        const detected = gap >= this.minGapMs && gap <= this.windowMs;

        if (detected) {
            // Konsumsi: reset agar tidak terpicu berulang oleh clap lama.
            this._claps = [];
        }

        return { detected, claps: 2, gapMs: gap };

    }

    reset() {
        this._loud = false;
        this._loudStart = 0;
        this._claps = [];
    }

    status() {
        return {
            provider: this.name,
            threshold: this.threshold,
            windowMs: this.windowMs,
            clapsPending: this._claps.length
        };
    }

}

module.exports = { ClapDetector, DEFAULT_THRESHOLD, DEFAULT_WINDOW_MS, DEFAULT_MIN_CLAP_MS, DEFAULT_MIN_GAP_MS };
