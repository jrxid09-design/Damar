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
const { makeSignal, makeTarget, WORK_KINDS } = require("./records");
const { assignPriorityClass } = require("./policy");
const { computeEffectivePriority, initCredits, pickOne, mapToGovernorPriority } = require("./scheduling");

// Bug review independen (audit putaran-9, AUD9-P2-2): JSON.stringify(subjectRef)
// mengeksekusi toJSON milik pemanggil di dalam proses kognisi -- toJSON yang
// stateful juga membuat dedup/rate-accounting non-deterministik. subjectRef
// hanya pernah berbentuk {entityId} atau {relationId} (sama seperti
// worldmodel/query.js's subjectKeyOf); kunci dibangun dari field itu saja.
// Bug review independen (audit putaran-10, AUD10-P2-3): versi putaran-9 tidak
// memvalidasi bentuk subjectRef -- dua subjectRef yang BEDA tapi sama-sama
// tidak punya entityId/relationId string keduanya jatuh ke `relation:undefined`,
// menggabungkan target/review yang sebenarnya tidak terkait. Ditolak tertutup.
function targetKey(subjectRef, workKind) {
    // Bug review independen (audit putaran-35, AUD35-ADV-4; putaran-36,
    // AUD36-ADV-2, regresi diperkenalkan kandidat): `subjectRef.entityId`/
    // `.relationId` dulu dibaca DUA KALI (sekali di `typeof`, lagi di
    // template literal) -- putaran-35 menyatukannya jadi satu baca TANPA
    // SYARAT untuk keduanya, tapi itu menghilangkan short-circuit asli:
    // `relationId` sekarang dieksekusi bahkan ketika `entityId` sudah
    // valid, mengeksekusi accessor pemanggil yang sebelumnya tidak pernah
    // dipanggil. `relationId` hanya dibaca kalau `entityId` terbukti
    // bukan string.
    const entityId = subjectRef?.entityId;
    if (typeof entityId === "string") return `entity:${entityId}::${workKind}`;
    const relationId = subjectRef?.relationId;
    if (typeof relationId === "string") return `relation:${relationId}::${workKind}`;
    fail(REASONS.INVALID_RECORD, "subjectRef wajib { entityId } atau { relationId } string");
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
    // AUD27-P2-7: signalId -> targetId, bounded FIFO -- lihat komentar di
    // ingestSignal (replay dedup, sama seperti observationId/relationId/dll
    // di lane lain).
    const signalIdToTargetId = new Map();

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

    // Bug review independen (audit putaran-24, AUD24-P2-3): template literal
    // `${s.evidenceRef}` memaksa coercion (memanggil toString/valueOf milik
    // pemanggil di dalam proses kognisi, tereksekusi setiap pick()/recompute)
    // DAN meruntuhkan semua evidenceRef berbentuk objek ke string sama
    // ("[object Object]"), menggabungkan pasangan sumber+bukti yang
    // sebenarnya berbeda (undercount korroborasi).
    // Bug review independen (audit putaran-25, AUD25-P2-2): perbaikan
    // putaran-24 (baca field primitif via descriptor) hanya membedakan
    // SATU level -- nilai bersarang tetap runtuh ke tag "object" yang sama.
    // Bug review independen (audit putaran-26, AUD26-P1-1, BLOCKING;
    // AUD26-P2-2): putaran-25 mengganti dengan rekursi konten
    // depth-capped -- tapi bahkan dengan memo per node, MENGGABUNGKAN
    // konten hasil rekursi anak yang dibagikan (`${k}=${childResult}`) ke
    // string induk tetap membuat PANJANG STRING meledak O(fanout^level)
    // untuk DAG referensi-bersama (bukan siklus): diukur RangeError
    // "Invalid string length" pada fanout=60/level=5, dan 42ms sampai
    // beberapa detik pada fanout lebih kecil -- memoisasi kerja TIDAK
    // menutup ledakan panjang string yang dibangunnya. Identitas evidenceRef
    // objek sekarang HANYA identitas REFERENSI (WeakMap, id berurutan) --
    // tidak pernah membaca/merekursi isinya sama sekali, jadi tidak pernah
    // memanggil toString/valueOf/getter pemanggil DAN biayanya O(1) murni
    // per objek terlepas dari struktur/kedalamannya (tidak ada test di
    // lane ini yang mensyaratkan penggabungan dua objek BERBEDA REFERENSI
    // meski isinya sama -- hanya mensyaratkan objek BERBEDA tetap
    // dibedakan, yang tetap terpenuhi).
    // WeakMap menerima objek MAUPUN fungsi sebagai kunci -- keduanya
    // dipakai untuk identitas berbasis referensi murni (O(1), tidak pernah
    // membaca isinya).
    const objectEvidenceRefIds = new WeakMap();
    let nextObjectEvidenceRefId = 1;
    // Bug review independen (audit putaran-39, AUD39-P2-1, regresi
    // diperkenalkan kandidat putaran-38): perbaikan AUD38-ADV-2 mengganti
    // `return t;` dengan `return `${t}:${String(evidenceRef)}`;` -- niatnya
    // memberi identitas berbeda untuk nilai primitif berbeda, TAPI
    // `String(fn)` pada sebuah FUNCTION memanggil toString milik pemanggil
    // (mengeksekusi kode pemanggil di dalam ingestSignal, melanggar
    // kontrak "toString tidak pernah dipanggil" yang sudah diuji AT-repair-
    // 18/29), dan `String(symbol)`/`String(fn)` TIDAK injektif -- dua
    // Symbol/function BERBEDA dengan deskripsi/sumber yang SAMA runtuh ke
    // satu identitas, tetap undercounting korroborasi. Function (objek
    // secara JS, `typeof === "function"`) sekarang memakai jalur WeakMap
    // referensi murni yang SAMA seperti objek biasa (tidak pernah dibaca/
    // di-toString). Symbol adalah primitif (tidak bisa jadi kunci WeakMap)
    // -- Map biasa terpisah dipakai, dibatasi eksplisit dengan eviksi FIFO
    // (Symbol tidak pernah di-garbage-collect otomatis dari Map biasa).
    const symbolEvidenceRefIds = new Map();
    let nextSymbolEvidenceRefId = 1;
    function evidenceRefIdentity(evidenceRef) {
        if (evidenceRef === null || evidenceRef === undefined) return "";
        const t = typeof evidenceRef;
        if (t === "string" || t === "number" || t === "boolean") return `${t}:${evidenceRef}`;
        if (t === "symbol") {
            if (!symbolEvidenceRefIds.has(evidenceRef)) {
                if (symbolEvidenceRefIds.size >= bounds.MAX_SEEN_SYMBOL_EVIDENCE_REFS) {
                    symbolEvidenceRefIds.delete(symbolEvidenceRefIds.keys().next().value);
                }
                symbolEvidenceRefIds.set(evidenceRef, nextSymbolEvidenceRefId++);
            }
            return `symbol:${symbolEvidenceRefIds.get(evidenceRef)}`;
        }
        // BigInt sudah ditolak tertutup di makeSignal sebelum sempat
        // tersimpan, tapi identitas ini dihitung SEBELUM validasi itu --
        // `String(bigint)` aman (BigInt.prototype.toString bukan sesuatu
        // yang bisa ditimpa per-instance oleh pemanggil).
        if (t !== "object" && t !== "function") return `${t}:${String(evidenceRef)}`;
        if (!objectEvidenceRefIds.has(evidenceRef)) objectEvidenceRefIds.set(evidenceRef, nextObjectEvidenceRefId++);
        return `object:${objectEvidenceRefIds.get(evidenceRef)}`;
    }

    function recomputeAll() {
        for (const [id, t] of targets) {
            if (t.state !== "QUEUED") continue;
            const support = supportingSignals.get(id) ?? [];
            const distinctPairs = new Set(support.map(s => `${s.sourceId}::${s.evidenceIdentity}`)).size;
            const newestSignalAge = support.length
                ? now() - Math.max(...support.map(s => s.createdAtMs)) : 0;
            const effectivePriority = computeEffectivePriority(t, {
                waitingMs: now() - t.admittedAt, signalAgeMs: newestSignalAge,
                distinctSourceEvidencePairs: distinctPairs
            });
            targets.set(id, Object.freeze({ ...t, effectivePriority, lastComputedAtMs: now() }));
        }
    }

    // Bug review independen (audit putaran-18, AUD18-P2-3): pola yang sama
    // yang sudah diperbaiki untuk entitas worldmodel (AUD17-P2-4) dan relasi
    // worldmodel (AUD18-P2-1) -- tapi hanya untuk blok PENGHAPUSAN TOTAL di
    // bawah (MAX_TOTAL_TARGETS). Demosi QUEUED->DEFERRED di blok INI tidak
    // menghapus target dari `targets` (getTarget() masih menemukannya),
    // jadi target baru boleh tetap jadi kandidat demosi wajar berdasarkan
    // prioritas -- mengecualikannya di sini salah menutupi overflow yang sah
    // (AT-A8) tanpa menutup celah aslinya.
    function evictLowestIfOverflow(protectedTargetId = null) {
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
            const candidate = [...targets.values()].filter(t => t.state !== "RUNNING" && t.targetId !== protectedTargetId)
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
        // Bug review independen (audit putaran-21, AUD21-ADV-1): spec null/
        // non-objek meledakkan `spec.signalId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-27, AUD27-P2-3): identitas
        // evidenceRef WAJIB dihitung dari referensi ASLI pemanggil (spec.evidenceRef)
        // di sini -- makeSignal (di bawah) menyimpan SALINAN beku
        // (`deepFreeze({...evidenceRef})`), objek BARU setiap panggilan, jadi
        // menghitung identitas dari signal.evidenceRef (versi tersimpan)
        // membuat replay evidenceRef objek yang SAMA dari sumber yang SAMA
        // selalu dianggap berbeda (tiap salinan dapat id WeakMap sendiri),
        // meniadakan dedup korroborasi AT-5 -- pembalikan diam-diam dari
        // perbaikan putaran-24/25 yang justru menutup kelas bug ini.
        // Bug review independen (audit putaran-33, AUD33-ADV-1): `spec.evidenceRef`
        // dulu dibaca DUA KALI -- sekali di sini untuk identitas, sekali lagi
        // lewat `{...spec}` di makeSignal di bawah -- getter stateful bisa
        // memasangkan identitas dari referensi PERTAMA dengan evidenceRef
        // TERSIMPAN yang berasal dari referensi KEDUA, melepaskan dedup
        // korroborasi dari objek yang benar-benar tersimpan. Dibaca SEKALI
        // ke lokal dan diteruskan eksplisit ke makeSignal.
        // Bug review independen (audit putaran-34, AUD34-ADV-1): `signalId`
        // masih dilewatkan lewat `spec.signalId ?? crypto.randomUUID()`
        // DI DALAM object literal yang juga men-spread `...specRestForSignal`
        // -- sisa kunci itu (yang masih punya `signalId`) DAN akses langsung
        // `spec.signalId` sama-sama membaca getter yang sama, dua kali.
        // Dikeluarkan sekalian lewat destructuring yang sama dengan evidenceRef.
        const { evidenceRef: rawEvidenceRef, signalId: rawSignalId, ...specRestForSignal } = spec;
        const evidenceIdentity = evidenceRefIdentity(rawEvidenceRef);
        // Bug review independen (audit putaran-11, AUD11-P2-9): enforceSourceRate
        // dulu berjalan SEBELUM makeSignal memvalidasi spec -- signal yang
        // ditolak (sourceId/sourceKind cacat) tetap membuat/menaikkan kunci
        // rate-limit untuk sourceId sampah, sama seperti bug W7R4-P2-3 yang
        // sudah diperbaiki di goals' proposeGoal tapi tidak dimigrasikan ke
        // sini. Validasi/bangun record dulu, baru tegakkan rate.
        const signal = makeSignal({ ...specRestForSignal, evidenceRef: rawEvidenceRef, signalId: rawSignalId ?? crypto.randomUUID(), createdAtMs: now() });
        // Bug review independen (audit putaran-27, AUD27-P2-7): signalId
        // yang di-replay (pengiriman ulang lintas-node) dulu dihitung
        // sebagai signal BARU setiap kali -- support bertambah lagi untuk
        // bukti yang sama (memalsukan korroborasi) DAN sourceId-nya menagih
        // kuota rate lagi (self-DoS lewat replay), satu-satunya id
        // eksternal di lane ini yang tidak pernah dijaga dedup, tidak
        // seperti observationId/relationId/dll di lane lain.
        const alreadySeenTargetId = signalIdToTargetId.get(signal.signalId);
        if (alreadySeenTargetId !== undefined) {
            return { signal, targetId: alreadySeenTargetId };
        }
        // Bug review independen (audit putaran-14, AUD14-P2-2): workKind
        // hanya divalidasi DI DALAM makeTarget, yang berjalan SETELAH
        // enforceSourceRate/targetKey -- signal dengan workKind cacat tetap
        // menagih kuota rate sumbernya sebelum ditolak. Divalidasi di sini
        // dulu, sebelum efek samping apa pun.
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${workKind}` mentah meledakkan TypeError untuk Symbol.
        if (!WORK_KINDS.has(workKind)) fail(REASONS.INVALID_RECORD, `workKind '${typeof workKind === "string" ? workKind : typeof workKind}' tidak dikenal`);
        // Bug review independen (audit putaran-12, AUD12-P2-4): perbaikan
        // putaran-11 memindahkan enforceSourceRate ke SETELAH makeSignal,
        // tapi targetKey (validator KEDUA di jalur ini, menolak subjectRef
        // yang bentuknya salah) masih berjalan SETELAHNYA -- signal dengan
        // subjectRef cacat tetap menagih/membuat kuota rate sebelum ditolak.
        // targetKey (murni, tanpa efek samping) sekarang dihitung dulu.
        const key = targetKey(signal.subjectRef, workKind);
        enforceSourceRate(signal.sourceId);
        const priorityClass = assignPriorityClass(signal);

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
        support.push({ sourceId: signal.sourceId, evidenceIdentity, createdAtMs: signal.createdAtMs });
        if (support.length > bounds.MAX_SUPPORTING_SIGNALS_PER_TARGET) support.shift();
        signalIdToTargetId.set(signal.signalId, targetId);
        if (signalIdToTargetId.size > bounds.MAX_SEEN_SIGNAL_IDS) {
            signalIdToTargetId.delete(signalIdToTargetId.keys().next().value);
        }
        evictLowestIfOverflow(targetId);
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

        // Bug review independen (audit putaran-19, AUD19-P2-1): tanpa
        // governorPort, `maxRunning` dulu Infinity -- jumlah target RUNNING
        // (yang tidak pernah dipurge oleh evictLowestIfOverflow) bisa tumbuh
        // tak terbatas, membuat MAX_TOTAL_TARGETS tidak bisa ditegakkan sama
        // sekali begitu semua target lain jadi RUNNING. bounds.MAX_RUNNING_TARGETS
        // adalah lantai jatuh-diri saat tidak ada governor eksternal.
        // Bug review independen (audit putaran-34, AUD34-ADV-5): hasil
        // governorPort.capacity() dulu dipakai mentah -- port yang
        // mengembalikan NaN/Infinity/non-angka membuat
        // `runningCount >= maxRunning` selalu false, menggagalkan lantai
        // MAX_RUNNING_TARGETS sepenuhnya (port tepercaya tapi tidak wajib
        // benar; advisory, bukan P2, karena tidak ada persist/authority di sini).
        const rawCapacity = governorPort?.capacity?.();
        const maxRunning = (typeof rawCapacity === "number" && Number.isFinite(rawCapacity))
            ? rawCapacity : bounds.MAX_RUNNING_TARGETS;
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
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${targetId}` mentah meledakkan TypeError untuk Symbol; `targets.get()`
        // sendiri (pencarian Map) tidak pernah mengeksekusi apa pun.
        if (!t) fail(REASONS.UNKNOWN_TARGET, `target '${typeof targetId === "string" ? targetId : typeof targetId}' tidak ditemukan`);
        if (t.preemptions >= bounds.MAX_PREEMPTIONS) {
            fail(REASONS.PREEMPTION_LIMIT_EXCEEDED, `target sudah mencapai batas preemption (${bounds.MAX_PREEMPTIONS})`);
        }
        const next = Object.freeze({ ...t, state: "QUEUED", preemptions: t.preemptions + 1 });
        targets.set(targetId, next);
        return next;
    }

    function complete(targetId) {
        const t = targets.get(targetId);
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${targetId}` mentah meledakkan TypeError untuk Symbol; `targets.get()`
        // sendiri (pencarian Map) tidak pernah mengeksekusi apa pun.
        if (!t) fail(REASONS.UNKNOWN_TARGET, `target '${typeof targetId === "string" ? targetId : typeof targetId}' tidak ditemukan`);
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

module.exports = { createAttentionEconomy, laws, BOUNDS, targetKey };
