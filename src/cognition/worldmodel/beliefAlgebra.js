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
function buildSafeBeliefValue(value, depth = 0, stack, budget) {
    // Bug review independen (audit putaran-5, W7R5-P1-2): versi putaran-4
    // tidak punya anggaran jumlah node (seperti ENVELOPE_BOUNDS.MAX_PAYLOAD_NODES
    // di core/envelope.js) maupun deteksi siklik berbasis stack -- sebuah DAG
    // referensi-bersama (BUKAN siklus, jadi bukan dilarang secara struktural)
    // disalin ulang independen di setiap kemunculan; dengan fanout kecil dan
    // kedalaman dalam batas MAX_VALUE_SCAN_DEPTH, ini meledak eksponensial
    // (miliaran salinan) -- DoS trivial. `stack`/`budget` sekarang diwariskan
    // rekursif sepanjang SATU panggilan (dibuat baru hanya di titik masuk).
    if (!stack) stack = new WeakSet();
    if (!budget) budget = { count: 0 };

    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa Symbol");
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa BigInt");
    if (t !== "object") return value;
    if (depth > BOUNDS.MAX_VALUE_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    if (stack.has(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "struktur siklik terdeteksi pada value");
    }
    budget.count += 1;
    if (budget.count > BOUNDS.MAX_VALUE_NODES) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah node pada value melebihi batas");
    }

    if (Array.isArray(value)) {
        if (value.length > BOUNDS.MAX_VALUE_ARRAY_LENGTH) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array pada value melebihi batas");
        }
        const arrProto = Object.getPrototypeOf(value);
        if (arrProto !== Array.prototype && arrProto !== null) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh berupa array dengan prototype non-standar");
        }
        stack.add(value);
        const out = [];
        try {
            for (let i = 0; i < value.length; i++) {
                const desc = Object.getOwnPropertyDescriptor(value, i);
                if (!desc || desc.get || desc.set) {
                    fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `value tidak boleh membawa properti accessor: '${i}'`);
                }
                const built = buildSafeBeliefValue(desc.value, depth + 1, stack, budget);
                out[i] = built === undefined ? null : built;
            }
        } finally {
            stack.delete(value);
        }
        return Object.freeze(out);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh berupa instance kelas (kontrak data murni)");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > BOUNDS.MAX_VALUE_KEYS) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah kunci pada value melebihi batas");
    }
    stack.add(value);
    const out = {};
    try {
    for (const key of keys) {
        if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "value tidak boleh membawa kunci Symbol");
        if (DANGEROUS_VALUE_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc || desc.get || desc.set) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `value tidak boleh membawa properti accessor: '${String(key)}'`);
        }
        const built = buildSafeBeliefValue(desc.value, depth + 1, stack, budget);
        if (built !== undefined) out[key] = built;
    }
    } finally {
        stack.delete(value);
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
    // Bug review independen (audit putaran-5, W7R5-P2-1): `subject` juga
    // disimpan mentah lewat ingestDeclaration -- pemanggil yang memutasi
    // objek subject aslinya SETELAH ingest menulis ulang subject pada
    // belief/kontradiksi tersimpan (makeObservation sudah freeze subject-nya
    // sendiri, ingestDeclaration tidak).
    record = { ...record, value: buildSafeBeliefValue(record.value), subject: buildSafeBeliefValue(record.subject) };

    if (!existing) {
        // Kelahiran pertama — setara REFRESH dari ketiadaan.
        return {
            case: "REFRESH",
            belief: Object.freeze({
                beliefId: `${record.subjectKey}::${record.attribute}`,
                subject: record.subject, attribute: record.attribute,
                value: record.value, revision: 1,
                supportedBy: Object.freeze([record.recordId]),
                appliedRecordIds: Object.freeze([record.recordId]),
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

    // Bug review independen (audit putaran-9, AUD9-P1-1): pengiriman ulang
    // observationId/declarationId yang sama (replay lintas-node) dulu
    // dihitung sebagai REINFORCE baru -- revision naik dan record.recordId
    // yang SAMA ditambahkan lagi ke supportedBy, memalsukan korroborasi
    // (computeConfidence pakai Math.min(supportedBy.length,5)/5, jadi satu
    // sumber yang di-replay 5x mencapai confidence maksimum seolah 5 sumber
    // independen). recordId yang sudah ada di supportedBy adalah no-op.
    // Bug review independen (audit putaran-11, AUD11-P2-7): cek di atas
    // hanya melihat `supportedBy`, yang DIRESET oleh SUPERSEDE (§ dibawah)
    // -- record yang sudah dikonsumsi lalu di-supersede lalu di-replay lolos
    // dedup dan dianggap CONTEST baru terhadap nilai yang sekarang berlaku,
    // memalsukan status kontradiksi belief yang sudah tidak kontroversial.
    // `appliedRecordIds` adalah riwayat SEMUA recordId yang pernah diterapkan
    // ke belief ini, tidak pernah direset oleh SUPERSEDE.
    if ((existing.appliedRecordIds ?? existing.supportedBy).includes(record.recordId)) {
        return { case: "DUPLICATE", belief: existing, contradiction: null };
    }

    const sameValue = JSON.stringify(existing.value) === JSON.stringify(record.value);
    const expired = isExpired(existing, nowMs);
    const newerOrEqualTier = TIER_RANK[record.tier] >= TIER_RANK[existing.tier];
    const newerInTime = record.observedAtMs === undefined || record.observedAtMs >= (existing.observedAtMs ?? 0);

    const nextAppliedRecordIds = Object.freeze(appendBounded(
        existing.appliedRecordIds ?? existing.supportedBy, record.recordId,
        BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF));

    if (sameValue && !expired) {
        // REINFORCE
        return {
            case: "REINFORCE",
            belief: Object.freeze({
                ...existing,
                revision: existing.revision + 1,
                supportedBy: Object.freeze(appendBounded(existing.supportedBy, record.recordId,
                    BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF)),
                appliedRecordIds: nextAppliedRecordIds,
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
                appliedRecordIds: nextAppliedRecordIds,
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
                appliedRecordIds: nextAppliedRecordIds,
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
