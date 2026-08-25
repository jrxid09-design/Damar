/**
 * CONTEXT SNAPSHOT — proyeksi immutable dari keadaan desktop.
 *
 * Snapshot dibekukan dalam: perubahan observasi berikutnya menghasilkan
 * snapshot baru, bukan mengubah yang lama.
 *
 * Identitas snapshot DITURUNKAN dari konten (SHA-256 atas bentuk
 * stabil) sehingga dua core dengan state logis sama menghasilkan
 * snapshot identik — konvergensi urutan kedatangan teruji mekanis.
 *
 * DESERIALIZASI ADALAH BATAS INPUT TAK TERPERCAYA (B1): JSON rebuild
 * divalidasi skema penuh (enum, referensi endpoint, tipe pointer,
 * field asing) DAN verifikasi integritas hash konten. State palsu
 * gagal tertutup dengan error terstruktur — tidak pernah menjadi
 * state yang terlihat kognisi.
 */

const crypto = require("node:crypto");
const ContextEntity = require("./ContextEntity");
const { stableStringify } = require("./StableJson");
const {
    ENTITY_TYPE,
    RELATIONSHIP,
    TRANSITION,
    POINTER_ENTITY_TYPES,
    SCHEMA_VERSION
} = require("./types");

const ID_PREFIX = "aether-desktop-dctx-";

const SNAPSHOT_KEYS = Object.freeze([
    "isContextSnapshot", "schemaVersion", "desktopContextId", "createdAt",
    "sourceVersion", "entities", "relationships", "active", "selectedFiles",
    "recentTransitions", "historyBound", "historyTruncated"
]);

const ENTITY_KEYS = Object.freeze([
    "id", "type", "label", "attributes", "confidence", "provenance",
    "claimedProvenance", "observedAt", "revision", "invalid", "staleReason"
]);

const RELATIONSHIP_KEYS = Object.freeze(["from", "relation", "to"]);

const TRANSITION_KEYS = Object.freeze([
    "id", "transitionType", "at", "observationId", "source", "subjectIds"
]);

const ACTIVE_KEYS = Object.freeze(Object.keys(POINTER_ENTITY_TYPES));

/**
 * Bangun snapshot frozen dari view core. Entitas/relasi/riwayat
 * diurutkan deterministik; id diturunkan dari hash konten.
 */
function build({ view, createdAt, maxSnapshotBytes = 65536 }) {

    const entities = [...view.entities.values()]
        .filter((e) => !e.invalid)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => ({ ...e }));

    const entityIds = new Set(entities.map((e) => e.id));

    const relationships = [...view.relationships]
        .filter((r) => entityIds.has(r.from) && entityIds.has(r.to))
        .sort((a, b) =>
            (`${a.from}|${a.relation}|${a.to}` < `${b.from}|${b.relation}|${b.to}` ? -1 : 1))
        .map((r) => ({ ...r }));

    const active = {};
    for (const key of ACTIVE_KEYS) {
        const id = view.active[key] ?? null;
        active[key] = id !== null && entityIds.has(id) ? id : null;
    }

    // Berkas pada grup seleksi aktif: FILE yang BELONGS_TO grup.
    const selectedFiles = [];
    const groupId = active.fileSelectionGroupId;
    if (groupId) {
        for (const r of relationships) {
            if (r.relation === RELATIONSHIP.BELONGS_TO && r.to === groupId) {
                const f = entities.find((e) => e.id === r.from);
                if (f) selectedFiles.push({ ...f });
            }
        }
        selectedFiles.sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    const recentTransitions = view.recentTransitions.map((t) => ({ ...t }));

    const assemble = (transitions) => {
        const content = {
            schemaVersion: SCHEMA_VERSION,
            createdAt,
            sourceVersion: view.version,
            entities,
            relationships,
            active,
            selectedFiles,
            recentTransitions: transitions,
            historyBound: view.historyBound,
            historyTruncated: view.historyTruncated
        };
        const hash = crypto.createHash("sha256")
            .update(stableStringify(content), "utf8")
            .digest("hex");
        return {
            snapshot: ContextEntity.deepFreeze({
                isContextSnapshot: true,
                desktopContextId: `${ID_PREFIX}${hash}`,
                ...content
            })
        };
    };

    let built = assemble(recentTransitions);
    let json = serialize(built.snapshot);

    // Batas byte snapshot (B8): buang transisi terlama sampai muat;
    // tetap lebih besar → gagal tertutup.
    while (Buffer.byteLength(json, "utf8") > maxSnapshotBytes &&
           recentTransitions.length > 0) {
        recentTransitions.shift();
        built = assemble(recentTransitions);
        json = serialize(built.snapshot);
    }
    if (Buffer.byteLength(json, "utf8") > maxSnapshotBytes) {
        const err = new Error(
            `snapshot melebihi batas ${maxSnapshotBytes} byte bahkan tanpa riwayat`);
        err.code = "SNAPSHOT_TOO_LARGE";
        throw err;
    }

    return built.snapshot;
}

