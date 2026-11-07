"use strict";

/**
 * EMBODIED CORE WAVE 1 — akar komposisi integrasi.
 *
 * Menyusun subsystem TERSERTIFIKASI Wave 1 tanpa mengubah semantiknya:
 *
 *   Authority (+DamarSelf)  83a503c
 *   Sensorium + Body Schema  ab29145
 *   Semantic Desktop         3876688
 *   RE Intelligence          bd8a482
 *
 * HUKUM INTEGRASI (load-bearing):
 *   - Observasi/konteks/temuan RE/proposal kognisi/catatan DamarSelf
 *     TIDAK PERNAH menjadi otoritas. Satu-satunya jalur authority baru
 *     adalah API kanonik src/authority via OwnerRatification.
 *   - Modul ini hanya MEMREFERENSI canonical owners (§canonical-state);
 *     tidak membuat salinan state kanonik apa pun.
 *   - Port observasi SATU ARAH dan INERT: hasil ingest tidak pernah
 *     diteruskan ke authority, tidak ada eksekusi, tidak ada aktuator
 *     baru di sini.
 *   - Tanpa singleton global, tanpa efek samping saat import, tanpa
 *     ketergantungan pada Console UI.
 */

const authority = require("../authority");
const embodiment = require("../embodiment");
const desktop = require("../desktop");
const reintel = require("../reintel");
const cognition = require("../cognition");
const { createDamarSelfService } = require("../services/damarSelfService");

const VERSION = "1.0.0-wave1";

function defaultClock() {
    return {
        nowMs: () => Date.now(),
        nowIso: () => new Date().toISOString()
    };
}

/**
 * Susun embodied core. Semua dependensi eksplisit (constructor injection);
 * setiap slot menerima instance jadi ATAU primitif untuk membangunnya.
 */
async function createEmbodiedCore({
    authorityRegistry = null,
    authorityStore = null,
    authorityClock = null,
    bodySchema = null,
    bodyClock = null,
    desktopCore = null,
    desktopClock = null,
    accCore = null,
    accOverrides = {},
    reintelInstance = null,
    reintelOverrides = {},
    damarSelfService = null,
    damarSelfDir = null,
    env = process.env
} = {}) {

    const clock = defaultClock();

    // ---- Authority: pemilik KANONIK otoritas/delegasi -----------------
    const registry = authorityRegistry ??
        new authority.registry.AuthorityRegistry({
            store: authorityStore ?? authority.store.createMemoryAuthorityStore(),
            clock: authorityClock ?? clock
        });

    // ---- Body Schema / Sensorium: pemilik KANONIK device state --------
    const body = bodySchema ??
        embodiment.createBodySchema({ clock: bodyClock ?? undefined });

    // ---- Semantic Desktop: pemilik KANONIK konteks desktop ------------
    const context = desktopCore ??
        new desktop.DesktopContextCore({
            clock: desktopClock ?? (() => clock.nowMs())
        });

    // ---- ACC: pemilik KANONIK kontinuitas kognitif (shadow) ----------
    const acc = accCore ?? await cognition.createAccCore({
        env,
        overrides: { mode: "shadow", ...accOverrides }
    });
    if (acc.mode !== "shadow") {
        throw new Error(
            `INTEGRATION LAW: ACC harus shadow untuk Wave 1 ` +
            `(dapat: ${acc.mode})`);
    }

    // ---- RE Intelligence: pemilik KANONIK temuan RE -------------------
    const re = reintelInstance ?? await reintel.createReIntel({
        env,
        overrides: reintelOverrides
    });

    // ---- DamarSelf: pemilik KANONIK identitas autobiografis ----------
    const selfSvc = damarSelfService ??
        createDamarSelfService(
            damarSelfDir ? { canonicalDir: damarSelfDir } : {});

    // ---- Port observasi satu arah (inert) -----------------------------
    // Hasil TIDAK pernah diteruskan ke authority oleh komposisi ini.

    function observeEmbodiment(event) {
        return body.ingest(event);
    }

    function observeDesktop(rawObservation) {
        return context.ingest(rawObservation);
    }

    function feedCognition(envelope) {
        if (!Object.isFrozen(envelope)) {
            throw new Error("INTEGRATION LAW: envelope kognisi wajib beku");
        }
        return acc.feedShadow(envelope);
    }

    async function describe() {
        return Object.freeze({
            version: VERSION,
            authority: { backend: registry.store.backend },
            embodiment: embodiment.getEmbodimentSummary(body),
            desktop: { version: context.version },
            reintel: { version: re.version },
            acc: { mode: acc.mode },
            damarSelf: { canonicalDir: selfSvc.resolveCanonical() }
        });
    }

    return Object.freeze({
        version: VERSION,

        // Canonical owners (referensi, bukan salinan):
        authority: Object.freeze({
            registry,
            model: authority.model,
            canonical: authority.canonical
        }),
        body,
        desktop: context,
        reintel: re,
        acc,
        damarSelf: selfSvc,

        // Inert one-way observation ports:
        observeEmbodiment,
        observeDesktop,
        feedCognition,
        describe
    });
}

module.exports = { createEmbodiedCore, VERSION };
