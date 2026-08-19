/**
 * Aether State Bus — satu sumber kebenaran keadaan entitas.
 *
 * Semua konsumen (avatar runtime, partikel, chrome UI, voice viz)
 * berlangganan ke sini; TIDAK ADA yang menset warna state sendiri.
 *
 * Keadaan kanonik (dari spesifikasi UI/UX Aether):
 *   idle      — cyan, napas tenang
 *   listening — cyan terang, partikel mengalir ke dalam
 *   thinking  — bias VIOLET (kognisi), denyut lebih cepat
 *   executing — biru aktif, partikel terarah
 *   speaking  — cyan, inti berdenyut ikut amplitudo TTS
 *   success   — hijau, partikel menyusun & menetap
 *   error     — merah, ketidakstabilan terkendali
 *   offline   — redup abu-gelap
 *
 * Kompatibilitas: reasoning→thinking, happy→success dipetakan.
 */

const CANON = {
    // Palet orb spektrum: amber kekuningan (identitas) × cyan (aktif).
    idle:      { color: "var(--ae-state-idle)",      hex: 0xFFB84D, tempo: 1.0 },
    listening: { color: "var(--ae-state-listening)", hex: 0x00DFFF, tempo: 1.5 },
    focused:   { color: "var(--ae-state-idle)",      hex: 0xFFB84D, tempo: 1.2 },
    thinking:  { color: "var(--ae-state-thinking)",  hex: 0x7C5CFF, tempo: 2.2 },
    analyzing: { color: "var(--ae-state-listening)", hex: 0x00DFFF, tempo: 2.4 },
    executing: { color: "var(--ae-state-executing)", hex: 0x28AFFF, tempo: 2.0 },
    speaking:  { color: "var(--ae-state-speaking)",  hex: 0xFFD98A, tempo: 1.3 },
    curious:   { color: "var(--ae-state-idle)",      hex: 0xFFD98A, tempo: 1.1 },
    happy:     { color: "var(--ae-state-success)",   hex: 0x21E6A4, tempo: 1.0 },
    success:   { color: "var(--ae-state-success)",   hex: 0x21E6A4, tempo: 0.9 },
    alert:     { color: "var(--ae-state-idle)",      hex: 0xE8FCFF, tempo: 2.0 },
    error:     { color: "var(--ae-state-error)",     hex: 0xFF3B3B, tempo: 1.8 },
    sleep:     { color: "var(--ae-state-offline)",   hex: 0x39435E, tempo: 0.2 },
    recovery:  { color: "var(--ae-state-success)",   hex: 0x21E6A4, tempo: 0.8 },
    offline:   { color: "var(--ae-state-offline)",   hex: 0x39435E, tempo: 0.2 }
};

const ALIAS = { reasoning: "thinking", understanding: "speaking", warning: "alert", surprised: "curious" };

const listeners = new Set();
let current = "idle";
let level = 0;   // amplitudo mic (0..1)
let mouth = 0;   // amplitudo TTS (0..1)

export const aetherState = {

    get state() { return current; },
    get level() { return level; },
    get mouth() { return mouth; },

    /** Definisi kanonik sebuah keadaan (warna & tempo). */
    canon(name) {
        const key = ALIAS[name] ?? name;
        return CANON[key] ?? CANON.idle;
    },

    /** Set keadaan entitas — menyiarkan ke semua pelanggan. */
    set(next) {
        const key = ALIAS[next] ?? next;
        if (!CANON[key] || key === current) return;
        current = key;
        for (const fn of listeners) fn(current, { level, mouth });
    },

    /** Amplitudo suara masuk (mic). */
    setLevel(v) {
        level = Math.max(0, Math.min(1, Number(v) || 0));
    },

    /** Amplitudo suara keluar (TTS). */
    setMouth(v) {
        mouth = Math.max(0, Math.min(1, Number(v) || 0));
    },

    /** Berlangganan perubahan keadaan. Mengembalikan fungsi lepas. */
    subscribe(fn) {
        listeners.add(fn);
        fn(current, { level, mouth });
        return () => listeners.delete(fn);
    }
};
