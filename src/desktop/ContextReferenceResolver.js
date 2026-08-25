/**
 * CONTEXT REFERENCE RESOLVER — resolusi referensi deterministik.
 *
 * Menjawab pertanyaan seperti "ini", "gambar ini", "file ini",
 * "yang tadi" TANPA natural-language understanding: pemanggil
 * (nanti: lapisan bahasa) menerjemahkan ucapan menjadi permintaan
 * terstruktur, resolver menjawab secara deterministik dengan target,
 * confidence, provenance, reason code, dan informasi ambiguitas.
 *
 * Aturan mutlak: bila ada beberapa kandidat sama-sama sah, resolver
 * TIDAK menebak — mengembalikan status AMBIGUOUS beserta kandidat.
 */

const { ENTITY_TYPE, REASON_CODE, TRANSITION } = require("./types");

const RESOLUTION_KIND = {
    ACTIVE_APPLICATION: "active_application",
    ACTIVE_WINDOW: "active_window",
    ACTIVE_DOCUMENT: "active_document",
    CURRENT_SELECTION: "current_selection",
    SELECTED_FILES: "selected_files",
    ACTIVE_VISUAL: "active_visual",
    CURRENT_WORKSPACE: "current_workspace",
    RECENT_CONTEXT: "recent_context",
    ENTITY: "entity"
};

/**
 * resolve(view, request) →
 * {
 *   status: "resolved" | "ambiguous" | "unavailable",
 *   targets: [entity...], candidates: [entity...],
 *   confidence, provenance: [...], reasonCode, detail?
 * }
 *
 * `view` bisa DesktopContextCore (live) atau ContextSnapshot (immutable).
 */
function resolve(view, request = {}) {

    const kind = request.kind;
    if (!Object.values(RESOLUTION_KIND).includes(kind)) {
        return unavailable([], REASON_CODE.UNKNOWN_RESOLUTION_KIND,
            `kind resolusi tidak dikenal: ${kind}`);
    }

    switch (kind) {

        case RESOLUTION_KIND.ACTIVE_APPLICATION:
            return single(view, activeId(view, "applicationId"), REASON_CODE.NO_ACTIVE_APPLICATION);

        case RESOLUTION_KIND.ACTIVE_WINDOW:
            return single(view, activeId(view, "windowId"), REASON_CODE.NO_ACTIVE_WINDOW);

        case RESOLUTION_KIND.ACTIVE_DOCUMENT:
            return single(view, activeId(view, "documentId"), REASON_CODE.NO_ACTIVE_DOCUMENT);

        case RESOLUTION_KIND.CURRENT_SELECTION:
            return resolveCurrentSelection(view, request.constraints ?? {});

        case RESOLUTION_KIND.SELECTED_FILES:
            return resolveSelectedFiles(view);

        case RESOLUTION_KIND.ACTIVE_VISUAL:
            return single(view, activeId(view, "visualId"), REASON_CODE.NO_VISUAL_CONTEXT);

        case RESOLUTION_KIND.CURRENT_WORKSPACE:
            return single(view, activeId(view, "workspaceId"), REASON_CODE.NO_WORKSPACE);

        case RESOLUTION_KIND.RECENT_CONTEXT:
            return resolveRecentContext(view, request.constraints ?? {});

        case RESOLUTION_KIND.ENTITY:
            return resolveEntityById(view, request.entityId);

        default:
            return unavailable([], REASON_CODE.UNKNOWN_RESOLUTION_KIND, kind);
    }
}

// ---- per-kind -------------------------------------------------------------

/** Core view menyimpan id; snapshot menyimpan entity — normalkan ke id. */
function activeId(view, key) {
    const v = view.active?.[key];
    if (!v) return null;
    return typeof v === "object" ? v.id : v;
}

function resolveCurrentSelection(view, constraints) {

    // Kumpulan seleksi yang masih hidup (lintas jendela).
    const live = [...view.entities.values()]
        .filter((e) => e.type === ENTITY_TYPE.TEXT_SELECTION && !e.invalid);

    let pool = live;
    if (constraints.windowId) {
        pool = live.filter((e) => relationshipsOf(view).some((r) =>
            r.relation === "selected_in" && r.from === e.id && r.to === constraints.windowId));
        if (pool.length === 0) {
            return unavailable([], REASON_CODE.CONSTRAINT_UNMATCHED,
                `tidak ada seleksi hidup di window ${constraints.windowId}`);
        }
    }

    if (pool.length === 1) {
        return ok([pool[0]], pool, pool[0].confidence);
    }
    if (pool.length > 1) {
        return ambiguous(pool,
            `${pool.length} seleksi hidup; tidak ada dasar deterministik memilih satu`);
    }

    // Nol kandidat hidup: apakah karena basi atau memang kosong?
    if (activeId(view, "selectionGroupId")) {
        return unavailable([], REASON_CODE.STALE_CONTEXT, "seleksi aktif sudah basi/invalid");
    }
    return unavailable([], REASON_CODE.NO_SELECTION, "tidak ada teks terpilih");
}

