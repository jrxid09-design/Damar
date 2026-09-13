"use strict";

/**
 * W7-L2 WORLD MODEL — himpunan kontradiksi (spec §6 CONTEST, §11, §13 WM-A8).
 * Resolusi WAJIB menyertakan ruleId — tidak ada jalur penutupan diam-diam.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");

function openContradictionSet(list, contradiction, nowIso) {
    const entry = Object.freeze({
        contradictionSetId: crypto.randomUUID(),
        subject: contradiction.subject, attribute: contradiction.attribute,
        incumbentValue: contradiction.incumbentValue,
        challengerValue: contradiction.challengerValue,
        challengerRecordId: contradiction.challengerRecordId,
        openedAt: nowIso, status: "OPEN", resolution: null
    });

    if (list.length >= BOUNDS.MAX_OPEN_CONTRADICTION_SETS) {
        // Set tertua diarsipkan sebagai UNRESOLVABLE, bukan dibuang diam-diam.
        const [oldest, ...rest] = list;
        const archived = Object.freeze({ ...oldest, status: "UNRESOLVABLE", resolution: { ruleId: "OVERFLOW_ARCHIVE", at: nowIso } });
        return { list: [...rest, archived, entry], entry, evicted: archived };
    }

    return { list: [...list, entry], entry, evicted: null };
}

/** WM-A8: resolusi TANPA ruleId ditolak keras — tidak ada penutupan diam-diam. */
function resolveContradictionSet(list, contradictionSetId, ruleId, nowIso) {
    if (typeof ruleId !== "string" || ruleId.length === 0) {
        fail(REASONS.SILENT_RESOLUTION_REJECTED, "resolusi kontradiksi wajib menyertakan ruleId");
    }
    const idx = list.findIndex(c => c.contradictionSetId === contradictionSetId);
    if (idx === -1) fail(REASONS.UNKNOWN_ENTITY, `contradictionSetId '${contradictionSetId}' tidak ditemukan`);

    const resolved = Object.freeze({
        ...list[idx], status: "RESOLVED", resolution: Object.freeze({ ruleId, at: nowIso })
    });
    return list.map((c, i) => (i === idx ? resolved : c));
}

module.exports = { openContradictionSet, resolveContradictionSet };
