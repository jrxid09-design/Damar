"use strict";

/**
 * W7-L2 WORLD MODEL — himpunan kontradiksi (spec §6 CONTEST, §11, §13 WM-A8).
 * Resolusi WAJIB menyertakan ruleId — tidak ada jalur penutupan diam-diam.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS: DEFAULT_BOUNDS } = require("./bounds");

function openContradictionSet(list, contradiction, nowIso, maxOpenContradictionSets = DEFAULT_BOUNDS.MAX_OPEN_CONTRADICTION_SETS) {
    const entry = Object.freeze({
        contradictionSetId: crypto.randomUUID(),
        subject: contradiction.subject, attribute: contradiction.attribute,
        incumbentValue: contradiction.incumbentValue,
        challengerValue: contradiction.challengerValue,
        challengerRecordId: contradiction.challengerRecordId,
        openedAt: nowIso, status: "OPEN", resolution: null
    });

    // Bug review independen (audit putaran-59, OpenCode, W7R59-P2-2): bound
    // 0 (sanksi sah lewat sanitizeBounds) dengan `list` kosong membuat
    // `list.length >= 0` true tapi TIDAK ADA `oldest` untuk dievict --
    // `oldest.status` raw-throw pada undefined. Bound dibulatkan integer
    // >= 0; kalau list kosong (tidak ada korban untuk dievict), entry BARU
    // itu sendiri yang langsung diarsipkan (tidak pernah benar-benar
    // dibuka), bukan melempar.
    const maxOpen = Math.max(0, Math.trunc(maxOpenContradictionSets));
    if (list.length >= maxOpen && list.length === 0) {
        const archivedEntry = Object.freeze({
            ...entry, status: "UNRESOLVABLE",
            resolution: Object.freeze({ ruleId: "OVERFLOW_ARCHIVE", at: nowIso })
        });
        return { list, entry: archivedEntry, evicted: archivedEntry };
    }
    if (list.length >= maxOpen) {
        // Bug diketemukan review independen (Codex, putaran ke-4): versi
        // lama menambahkan BAIK arsip lama MAUPUN entry baru ke list yang
        // sudah penuh, sehingga list tumbuh +1 setiap overflow — batas
        // tidak pernah benar-benar berlaku. List sekarang tetap tetap
        // ukurannya: slot tertua dilepas dari list yang dilacak, bentuk
        // arsipnya tetap dikembalikan lewat `evicted` supaya pemanggil bisa
        // mengeskalasi ke metakognisi tanpa modul ini menahannya selamanya.
        // Bug review independen (audit putaran-17, AUD17-P2-5): arsip overflow
        // dulu SELALU menimpa status/resolution slot tertua ke UNRESOLVABLE/
        // OVERFLOW_ARCHIVE tanpa syarat -- kalau slot tertua itu ternyata
        // SUDAH diselesaikan (RESOLVED) sebelum overflow terjadi, jejak audit
        // resolusi aslinya (ruleId sungguhan) tertimpa dan hilang, membuat
        // pengamat overflowedContradictions() percaya kontradiksi itu belum
        // pernah diselesaikan. Status/resolution asli dipertahankan kalau
        // sudah bukan OPEN.
        // Bug review independen (audit putaran-33, AUD33-P2-1): objek literal
        // `resolution` di sini dibekukan HANYA lewat Object.freeze pada entry
        // LUARnya (`{...oldest, ...}`) -- `resolution` sendiri tidak pernah
        // dibekukan (beda dengan resolveContradictionSet di bawah yang sudah
        // benar), jadi pemanggil overflowedContradictions() bisa menulis
        // ulang `resolution.ruleId` kanonik pasca-arsip tanpa restart.
        const [oldest, ...rest] = list;
        const archived = oldest.status === "OPEN"
            ? Object.freeze({ ...oldest, status: "UNRESOLVABLE", resolution: Object.freeze({ ruleId: "OVERFLOW_ARCHIVE", at: nowIso }) })
            : oldest;
        return { list: [...rest, entry], entry, evicted: archived };
    }

    return { list: [...list, entry], entry, evicted: null };
}

/** WM-A8: resolusi TANPA ruleId ditolak keras — tidak ada penutupan diam-diam. */
function resolveContradictionSet(list, contradictionSetId, ruleId, nowIso) {
    if (typeof ruleId !== "string" || ruleId.length === 0) {
        fail(REASONS.SILENT_RESOLUTION_REJECTED, "resolusi kontradiksi wajib menyertakan ruleId");
    }
    const idx = list.findIndex(c => c.contradictionSetId === contradictionSetId);
    // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
    // `${contradictionSetId}` mentah meledakkan TypeError untuk Symbol.
    if (idx === -1) {
        fail(REASONS.UNKNOWN_ENTITY, `contradictionSetId '${typeof contradictionSetId === "string" ? contradictionSetId : typeof contradictionSetId}' tidak ditemukan`);
    }

    const resolved = Object.freeze({
        ...list[idx], status: "RESOLVED", resolution: Object.freeze({ ruleId, at: nowIso })
    });
    return list.map((c, i) => (i === idx ? resolved : c));
}

module.exports = { openContradictionSet, resolveContradictionSet };