function resolveSelectedFiles(view) {
    const group = liveEntity(view, activeId(view, "fileSelectionGroupId"));
    if (!group) {
        return unavailable([], REASON_CODE.NO_SELECTED_FILES, "tidak ada grup seleksi file aktif");
    }
    const files = relationshipsOf(view)
        .filter((r) => r.relation === "belongs_to" && r.to === group.id)
        .map((r) => liveEntity(view, r.from))
        .filter(Boolean);
    if (files.length === 0) {
        return unavailable([group], REASON_CODE.NO_SELECTED_FILES,
            "grup seleksi ada tanpa anggota file yang hidup");
    }
    const confidence = Math.min(group.confidence, ...files.map((f) => f.confidence));
    return ok(files, files, confidence);
}

function resolveRecentContext(view, constraints) {
    if (historyOf(view).length === 0) {
        return unavailable([], REASON_CODE.HISTORY_EMPTY, "riwayat transisi kosong");
    }

    const wantedTypes = constraints.transitionTypes ?? null;
    const wantedEntityType = constraints.entityType ?? null;

    for (let i = historyOf(view).length - 1; i >= 0; i--) {
        const t = historyOf(view)[i];
        if (wantedTypes && !wantedTypes.includes(t.transitionType)) continue;
        for (const id of t.subjectIds) {
            const e = liveEntity(view, id);
            if (!e) continue;
            if (wantedEntityType && e.type !== wantedEntityType) continue;
            if (constraints.excludeTransitionId && t.id === constraints.excludeTransitionId) continue;
            return ok([e], [e], e.confidence);
        }
    }

    void TRANSITION;
    return unavailable([], REASON_CODE.CONSTRAINT_UNMATCHED,
        "tidak ada entitas hidup dalam riwayat yang cocok constraint");
}

function resolveEntityById(view, entityId) {
    if (!entityId || typeof entityId !== "string") {
        return unavailable([], REASON_CODE.CONSTRAINT_UNMATCHED, "entityId wajib string");
    }
    const e = view.entities.get?.(entityId) ??
        view.entities.find?.((x) => x.id === entityId);
    if (!e) {
        return unavailable([], REASON_CODE.CONSTRAINT_UNMATCHED, `entitas tidak dikenal: ${entityId}`);
    }
    if (e.invalid) {
        return unavailable([], REASON_CODE.STALE_CONTEXT, e.staleReason ?? "invalid");
    }
    return ok([e], [e], e.confidence);
}

// ---- helpers ---------------------------------------------------------------

function single(view, entityId, emptyReason) {
    const e = liveEntity(view, entityId);
    if (!e) return unavailable([], emptyReason, "pointer aktif kosong atau basi");
    return ok([e], [e], e.confidence);
}

function liveEntity(view, id) {
    if (!id) return null;
    const e = view.entities.get?.(id);
    const found = e ?? view.entities.find?.((x) => x.id === id) ?? null;
    return found && !found.invalid ? found : null;
}

function relationshipsOf(view) {
    return view.relationships ?? [];
}

/** Core view memakai `history`; snapshot memakai `recentTransitions`. */
function historyOf(view) {
    return view.recentTransitions ?? view.history ?? [];
}

function ok(targets, candidates, confidence) {
    return {
        status: "resolved",
        targets: [...targets],
        candidates: [...candidates],
        confidence,
        provenance: targets.map((t) => t.provenance),
        reasonCode: REASON_CODE.RESOLVED
    };
}

function ambiguous(candidates, detail) {
    return {
        status: "ambiguous",
        targets: [],
        candidates: [...candidates],
        confidence: null,
        provenance: candidates.map((c) => c.provenance),
        reasonCode: REASON_CODE.AMBIGUOUS_TARGETS,
        detail
    };
}

function unavailable(candidates, reasonCode, detail) {
    return {
        status: "unavailable",
        targets: [],
        candidates: [...candidates],
        confidence: null,
        provenance: [],
        reasonCode,
        detail
    };
}

module.exports = { resolve, RESOLUTION_KIND };
