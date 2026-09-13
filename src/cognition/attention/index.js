"use strict";

/**
 * W7-L5 ATTENTION, SALIENCE AND COGNITIVE ECONOMY.
 *
 * ACC subdomain `src/cognition/attention/**` (`W7_ATTENTION_ECONOMY_SPEC.md`).
 *
 * HIGH SALIENCE != HIGH PRIVILEGE. Class assignment lives ONLY in policy.js;
 * no ingest path lets a caller set priorityClass directly (AT-3). The
 * attention-to-governor mapping (scheduling.mapToGovernorPriority) is the
 * only bridge to the Resource Governor, and it is explicit/bounded/audited,
 * never a raw numeric copy.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION, PRIORITY_CLASSES } = require("./bounds");
const { laws } = require("./laws");
const { makeSignal, makeTarget } = require("./records");
const { assignPriorityClass } = require("./policy");
const { computeEffectivePriority, initCredits, pickOne, mapToGovernorPriority } = require("./scheduling");

// Bug review independen (audit putaran-9, AUD9-P2-2): JSON.stringify(subjectRef)
// mengeksekusi toJSON milik pemanggil di dalam proses kognisi -- toJSON yang
// stateful juga membuat dedup/rate-accounting non-deterministik. subjectRef
// hanya pernah berbentuk {entityId} atau {relationId} (sama seperti
// worldmodel/query.js's subjectKeyOf); kunci dibangun dari field itu saja.
function targetKey(subjectRef, workKind) {
    const subjectKey = subjectRef && subjectRef.entityId
        ? `entity:${subjectRef.entityId}`
        : `relation:${subjectRef && subjectRef.relationId}`;
    return `${subjectKey}::${workKind}`;
}

async function createAttentionEconomy({ clock = { nowMs: () => Date.now() }, bounds = BOUNDS, governorPort = null } = {}) {

    const signalsBySource = new Map();     // sourceId -> timestamps[] (untuk laju)
    const targets = new Map();             // targetId -> AttentionTarget
    const targetIdByKey = new Map();       // subjectRef+workKind -> targetId
    const supportingSignals = new Map();   // targetId -> [{sourceId, evidenceRef, createdAtMs}]
    let credits = initCredits();
    const overflowJournal = [];
    let overflowTotalCount = 0;
    const governorMappingAudit = [];
    const noisySources = new Set();

    function now() { return clock.nowMs(); }

    function enforceSourceRate(sourceId) {
        const windowMs = 60_000;
        const list = (signalsBySource.get(sourceId) ?? []).filter(t => now() - t < windowMs);
        if (list.length >= bounds.MAX_SIGNALS_PER_SOURCE_PER_MINUTE) {
            noisySources.add(sourceId);
            fail(REASONS.SIGNAL_RATE_EXCEEDED, `sumber '${sourceId}' melebihi laju sinyal, ditandai berisik`);
        }
        list.push(now());
        signalsBySource.set(sourceId, list);

        // Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
        // putaran-2, AUD2-P2-2): sourceId berbeda-beda tanpa batas membuat
        // signalsBySource/noisySources tumbuh selamanya -- MAX_DISTINCT_SOURCES_COUNTED
        // hanya membatasi BONUS korobrasi, bukan peta ini. Evict sumber
        // paling lama tidak aktif saat melebihi batas.
        if (signalsBySource.size > bounds.MAX_TRACKED_SOURCES) {
            let victimId = null, victimLast = Infinity;
            for (const [id, times] of signalsBySource) {
                const last = times.length ? times[times.length - 1] : -Infinity;
                if (last < victimLast) { victimLast = last; victimId = id; }
            }
            if (victimId !== null) {
                signalsBySource.delete(victimId);
                noisySources.delete(victimId);
            }
        }
    }

    function recomputeAll() {
        for (const [id, t] of targets) {
            if (t.state !== "QUEUED") continue;
            const support = supportingSignals.get(id) ?? [];
            const distinctPairs = new Set(support.map(s => `${s.sourceId}::${s.evidenceRef ?? ""}`)).size;
            const newestSignalAge = support.length
                ? now() - Math.max(...support.map(s => s.createdAtMs)) : 0;
            const effectivePriority = computeEffectivePriority(t, {
                waitingMs: now() - t.admittedAt, signalAgeMs: newestSignalAge,
                distinctSourceEvidencePairs: distinctPairs
            });
            targets.set(id, Object.freeze({ ...t, effectivePriority, lastComputedAtMs: now() }));
        }
    }

    function evictLowestIfOverflow() {
        const queued = [...targets.values()].filter(t => t.state === "QUEUED");
        if (queued.length > bounds.MAX_QUEUED_TARGETS) {
            recomputeAll();
            const victim = [...targets.values()].filter(t => t.state === "QUEUED")
                .sort((a, b) => a.effectivePriority - b.effectivePriority)[0];
            if (victim) {
                targets.set(victim.targetId, Object.freeze({ ...victim, state: "DEFERRED" }));
                overflowTotalCount += 1;
                overflowJournal.push(Object.freeze({ targetId: victim.targetId, subjectRef: victim.subjectRef, deferredAt: now(), reason: "QUEUE_FULL" }));
                if (overflowJournal.length > bounds.MAX_OVERFLOW_JOURNAL) overflowJournal.shift();
            }
        }

        // Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
        // independen putaran-1, AUD-P1-3): demosi ke DEFERRED tidak pernah
        // MENGHAPUS entri dari targets/targetIdByKey/supportingSignals --
        // pemanggil dengan banyak subjectRef berbeda bisa menumbuhkan
        // ketiganya tanpa batas walau MAX_QUEUED_TARGETS terjaga (DEFERRED
        // dan DONE tidak pernah dihitung terhadapnya). RUNNING tidak pernah
        // dipurge -- itu pekerjaan aktif.
        if (targets.size > bounds.MAX_TOTAL_TARGETS) {
            const purgeRank = { DONE: 0, DEFERRED: 1, QUEUED: 2 };
            const candidate = [...targets.values()].filter(t => t.state !== "RUNNING")
                .sort((a, b) => {
                    const rankDiff = purgeRank[a.state] - purgeRank[b.state];
                    if (rankDiff !== 0) return rankDiff;
                    return (a.lastComputedAtMs ?? a.admittedAt) - (b.lastComputedAtMs ?? b.admittedAt);
                })[0];
            if (candidate) {
                targets.delete(candidate.targetId);
                targetIdByKey.delete(targetKey(candidate.subjectRef, candidate.workKind));
                supportingSignals.delete(candidate.targetId);
            }
        }
    }

    /** AT-1/AT-2/AT-3: kelas ditentukan HANYA di sini lewat policy.js. */
    function ingestSignal(spec, workKind) {
        enforceSourceRate(spec.sourceId);
        const signal = makeSignal({ ...spec, signalId: spec.signalId ?? crypto.randomUUID(), createdAtMs: now() });
        const priorityClass = assignPriorityClass(signal);

        const key = targetKey(signal.subjectRef, workKind);
        let targetId = targetIdByKey.get(key);

        if (!targetId) {
            const target = makeTarget({
                targetId: crypto.randomUUID(), subjectRef: signal.subjectRef, workKind, priorityClass, admittedAtMs: now()
            });
            targets.set(target.targetId, target);
            targetIdByKey.set(key, target.targetId);
            targetId = target.targetId;
            supportingSignals.set(targetId, []);
        } else {
            // Kelas TIDAK PERNAH diturunkan; hanya boleh naik ke kelas lebih tinggi (index lebih kecil).
            const existing = targets.get(targetId);
            if (PRIORITY_CLASSES.indexOf(priorityClass) < PRIORITY_CLASSES.indexOf(existing.priorityClass)) {
                targets.set(targetId, Object.freeze({ ...existing, priorityClass }));
            }
        }

        // Bug review independen (Codex putaran-9): pembatas laju hanya
        // membatasi per-sumber -- pemanggil dengan banyak sourceId berbeda
        // bisa menumpuk dukungan tak terbatas untuk SATU target, dan setiap
        // recompute memindai seluruh daftar itu. Dibatasi eksplisit di sini,
        // membuang yang tertua saat kelebihan (masih terhitung di aging via
        // corroborationBonus yang sudah dibatasi MAX_DISTINCT_SOURCES_COUNTED).
        const support = supportingSignals.get(targetId);
        support.push({ sourceId: signal.sourceId, evidenceRef: signal.evidenceRef, createdAtMs: signal.createdAtMs });
        if (support.length > bounds.MAX_SUPPORTING_SIGNALS_PER_TARGET) support.shift();
        evictLowestIfOverflow();
        recomputeAll();
        return { signal, targetId };
    }

    function queuesByClass() {
        const map = Object.fromEntries(PRIORITY_CLASSES.map(c => [c, []]));
        for (const t of targets.values()) if (t.state === "QUEUED") map[t.priorityClass].push(t);
        return map;
    }

    /** Satu keputusan penjadwalan — deterministik untuk (state, nowMs) yang sama (freeze criterion #1). */
    function pick() {
        recomputeAll();
        const result = pickOne(queuesByClass(), credits, now());
        if (!result.target) {
            credits = result.credits;
            return null;
        }

        const maxRunning = governorPort?.capacity?.() ?? Infinity;
        const runningCount = [...targets.values()].filter(t => t.state === "RUNNING").length;
        if (runningCount >= maxRunning) return null;
        // Bug review independen (Codex putaran-5): kredit deficit round-robin
        // sebelumnya dikonsumsi SEBELUM cek kapasitas ini, jadi giliran kelas
        // pemenang tetap terpakai walau admisi diblokir dan target TIDAK
        // pernah benar-benar jalan -- kelaparan diam-diam. Sekarang kredit
        // hanya dikomit saat admisi benar-benar terjadi.
        credits = result.credits;

        const started = Object.freeze({ ...result.target, state: "RUNNING", startedAt: now() });
        targets.set(started.targetId, started);
        return started;
    }

    /**
     * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
     * putaran-3, AUD3-P2-1): GOVERNED mode diklaim "advisory-only"/read-only
     * (tidak pernah memengaruhi keputusan), tapi `buildGovernedProjection()`
     * memakai `pick()` untuk menurunkan `attentionFocus` -- itu MENGONSUMSI
     * kredit round-robin dan memindahkan target ke RUNNING sebagai efek
     * samping sekadar membaca proyeksi. `peekTopTarget()` melakukan
     * perhitungan yang sama TANPA mengomit kredit atau mengubah state target
     * mana pun -- murni baca.
     */
    function peekTopTarget() {
        recomputeAll();
        const result = pickOne(queuesByClass(), credits, now());
        if (!result.target) return null;
        return { targetId: result.target.targetId, workKind: result.target.workKind, priorityClass: result.target.priorityClass };
    }

    function preempt(targetId) {
        const t = targets.get(targetId);
        if (!t) fail(REASONS.UNKNOWN_TARGET, `target '${targetId}' tidak ditemukan`);
        if (t.preemptions >= bounds.MAX_PREEMPTIONS) {
            fail(REASONS.PREEMPTION_LIMIT_EXCEEDED, `target sudah mencapai batas preemption (${bounds.MAX_PREEMPTIONS})`);
        }
        const next = Object.freeze({ ...t, state: "QUEUED", preemptions: t.preemptions + 1 });
        targets.set(targetId, next);
        return next;
    }

    function complete(targetId) {
        const t = targets.get(targetId);
        if (!t) fail(REASONS.UNKNOWN_TARGET, `target '${targetId}' tidak ditemukan`);
        const next = Object.freeze({ ...t, state: "DONE", completedAt: now() });
        targets.set(targetId, next);
        return next;
    }

    function overloadState() {
        const load = [...targets.values()].filter(t => t.state === "QUEUED" || t.state === "RUNNING").length;
        const soft = bounds.MAX_QUEUED_TARGETS * 0.7;
        const hard = bounds.MAX_QUEUED_TARGETS * 0.9;
        if (load >= hard) return "HARD";
        if (load >= soft) return "SOFT";
        return "NORMAL";
    }

    function toGovernorPriority(priorityClass) {
        const mapped = mapToGovernorPriority(priorityClass, governorMappingAudit);
        // Bug review independen (audit putaran-2, AUD2-P2-2): jurnal ini
        // tumbuh selamanya, satu entri per panggilan, tanpa batas.
        if (governorMappingAudit.length > bounds.MAX_GOVERNOR_MAPPING_AUDIT) governorMappingAudit.shift();
        return mapped;
    }

    function getTarget(targetId) { return targets.get(targetId) ?? null; }
    function overflowCount() { return overflowTotalCount; }
    function overflowEntries() { return [...overflowJournal]; }
    function isNoisySource(sourceId) { return noisySources.has(sourceId); }
    function supportingSignalCount(targetId) { return (supportingSignals.get(targetId) ?? []).length; }
    function trackedSourceCount() { return signalsBySource.size; }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        ingestSignal, pick, peekTopTarget, preempt, complete, getTarget,
        overloadState, toGovernorPriority, governorMappingAudit: () => [...governorMappingAudit],
        overflowCount, overflowEntries, isNoisySource, supportingSignalCount, trackedSourceCount,
        laws, bounds
    });
}

module.exports = { createAttentionEconomy, laws, BOUNDS };
