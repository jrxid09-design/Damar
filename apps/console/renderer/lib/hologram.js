import { aetherState } from "./aetherState.js";
import { createEntity } from "./avatar/entity.js";

/**
 * Aether Entity — hologram kanonik.
 *
 * PERINGATAN MIGRASI: implementasi visual lama (orb JARVIS generik)
 * digantikan oleh entitas kanonik di ./avatar/entity.js — kepala disc,
 * crown ring, orbital shell, cognitive core diamond, fragmen bawah.
 * Kontrak interface TIDAK berubah:
 *
 *   el, setState, setLevel, setMouth, pause, resume, destroy
 *
 * Warna & tempo keadaan kini bersumber dari aetherState.js (bus
 * terpusat) — BUKAN tabel warna lokal, sehingga avatar, UI, dan
 * partikel selalu koheren.
 *
 * States: idle | listening | thinking | reasoning | executing |
 *         speaking | happy/success | error | offline
 */

export function createHologram({ maxFps = 30, stars = true } = {}) {
    const entity = createEntity({ maxFps, particles: stars !== false });

    return {
        el: entity.el,
        setState: (s) => { aetherState.set(s); },          // lewat bus
        setLevel: (v) => { aetherState.setLevel(v); },
        setMouth: (v) => { aetherState.setMouth(v); },
        pause: entity.pause,
        resume: entity.resume,
        destroy: entity.destroy,
        walkTo() {}, setMood() {}
    };
}