/** JSON aman (plain object) untuk audit/rebuild. */
function serialize(snapshot) {
    return JSON.stringify(snapshot);
}

class SnapshotValidationError extends Error {
    constructor(errors) {
        super(`snapshot tidak sah (${errors.length} pelanggaran): ${errors.join("; ")}`);
        this.name = "SnapshotValidationError";
        this.code = "INVALID_SNAPSHOT";
        this.errors = errors;
    }
}

function fail(errors, cause) {
    const err = new SnapshotValidationError(errors);
    if (cause) err.cause = cause;
    return err;
}

/** Bangun ulang snapshot dari JSON tak terpercaya — validasi ketat. */
function deserialize(json, { verifyIntegrity = true } = {}) {

    let plain;
    try {
        plain = typeof json === "string" ? JSON.parse(json) : JSON.parse(JSON.stringify(json));
    } catch (err) {
        throw fail(["JSON tidak dapat diparse"], err);
    }

    if (!isPlainObject(plain)) throw fail(["payload harus objek"]);

    const errors = [];
    checkKeys(plain, SNAPSHOT_KEYS, "snapshot", errors);

    if (plain.isContextSnapshot !== true) errors.push("isContextSnapshot harus true");
    if (plain.schemaVersion !== SCHEMA_VERSION) {
        errors.push(`schemaVersion harus ${SCHEMA_VERSION}`);
    }
    if (typeof plain.desktopContextId !== "string" ||
        !(new RegExp(`^${ID_PREFIX}[0-9a-f]{64}$`)).test(plain.desktopContextId)) {
        errors.push("desktopContextId tidak sesuai format hash");
    }
    if (!Number.isFinite(plain.createdAt) || plain.createdAt <= 0) {
        errors.push("createdAt harus epoch ms positif");
    }
    if (!Number.isFinite(plain.sourceVersion) || plain.sourceVersion < 0) {
        errors.push("sourceVersion harus angka >= 0");
    }
    if (!Number.isInteger(plain.historyBound) || plain.historyBound < 1) {
        errors.push("historyBound harus integer >= 1");
    }
    if (typeof plain.historyTruncated !== "boolean") {
        errors.push("historyTruncated harus boolean");
    }

    // ---- entitas -----------------------------------------------------------
    if (!Array.isArray(plain.entities)) {
        errors.push("entities harus array");
    } else {
        const byId = new Set();
        for (const [i, e] of plain.entities.entries()) {
            const path = `entities[${i}]`;
            if (!isPlainObject(e)) {
                errors.push(`${path}: bukan objek`);
                continue;
            }
            checkKeys(e, ENTITY_KEYS, path, errors);
            if (typeof e.id !== "string" || !e.id) errors.push(`${path}.id tidak sah`);
            else if (byId.has(e.id)) errors.push(`${path}.id duplikat: ${e.id}`);
            if (typeof e.id === "string" && e.id) byId.add(e.id);
            if (!Object.values(ENTITY_TYPE).includes(e.type)) {
                errors.push(`${path}.type tidak dikenal: ${e.type}`);
            }
            if (typeof e.label !== "string") errors.push(`${path}.label harus string`);
            if (!isPlainObject(e.attributes)) errors.push(`${path}.attributes harus objek`);
            if (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) {
                errors.push(`${path}.confidence di luar 0..1`);
            }
            if (typeof e.provenance !== "string" ||
                !e.provenance.startsWith("adapter:")) {
                errors.push(`${path}.provenance harus struktur 'adapter:<id>'`);
            }
            if (e.claimedProvenance !== null && typeof e.claimedProvenance !== "string") {
                errors.push(`${path}.claimedProvenance harus string atau null`);
            }
            if (e.observedAt !== null && !Number.isFinite(e.observedAt)) {
                errors.push(`${path}.observedAt harus number atau null`);
            }
            if (!Number.isInteger(e.revision) || e.revision < 1) {
                errors.push(`${path}.revision harus integer >= 1`);
            }
            if (e.invalid !== false || e.staleReason !== null) {
                errors.push(`${path}: snapshot hanya memuat entitas hidup`);
            }
        }
    }

    // ---- relasi -----------------------------------------------------------------
    if (!Array.isArray(plain.relationships)) {
        errors.push("relationships harus array");
    } else {
        const entityIds = new Set((plain.entities ?? [])
            .filter((e) => isPlainObject(e) && typeof e.id === "string")
            .map((e) => e.id));
        const seenRel = new Set();
        for (const [i, r] of plain.relationships.entries()) {
            const path = `relationships[${i}]`;
            if (!isPlainObject(r)) {
                errors.push(`${path}: bukan objek`);
                continue;
            }
            checkKeys(r, RELATIONSHIP_KEYS, path, errors);
            if (!Object.values(RELATIONSHIP).includes(r.relation)) {
                errors.push(`${path}.relation tidak dikenal: ${r.relation}`);
            }
            if (typeof r.from !== "string" || !entityIds.has(r.from)) {
                errors.push(`${path}.from menunjuk entitas absen: ${String(r.from)}`);
            }
            if (typeof r.to !== "string" || !entityIds.has(r.to)) {
                errors.push(`${path}.to menunjuk entitas absen: ${String(r.to)}`);
            }
            const key = `${r.from}|${r.relation}|${r.to}`;
            if (seenRel.has(key)) errors.push(`${path}: relasi duplikat ${key}`);
            seenRel.add(key);
        }
    }

    // ---- pointer aktif ------------------------------------------------------------
    if (!isPlainObject(plain.active)) {
        errors.push("active harus objek");
    } else {
        checkKeys(plain.active, ACTIVE_KEYS, "active", errors);
        const entityById = new Map((plain.entities ?? [])
            .filter((e) => isPlainObject(e) && typeof e.id === "string")
            .map((e) => [e.id, e]));
        for (const key of ACTIVE_KEYS) {
            const id = plain.active[key];
            if (id === null || id === undefined) continue;
            if (typeof id !== "string") {
                errors.push(`active.${key} harus id string atau null`);
                continue;
            }
            const target = entityById.get(id);
            if (!target) {
                errors.push(`active.${key} menunjuk entitas absen: ${id}`);
                continue;
            }
            if (!POINTER_ENTITY_TYPES[key].includes(target.type)) {
                errors.push(`active.${key} tipe salah untuk pointer: ${target.type}`);
            }
        }
    }

    // ---- selectedFiles -----------------------------------------------------------------
    if (!Array.isArray(plain.selectedFiles)) {
        errors.push("selectedFiles harus array");
    } else {
        const entityById = new Map((plain.entities ?? [])
            .filter((e) => isPlainObject(e) && typeof e.id === "string")
            .map((e) => [e.id, e]));
        for (const [i, f] of plain.selectedFiles.entries()) {
            const target = isPlainObject(f) ? entityById.get(f.id) : null;
            if (!target) {
                errors.push(`selectedFiles[${i}] bukan entitas snapshot ini`);
            } else if (f.type !== ENTITY_TYPE.FILE || target.type !== ENTITY_TYPE.FILE) {
                errors.push(`selectedFiles[${i}] tipe bukan file`);
            }
        }
    }

    // ---- riwayat transisi ------------------------------------------------------------------
    if (!Array.isArray(plain.recentTransitions)) {
        errors.push("recentTransitions harus array");
    } else {
        for (const [i, t] of plain.recentTransitions.entries()) {
            const path = `recentTransitions[${i}]`;
            if (!isPlainObject(t)) {
                errors.push(`${path}: bukan objek`);
                continue;
            }
            checkKeys(t, TRANSITION_KEYS, path, errors);
            if (!Object.values(TRANSITION).includes(t.transitionType)) {
                errors.push(`${path}.transitionType tidak dikenal: ${t.transitionType}`);
            }
            if (typeof t.id !== "string" || !t.id) errors.push(`${path}.id tidak sah`);
            if (!Number.isFinite(t.at)) errors.push(`${path}.at harus number`);
            if (typeof t.observationId !== "string" || !t.observationId) {
                errors.push(`${path}.observationId tidak sah`);
            }
            if (typeof t.source !== "string" || !t.source) {
                errors.push(`${path}.source tidak sah`);
            }
            if (!Array.isArray(t.subjectIds) ||
                t.subjectIds.some((x) => typeof x !== "string")) {
                errors.push(`${path}.subjectIds harus array string`);
            }
        }
        if (plain.recentTransitions.length > plain.historyBound) {
            errors.push("recentTransitions melampaui historyBound");
        }
    }

    if (errors.length > 0) throw fail(errors);

    // ---- integritas konten (restore attack terdeteksi di sini) --------------------
    if (verifyIntegrity) {
        const content = {
            schemaVersion: plain.schemaVersion,
            createdAt: plain.createdAt,
            sourceVersion: plain.sourceVersion,
            entities: plain.entities,
            relationships: plain.relationships,
            active: plain.active,
            selectedFiles: plain.selectedFiles,
            recentTransitions: plain.recentTransitions,
            historyBound: plain.historyBound,
            historyTruncated: plain.historyTruncated
        };
        const expected = `${ID_PREFIX}${crypto.createHash("sha256")
            .update(stableStringify(content), "utf8")
            .digest("hex")}`;
        if (expected !== plain.desktopContextId) {
            throw fail(["integritas konten gagal: hash tidak cocok " +
                `(diharapkan ${expected}, didapat ${plain.desktopContextId})`]);
        }
    }

    return ContextEntity.deepFreeze(JSON.parse(JSON.stringify(plain)));

}

// ---- util -------------------------------------------------------------------

function checkKeys(obj, allowed, path, errors) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(obj)) {
        if (!allowedSet.has(key)) errors.push(`${path}.${key}: field tak dikenal`);
    }
}

function isPlainObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

module.exports = { build, serialize, deserialize, SnapshotValidationError };
