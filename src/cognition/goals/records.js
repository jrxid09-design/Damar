"use strict";

/** W7-L3 GOALS — pembangun record murni (spec §3, §5, §6). */

const { REASONS, fail } = require("./errors");

const GOAL_KINDS = new Set(["OWNER_ASSIGNED", "SELF_PROPOSED", "MISSION_DERIVED", "MAINTENANCE"]);
const ORIGIN_KINDS = new Set(["OWNER", "SELF", "MISSION", "AGENT_SUGGESTION"]);
const PRIORITY_CLASSES = new Set(["CRITICAL", "HIGH", "NORMAL", "LOW", "BACKGROUND"]);

/**
 * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * independen putaran-1, AUD-P2-4): makeTask menyebar intentTemplate tanpa
 * pagar kunci terlarang -- authProof/grant/balance bisa masuk lalu
 * persisten lewat restart, melemahkan klaim struktural GOAL != AUTHORITY
 * (pola yang sama sudah dipagari di prospective/longhorizon).
 */
const FORBIDDEN_INTENT_KEYS = Object.freeze([
    "authProof", "authorityDecision", "grant", "capabilityGrant",
    "executionLease", "balance", "allow", "owner", "executor",
    "route", "trustedNode", "rootAuthority"
]);
const DANGEROUS_INTENT_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
const INTENT_ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_INTENT_SCAN_DEPTH = 16;
const MAX_INTENT_ARRAY_LENGTH = 1024;

/**
 * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * putaran-3, AUD3-P1-1/AUD3-P1-2): satu lintasan yang MEMVALIDASI dan
 * MEMBANGUN salinan aman sekaligus -- sama seperti perbaikan di
 * prospective/records.js dan core/envelope.js. Versi lama (putaran-2)
 * memvalidasi lewat pemeriksaan descriptor lalu membekukan OBJEK ASLI
 * pemanggil (`deepFreeze(intentTemplate)`); sebuah Proxy dengan trap
 * `get`/`getPrototypeOf`/`ownKeys` konsisten-tapi-bohong tetap bisa
 * memalsukan nilai saat dibaca ulang, dan node perantara yang sudah beku
 * atau properti non-enumerable bisa melindungi anak yang masih bisa
 * diubah dari `deepFreeze`. Sekarang nilai HANYA pernah dibaca dari
 * `desc.value` (hasil `getOwnPropertyDescriptor`, sudah final -- trap
 * `get` proxy tidak pernah dipanggil) dan disalin ke objek/array polos
 * baru yang kita bangun sendiri, lalu dibekukan; objek asli pemanggil
 * tidak pernah disimpan atau dibaca lagi setelah validasi.
 */
