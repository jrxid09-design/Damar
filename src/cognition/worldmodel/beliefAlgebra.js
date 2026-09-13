"use strict";

/**
 * W7-L2 WORLD MODEL — aljabar revisi keyakinan (spec §6) + peluruhan
 * baca-waktu (spec §7). Satu-satunya tempat sebuah WorldBelief lahir atau
 * berevolusi. TIDAK PERNAH memutasi record lama di tempat (§3 "BELIEF
 * REVISION != OVERWRITE") — selalu mengembalikan revisi BARU.
 *
 * confidence TIDAK PERNAH menjadi field yang ditulis di sini — itu murni
 * hasil query.js pada saat baca (WM-A9).
 */

const { BOUNDS } = require("./bounds");
const { REASONS, fail } = require("./errors");

const TIER_RANK = Object.freeze({ T4: 1, T2: 2, T1: 3, DECLARED: 4 });
const DANGEROUS_VALUE_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/**
 * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * putaran-4, W7R4-P1-1/W7R4-P2-1): sebelumnya `record.value` disimpan APA
 * ADANYA -- lewat referensi mentah untuk ingestDeclaration, atau lewat
 * `JSON.parse(JSON.stringify(value))` untuk ingestObservation (yang
 * mengeksekusi `toJSON` pemanggil sebelum validasi apa pun, kelas bug yang
 * sama yang sudah diperbaiki secara arsitektural putaran-3 untuk
 * prospective/envelope/goals, tapi belum dimigrasikan ke worldmodel).
 * `query()` juga mengembalikan `belief.value` mentah -- pemanggil yang
 * memutasi hasil query() menulis ulang belief tersimpan TANPA revisi baru,
 * melanggar "BELIEF REVISION != OVERWRITE" (§3). Satu lintasan aman di sini
 * (dipanggil SEKALI di titik belief lahir/berevolusi) menutup KEDUANYA:
 * validasi+salin+bekukan value SEBELUM pernah menjadi bagian dari belief.
 */
function buildSafeBeliefValue(value, depth = 0) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa Symbol");
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa BigInt");
    if (t !== "object") return value;
    if (depth > BOUNDS.MAX_VALUE_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }

    if (Array.isArray(value)) {
        if (value.length > BOUNDS.MAX_VALUE_ARRAY_LENGTH) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array pada value melebihi batas");
        }
        const arrProto = Object.getPrototypeOf(value);
        if (arrProto !== Array.prototype && arrProto !== null) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh berupa array dengan prototype non-standar");
        }
        const out = [];
        for (let i = 0; i < value.length; i++) {
            const desc = Object.getOwnPropertyDescriptor(value, i);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `value tidak boleh membawa properti accessor: '${i}'`);
            }
            const built = buildSafeBeliefValue(desc.value, depth + 1);
            out[i] = built === undefined ? null : built;
        }
        return Object.freeze(out);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh berupa instance kelas (kontrak data murni)");
    }
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa kunci Symbol");
        if (DANGEROUS_VALUE_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc || desc.get || desc.set) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `value tidak boleh membawa properti accessor: '${String(key)}'`);
        }
        const built = buildSafeBeliefValue(desc.value, depth + 1);
        if (built !== undefined) out[key] = built;
    }
    return Object.freeze(out);
}

const DEFAULT_DECAY_POLICY = Object.freeze({ ttlMs: 30 * 60_000, decayKind: "STEP" });

function isExpired(belief, nowMs) {
    const policy = belief.decayPolicy ?? DEFAULT_DECAY_POLICY;
    if (policy.decayKind === "NONE") return false;
    return (nowMs - belief.updatedAtMs) > policy.ttlMs;
}

/** Kelas epistemik yang terlihat lewat query — dihitung, bukan disimpan tetap. */
function epistemicClassOf(belief, nowMs) {
    if (belief.tier !== "DECLARED" && isExpired(belief, nowMs)) return "STALE";
    return "OBSERVED";
}