function buildSafeIntentTemplate(value, depth = 0) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa Symbol");
    if (t !== "object") return value;
    if (depth > MAX_INTENT_SCAN_DEPTH) {
        fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }

    if (Array.isArray(value)) {
        // Bug review independen (audit putaran-4, W7R4-P2-4): walker ini
        // tidak punya batas panjang array seperti saudaranya di
        // prospective (MAX_PAYLOAD_ARRAY_LENGTH) dan envelope
        // (GLOBAL_MAX_ARRAY_LENGTH) -- array-like Proxy dengan `length`
        // besar bisa memaksa loop tak terbatas.
        if (value.length > MAX_INTENT_ARRAY_LENGTH) {
            fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "panjang array pada intentTemplate melebihi batas");
        }
        const arrProto = Object.getPrototypeOf(value);
        if (arrProto !== Array.prototype && arrProto !== null) {
            fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa array dengan prototype non-standar");
        }
        const out = [];
        for (let i = 0; i < value.length; i++) {
            const desc = Object.getOwnPropertyDescriptor(value, i);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa properti accessor: '${i}'`);
            }
            const built = buildSafeIntentTemplate(desc.value, depth + 1);
            out[i] = built === undefined ? null : built;
        }
        for (const key of Reflect.ownKeys(value)) {
            if (key === "length" || INTENT_ARRAY_INDEX_PATTERN.test(String(key))) continue;
            if (typeof key === "symbol") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa kunci Symbol");
            if (DANGEROUS_INTENT_KEYS.includes(key)) fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `kunci berbahaya ditolak: '${key}'`);
            if (FORBIDDEN_INTENT_KEYS.includes(key)) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa '${key}' (di kedalaman manapun)`);
            }
            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa properti accessor: '${String(key)}'`);
            }
            buildSafeIntentTemplate(desc.value, depth + 1); // divalidasi, tidak disalin (properti non-indeks array)
        }
        return out;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh berupa instance kelas (kontrak data murni)");
    }
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa kunci Symbol");
        if (DANGEROUS_INTENT_KEYS.includes(key)) fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `kunci berbahaya ditolak: '${key}'`);
        if (FORBIDDEN_INTENT_KEYS.includes(key)) {
            fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa '${key}' (di kedalaman manapun)`);
        }
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc || desc.get || desc.set) {
            fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa properti accessor: '${String(key)}'`);
        }
        const built = buildSafeIntentTemplate(desc.value, depth + 1);
        if (built !== undefined) out[key] = built;
    }
    return out;
}

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function validateConditionSpec(spec, label) {
    if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, `${label} wajib objek`);
    if (typeof spec.kind !== "string" || typeof spec.subject !== "object" ||
        typeof spec.attribute !== "string") {
        fail(REASONS.UNVERIFIABLE_SUCCESS_CONDITION,
            `${label} tidak dapat dievaluasi (kind/subject/attribute wajib ada)`);
    }
    // Bug review independen (audit putaran-8, W7R8-P2-1): `Object.freeze({...spec})`
    // dangkal -- `spec.subject` tetap referensi milik pemanggil, jadi
    // mutasi pasca-proposeGoal/createTask menulis ulang subject kondisi
    // yang sudah tersimpan.
    return Object.freeze({ ...spec, subject: Object.freeze({ ...spec.subject }) });
}

/** G-1/G-2: SELF_PROPOSED tidak pernah menyetujui dirinya; AGENT_SUGGESTION tidak pernah mengatur ownerApproval. */
function makeGoal({
    goalId, title, kind, origin, priorityClass = "NORMAL",
    successCondition, abandonCondition = null, deadline = null,
    parentGoalId = null, depth = 0, budgetRef = null, missionRef = null, nowIso
}) {
    if (typeof goalId !== "string" || !goalId) fail(REASONS.INVALID_RECORD, "goalId wajib string");
    if (!GOAL_KINDS.has(kind)) fail(REASONS.INVALID_RECORD, `kind '${kind}' tidak dikenal`);
    if (!origin || !ORIGIN_KINDS.has(origin.kind)) fail(REASONS.INVALID_RECORD, "origin.kind tidak dikenal");
    if (!PRIORITY_CLASSES.has(priorityClass)) fail(REASONS.INVALID_RECORD, "priorityClass tidak dikenal");

    const condition = validateConditionSpec(successCondition, "successCondition");

    let ownerApproval;
    if (kind === "SELF_PROPOSED" || origin.kind === "AGENT_SUGGESTION") {
        // G-1/G-2: self-proposal atau saran agen TIDAK PERNAH menyetel approval sendiri.
        ownerApproval = Object.freeze({ state: "REQUIRED", approvalRef: null, grantedAt: null, scope: null });
    } else {
        ownerApproval = Object.freeze({ state: "NOT_REQUIRED", approvalRef: null, grantedAt: null, scope: null });
    }

    return Object.freeze({
        goalId, title: String(title).slice(0, 500), kind,
        origin: Object.freeze({ ...origin }),
        ownerApproval,
        state: "PROPOSED",
        priorityClass,
        successCondition: condition,
        abandonCondition: abandonCondition ? validateConditionSpec(abandonCondition, "abandonCondition") : null,
        deadline, parentGoalId, depth,
        budgetRef, missionRef,
        createdAt: nowIso, lastTransitionAt: nowIso,
        transitions: Object.freeze([])
    });
}

function makeCommitment({ commitmentId, goalRef, toWhom, promise, dueCondition, missedPolicy = "NOTIFY" }) {
    if (typeof commitmentId !== "string" || !commitmentId) fail(REASONS.INVALID_RECORD, "commitmentId wajib string");
    if (typeof goalRef !== "string" || !goalRef) fail(REASONS.INVALID_RECORD, "goalRef wajib string");
    return Object.freeze({
        commitmentId, goalRef,
        toWhom: Object.freeze({ ...toWhom }),
        promise: String(promise).slice(0, 500),
        dueCondition: validateConditionSpec(dueCondition, "dueCondition"),
        state: "OPEN", evidenceRef: null,
        missedPolicy: ["NOTIFY", "ESCALATE", "SILENT_RECORD"].includes(missedPolicy) ? missedPolicy : "NOTIFY"
    });
}

function makePlan({ planId, goalRef, version = 1, steps, assumptions = [], createdBy = "SELF" }) {
    if (typeof planId !== "string" || !planId) fail(REASONS.INVALID_RECORD, "planId wajib string");
    if (!Array.isArray(steps)) fail(REASONS.INVALID_RECORD, "steps wajib array taskId");
    return Object.freeze({
        planId, goalRef, version, steps: Object.freeze([...steps]),
        createdBy, assumptions: Object.freeze(assumptions.map(a => Object.freeze({ ...a }))),
        invalidatedBy: Object.freeze([]), state: "DRAFT"
    });
}

function makeTask({ taskId, planRef, order, capabilityId = null, preconditions = [], postconditions = [], intentTemplate, maxAttempts = 5 }) {
    if (typeof taskId !== "string" || !taskId) fail(REASONS.INVALID_RECORD, "taskId wajib string");
    const safeIntentTemplate = buildSafeIntentTemplate(intentTemplate ?? {});
    return Object.freeze({
        taskId, planRef, order, capabilityId,
        preconditions: Object.freeze(preconditions.map(c => validateConditionSpec(c, "precondition"))),
        postconditions: Object.freeze(postconditions.map(c => validateConditionSpec(c, "postcondition"))),
        intentTemplate: deepFreeze(safeIntentTemplate),
        state: "PENDING", attempts: 0, maxAttempts, lastOutcomeRef: null
    });
}

module.exports = {
    GOAL_KINDS, ORIGIN_KINDS, PRIORITY_CLASSES,
    validateConditionSpec, makeGoal, makeCommitment, makePlan, makeTask
};