function appendBounded(list, item, max) {
    const next = [...list, item];
    return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Terapkan satu record baru (`recordId`, `value`, `tier`, `observedAt`,
 * `observedAtMs`) ke belief subject/attribute yang ada (atau null bila
 * belum ada). Mengembalikan `{ case, belief, contradiction }` —
 * `contradiction` non-null hanya pada kasus CONTEST.
 */
function applyRevision({ existing, record, nowMs, decayPolicy = DEFAULT_DECAY_POLICY }) {
    // record.value divalidasi+disalin+dibekukan DI SINI, satu-satunya
    // tempat belief lahir/berevolusi -- menutup W7R4-P1-1 (query() dan
    // ingestDeclaration menyimpan/mengembalikan referensi mentah yang bisa
    // dimutasi pemanggil) dan W7R4-P2-1 (toJSON pemanggil bisa tereksekusi
    // sebelum validasi) sekaligus, untuk ingestObservation MAUPUN
    // ingestDeclaration.
    record = { ...record, value: buildSafeBeliefValue(record.value) };

    if (!existing) {
        // Kelahiran pertama — setara REFRESH dari ketiadaan.
        return {
            case: "REFRESH",
            belief: Object.freeze({
                beliefId: `${record.subjectKey}::${record.attribute}`,
                subject: record.subject, attribute: record.attribute,
                value: record.value, revision: 1,
                supportedBy: Object.freeze([record.recordId]),
                contradictedBy: Object.freeze([]),
                contradictionSetId: null,
                tier: record.tier,
                decayPolicy,
                updatedAtMs: nowMs, observedAt: record.observedAt,
                observedAtMs: record.observedAtMs ?? nowMs
            }),
            contradiction: null
        };
    }

    const sameValue = JSON.stringify(existing.value) === JSON.stringify(record.value);
    const expired = isExpired(existing, nowMs);
    const newerOrEqualTier = TIER_RANK[record.tier] >= TIER_RANK[existing.tier];
    const newerInTime = record.observedAtMs === undefined || record.observedAtMs >= (existing.observedAtMs ?? 0);

    if (sameValue && !expired) {
        // REINFORCE
        return {
            case: "REINFORCE",
            belief: Object.freeze({
                ...existing,
                revision: existing.revision + 1,
                supportedBy: Object.freeze(appendBounded(existing.supportedBy, record.recordId,
                    BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF)),
                updatedAtMs: nowMs
            }),
            contradiction: null
        };
    }

    if (sameValue && expired) {
        // REFRESH
        return {
            case: "REFRESH",
            belief: Object.freeze({
                ...existing,
                revision: existing.revision + 1,
                supportedBy: Object.freeze(appendBounded(existing.supportedBy, record.recordId,
                    BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF)),
                updatedAtMs: nowMs, observedAt: record.observedAt,
                observedAtMs: record.observedAtMs ?? nowMs
            }),
            contradiction: null
        };
    }

    if (!sameValue && expired && newerOrEqualTier && newerInTime) {
        // SUPERSEDE — revisi lama dipertahankan dalam `supersedes`, bukan ditimpa diam-diam.
        return {
            case: "SUPERSEDE",
            belief: Object.freeze({
                beliefId: existing.beliefId, subject: existing.subject, attribute: existing.attribute,
                value: record.value, revision: existing.revision + 1,
                supportedBy: Object.freeze([record.recordId]),
                contradictedBy: Object.freeze([]),
                contradictionSetId: null,
                tier: record.tier, decayPolicy: existing.decayPolicy,
                updatedAtMs: nowMs, observedAt: record.observedAt,
                observedAtMs: record.observedAtMs ?? nowMs,
                supersedes: Object.freeze({ revision: existing.revision, value: existing.value })
            }),
            contradiction: null
        };
    }

    // CONTEST — nilai tidak berubah; kontradiksi dibuka.
    return {
        case: "CONTEST",
        belief: existing, // TIDAK berubah (§3, §6 CONTEST: "no value change")
        contradiction: {
            subject: existing.subject, attribute: existing.attribute,
            incumbentValue: existing.value, challengerValue: record.value,
            challengerRecordId: record.recordId, at: record.observedAt
        }
    };
}

module.exports = {
    TIER_RANK, DEFAULT_DECAY_POLICY, isExpired, epistemicClassOf, applyRevision, buildSafeBeliefValue
};
