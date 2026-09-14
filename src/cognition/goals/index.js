"use strict";

/**
 * W7-L3 GOALS, COMMITMENTS AND LONG-HORIZON PLANNING.
 *
 * ACC subdomain `src/cognition/goals/**`, replacing legacy
 * `src/autonomy/GoalEngine.js` (`W7_GOAL_COMMITMENT_SEMANTICS.md`).
 *
 * GOAL != AUTHORITY. This module never constructs an ActionIntent, never
 * calls Authority directly, never holds a grant — `ownerApproval.approvalRef`
 * is an opaque reference an injected `authorityPort` may check, nothing more.
 * `PLAN != EXECUTION`: `formIntent`/`awaitAuthority`/`execute` only move a
 * Task through its own state machine here; the actual intent object and its
 * evaluation belong to the existing Wave4 Action Intent / Authority owners.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { sanitizeBounds } = require("../core/bounds");
const { laws } = require("./laws");
const { makeGoal, makeCommitment, makePlan, makeTask, ORIGIN_KINDS } = require("./records");
const { transitionGoal, transitionCommitment, transitionTask } = require("./lifecycle");
const { loadSnapshot, saveSnapshot } = require("./store");

async function createGoalEngine({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS, authorityPort = null } = {}) {

    // Bug review independen (audit putaran-53, AUD53-P2-2): `bounds` yang
    // dioverride pemanggil dibaca mentah di puluhan titik di seluruh lane
    // ini -- Proxy yang di-revoke raw-throw pada baca PERTAMA. Dinormalisasi
    // SEKALI di sini (spread memicu trap `ownKeys` kalau ada); field yang
    // hilang jatuh ke `BOUNDS` asli, bukan `undefined`.
    // Bug review independen (audit putaran-57, Codex, W7R57-P2-1):
    // normalisasi lama hanya memvalidasi `bounds` ITU SENDIRI sebagai
    // objek, bukan tiap NILAI override -- Infinity/NaN/negatif pada satu
    // MAX_* melumpuhkan batas itu. sanitizeBounds memvalidasi per key.
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    const snapshot = await loadSnapshot(store);
    const goals = snapshot.goals;
    const commitments = snapshot.commitments;
    const plans = snapshot.plans;
    const tasks = snapshot.tasks;
    const childCounts = new Map();
    const creationTimestampsByOrigin = new Map();

    for (const g of goals.values()) {
        if (g.parentGoalId) childCounts.set(g.parentGoalId, (childCounts.get(g.parentGoalId) ?? 0) + 1);
    }

    // Restart rule (freeze criterion #3): no task resumes in EXECUTING.
    for (const [taskId, task] of tasks) {
        if (["EXECUTING", "AWAITING_AUTHORITY", "INTENT_FORMED"].includes(task.state)) {
            tasks.set(taskId, transitionTask(task, "resetAfterRestart"));
        }
    }

    // Bug review independen (audit putaran-53, AUD53-P2-2): `clock.nowMs()`
    // mentah -- Proxy yang di-revoke (atau `nowMs` yang melempar/bukan
    // fungsi/non-finite) raw-throw dari setiap pemanggil now()/nowIso().
    function now() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }
    function nowIso() { return new Date(now()).toISOString(); }

    function activeGoalCount() {
        let n = 0;
        for (const g of goals.values()) if (g.state === "ACTIVE") n++;
        return n;
    }

    function enforceCreationRate(originKind) {
        const windowMs = 60_000;
        const list = (creationTimestampsByOrigin.get(originKind) ?? []).filter(t => now() - t < windowMs);
        if (list.length >= bounds.MAX_GOAL_CREATION_RATE_PER_MINUTE) {
            fail(REASONS.CREATION_RATE_EXCEEDED, `laju pembuatan goal untuk origin '${originKind}' melebihi batas`);
        }
        list.push(now());
        creationTimestampsByOrigin.set(originKind, list);
    }

    function proposeGoal(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.origin` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-30, AUD30-P2-1; putaran-33,
        // AUD33-P2-2): `goalId`/`parentGoalId`/`origin` dulu masing-masing
        // dibaca lebih dari sekali (langsung lewat `spec.x` untuk validasi,
        // lalu LAGI lewat `{...spec}` saat konstruksi goal) -- getter
        // stateful bisa lolos validasi dengan nilai sah lalu menyimpan nilai
        // lain (parentGoalId yang berbeda dari yang dipakai menghitung
        // depth/childCounts, atau BigInt yang meledakkan persist()). Ketiga
        // field dikeluarkan bersama dalam SATU pernyataan destructuring
        // (pelajaran dari AUD32-P2-1: rest-destructure TERPISAH tetap
        // membaca ulang field yang sudah dibaca lewat penyalinan sisa
        // kunci) supaya `specRest` tidak pernah menyentuh ketiganya lagi.
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec`
        // sudah dijaga BUKAN null/non-objek di atas, tapi Proxy yang
        // di-revoke tetap typeof "object" -- destructuring ini tetap
        // [[Get]] mentah terhadapnya.
        let goalId, parentGoalId, rawOrigin, specRest;
        try {
            ({ goalId, parentGoalId, origin: rawOrigin, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        // Bug review independen (audit putaran-34, AUD34-P2-5): `origin`
        // ITU SENDIRI dikeluarkan sekali (di atas) dari `spec`, tapi
        // `origin.kind` (properti DALAM origin) masih dibaca berkali-kali
        // lintas fungsi -- guard ini, enforceCreationRate di bawah, DAN tiga
        // titik lagi di dalam makeGoal (guard/keputusan ownerApproval/spread
        // konstruksi) -- lima baca total dari getter yang sama. Getter
        // stateful bisa memvalidasi OWNER lalu mengizinkan AGENT_SUGGESTION
        // menyetel ownerApproval-nya SENDIRI (melanggar G-2), dan
        // creationTimestampsByOrigin bisa tumbuh satu kunci tak terbatas per
        // proposal (getter yang berubah tiap panggilan). `kind` (dan setiap
        // properti origin lain) dibaca SEKALI di sini lalu origin DIBANGUN
        // ULANG sebagai objek polos baru -- makeGoal menerima objek polos
        // itu, jadi baca-berkalinya di dalam sana tidak lagi menyentuh
        // accessor pemanggil sama sekali.
        // Bug review independen (audit putaran-45, W7R45-P2-1): round-44
        // hanya membungkus destructuring `spec` TINGKAT ATAS -- `rawOrigin`
        // (nilai bersarang DI DALAM spec) tetap didestrukturisasi mentah di
        // sini, satu level lebih dalam dari yang round-44 tutup.
        let originKind, originRest;
        try {
            ({ kind: originKind, ...originRest } = rawOrigin ?? {});
        } catch {
            fail(REASONS.INVALID_RECORD, "origin tidak dapat diverifikasi dengan aman, ditolak");
        }
        // Bug review independen (audit putaran-4, W7R4-P2-3): enforceCreationRate
        // dulu berjalan SEBELUM makeGoal memvalidasi origin.kind -- setiap
        // origin.kind sampah (string acak pemanggil) tetap membuat kunci baru
        // di creationTimestampsByOrigin sebelum proposal ditolak, dan kunci
        // itu tidak pernah dihapus. Divalidasi dulu di sini.
        if (!rawOrigin || !ORIGIN_KINDS.has(originKind)) {
            fail(REASONS.INVALID_RECORD, "origin.kind tidak dikenal");
        }
        const origin = Object.freeze({ ...originRest, kind: originKind });
        // Bug review independen (audit putaran-10, AUD10-P1-2): goalId
        // pemanggil dulu langsung di-set tanpa cek tabrakan -- pengiriman
        // ulang goalId yang sudah ada (replay lintas-node) menimpa goal
        // terminal (ABANDONED/SATISFIED/SUPERSEDED) kembali ke PROPOSED,
        // melewati G-8 (finalitas state terminal).
        if (goalId && goals.has(goalId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `goalId '${typeof goalId === "string" ? goalId : typeof goalId}' sudah ada`);
        }

        // Bug diketemukan review independen (Codex, putaran ke-4): depth
        // lama dipercaya langsung dari pemanggil (`spec.depth`), jadi
        // pemanggil bisa memberi depth:0 pada setiap anak dan melewati
        // MAX_GOAL_DEPTH sepenuhnya. depth sekarang SELALU diturunkan dari
        // induk yang benar-benar tersimpan; nilai `spec.depth` diabaikan.
        // Bug review independen (audit putaran-34, AUD34-P2-6): `if
        // (parentGoalId)` adalah cek KEBENARAN, bukan cek TIPE -- `0n`
        // (BigInt nol) bertipe salah tapi FALSY, jadi melewati blok ini
        // sepenuhnya (tidak pernah dicek lewat goals.get()) dan tersimpan
        // mentah di makeGoal, meledakkan JSON.stringify saat persist()
        // (durability DoS dari satu proposal biasa, bukan getter hostile).
        if (parentGoalId != null && typeof parentGoalId !== "string") {
            fail(REASONS.INVALID_RECORD, "parentGoalId, jika ada, wajib string");
        }
        let depth = 0;
        if (parentGoalId) {
            const parent = goals.get(parentGoalId);
            // Bug review independen (audit putaran-27, AUD27-P2-2): interpolasi
            // `${spec.parentGoalId}` mentah meledakkan TypeError untuk Symbol;
            // putaran-26 menutup 5 sibling id-message di file yang sama tapi
            // melewatkan yang ini.
            if (!parent) {
                fail(REASONS.INVALID_RECORD, `parentGoalId '${typeof parentGoalId === "string" ? parentGoalId : typeof parentGoalId}' tidak ditemukan`);
            }
            depth = parent.depth + 1;

            const siblingCount = childCounts.get(parentGoalId) ?? 0;
            if (siblingCount >= bounds.MAX_CHILDREN_PER_GOAL) {
                // Bug review independen (audit putaran-28, AUD28-ADV-3):
                // interpolasi `${spec.parentGoalId}` mentah -- latent (baris
                // 94/98 di atas sudah mewajibkan parentGoalId cocok kunci
                // goals.get() bertipe string), tapi tetap disamakan dengan
                // sibling di baris yang sama untuk konsistensi.
                fail(REASONS.CHILDREN_LIMIT_EXCEEDED, `induk '${typeof parentGoalId === "string" ? parentGoalId : typeof parentGoalId}' melebihi batas anak`);
            }
        }
        if (depth > bounds.MAX_GOAL_DEPTH) {
            fail(REASONS.GOAL_DEPTH_EXCEEDED, `depth melebihi batas (${bounds.MAX_GOAL_DEPTH})`);
        }

        // Bug review independen (audit putaran-14, AUD14-P1-2/AUD14-P2-3):
        // enforceCreationRate (efek samping, menaikkan kuota) dan kompaksi
        // retensi (efek samping, MENGHAPUS goal valid lain) dulu berjalan
        // SEBELUM makeGoal memvalidasi spec -- proposal yang ditolak (mis.
        // successCondition cacat) tetap menagih kuota origin.kind DAN
        // mengevict satu goal terminal yang VALID sebelum error dilempar,
        // kehilangan data permanen. makeGoal (satu-satunya tempat spec
        // benar-benar divalidasi) sekarang dipanggil DULU; efek samping
        // hanya terjadi setelah record yang akan disimpan terbukti valid.
        const goal = makeGoal({ ...specRest, origin, parentGoalId, depth, goalId: goalId ?? crypto.randomUUID(), nowIso: nowIso() });

        // Bug review independen (Codex putaran-6): cek retensi lama berjalan
        // SETELAH goal baru sudah dimasukkan, dan hanya mengevict kalau ada
        // goal terminal -- kalau semua goal yang tersimpan masih non-terminal,
        // proposal baru tetap diterima tanpa batas, melampaui
        // MAX_TOTAL_GOALS_RETAINED selamanya. Sekarang cek berjalan SEBELUM
        // insersi dan gagal tertutup kalau tidak ada goal terminal untuk dievict.
        // Bug review independen (audit putaran-16, AUD16-P1-1): perbaikan
        // putaran-15 memindahkan enforceCreationRate ke SETELAH blok retensi
        // ini, tapi blok ini sendiri MENGHAPUS goal terminal yang valid
        // SEBELUM enforceCreationRate sempat menolak panggilan karena
        // CREATION_RATE_EXCEEDED -- proposal yang ditolak rate limit tetap
        // mengevict goal valid secara permanen. Korban sekarang hanya
        // DIPILIH (tanpa dihapus) di sini; penghapusan+pembersihan
        // sesungguhnya dipindah ke SETELAH enforceCreationRate lolos.
        let evicted = null;
        if (goals.size >= bounds.MAX_TOTAL_GOALS_RETAINED) {
            const terminal = [...goals.values()]
                .filter(g => ["SATISFIED", "ABANDONED", "SUPERSEDED"].includes(g.state))
                .sort((a, b) => Date.parse(a.lastTransitionAt) - Date.parse(b.lastTransitionAt));
            if (terminal[0]) {
                evicted = terminal[0];
            } else {
                fail(REASONS.GOAL_RETENTION_LIMIT_EXCEEDED,
                    `retensi goal melebihi batas (${bounds.MAX_TOTAL_GOALS_RETAINED}) dan tidak ada goal terminal untuk dievict`);
            }
        }

        enforceCreationRate(originKind);

        if (evicted) {
            goals.delete(evicted.goalId);
            // Bug review independen (Codex putaran-8): saat retensi
            // mengevict anak terminal, entri induknya di childCounts
            // dibiarkan -- dengan MAX_CHILDREN_PER_GOAL kecil, proposal
            // anak baru di bawah induk itu ditolak "penuh" padahal anak
            // yang tersisa sudah tidak ada lagi.
            // Bug review independen (audit putaran-11, AUD11-P2-5): nilai
            // hanya diturunkan ke 0, kuncinya sendiri tidak pernah
            // dihapus -- pola yang sama yang sudah diperbaiki di
            // worldmodel's decrementSourceCount (W7R4-P2-3) dan
            // prospective's releaseArmedCapacity, tapi tidak pernah
            // dimigrasikan ke goals' childCounts. Growth tak terbatas
            // sebanding dengan churn goal jangka panjang.
            if (evicted.parentGoalId) {
                const nextCount = Math.max(0, (childCounts.get(evicted.parentGoalId) ?? 1) - 1);
                if (nextCount === 0) childCounts.delete(evicted.parentGoalId);
                else childCounts.set(evicted.parentGoalId, nextCount);
            }
            // Bug review independen (audit putaran-3, AUD3-P2-2): entri
            // MILIK goal yang dievict sendiri di childCounts (dipakai
            // sebagai induk untuk anak-anaknya) tidak pernah dihapus --
            // hanya nilainya yang berubah lewat proposeGoal berikutnya
            // (childCounts.get(evicted.goalId) ?? 0) + 1, jadi kunci UUID
            // basi menumpuk selamanya walau goal-nya sudah tidak ada.
            childCounts.delete(evicted.goalId);
            // Bug review independen (audit putaran-5, W7R5-P2-3): plan
            // milik goal yang dievict ditinggalkan -- MAX_PLAN_VERSIONS_RETAINED
            // hanya membatasi PER goal, jadi churn goal jangka panjang
            // menumpuk plan tak terbatas secara total.
            for (const p of [...plans.values()]) {
                if (p.goalRef === evicted.goalId) plans.delete(p.planId);
            }
        }

        goals.set(goal.goalId, goal);
        // Bug review independen (audit putaran-17, AUD17-P2-6): kalau
        // parentGoalId goal baru ini KEBETULAN adalah goal yang barusan
        // dievict retensi (evicted.goalId), childCounts.delete(evicted.goalId)
        // di atas langsung ditimpa ulang di sini, menghidupkan kembali kunci
        // childCounts basi milik goal yang sudah tidak ada -- pertumbuhan tak
        // terbatas yang sama yang sudah ditutup AUD3-P2-2/AUD11-P2-5, muncul
        // kembali lewat interaksi baru antara insersi dan pembersihan eviksi.
        if (goal.parentGoalId && goal.parentGoalId !== evicted?.goalId) {
            childCounts.set(goal.parentGoalId, (childCounts.get(goal.parentGoalId) ?? 0) + 1);
        }

        return goal;
    }

    /** GL-A2: `ownerApproval` hanya bisa dinaikkan lewat panggilan eksplisit ini, tidak lewat propose. */
    function grantApproval(goalId, meta) {
        // Bug review independen (audit putaran-23, AUD23-P2-1): meta null/
        // undefined meledakkan destructuring jadi TypeError mentah -- sibling
        // proposeGoal/createCommitment/createPlan/createTask di file yang
        // sama dijaga putaran-22 (F-4), fungsi ini terlewat.
        // Bug review independen (audit putaran-46, W7R46-P2-3): `meta ||
        // {}` cuma melindungi dari nilai falsy -- Proxy yang di-revoke
        // tetap truthy, jadi destructuring ini tetap [[Get]] mentah.
        let approvalRef, scope;
        try {
            ({ approvalRef, scope = null } = meta || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "meta tidak dapat diverifikasi dengan aman, ditolak");
        }
        const goal = goals.get(goalId);
        // Bug review independen (audit putaran-26, AUD26-P2-1): interpolasi
        // `${goalId}` mentah meledakkan TypeError untuk Symbol; sama seperti
        // 18 titik yang sudah ditutup putaran-25, ini terlewat dalam file
        // yang sama.
        if (!goal) fail(REASONS.UNKNOWN_GOAL, `goal '${typeof goalId === "string" ? goalId : typeof goalId}' tidak ditemukan`);
        // Bug review independen (audit putaran-13, AUD13-P2-3): approvalRef/
        // scope diteruskan mentah -- BigInt meledakkan JSON.stringify saat
        // persist(). approvalRef tetap opaque (bukan grant), hanya wajib
        // berupa referensi string yang bisa diserialisasi.
        if (typeof approvalRef !== "string" || !approvalRef) fail(REASONS.INVALID_RECORD, "approvalRef wajib string");
        if (scope !== null && (typeof scope !== "string" || !scope)) fail(REASONS.INVALID_RECORD, "scope, jika ada, wajib string");
        const next = Object.freeze({
            ...goal,
            ownerApproval: Object.freeze({ state: "GRANTED", approvalRef, grantedAt: nowIso(), scope })
        });
        goals.set(goalId, next);
        return next;
    }

    function transition(goalId, action, meta) {
        const goal = goals.get(goalId);
        // Bug review independen (audit putaran-26, AUD26-P2-1): sama seperti grantApproval.
        if (!goal) fail(REASONS.UNKNOWN_GOAL, `goal '${typeof goalId === "string" ? goalId : typeof goalId}' tidak ditemukan`);

        if (action === "activate" && activeGoalCount() >= bounds.MAX_ACTIVE_GOALS) {
            fail(REASONS.ACTIVE_GOAL_LIMIT_EXCEEDED, "jumlah goal aktif melebihi batas");
        }

        // Standing-approval expiry gate (spec §7): authorityPort dipanggil
        // HANYA untuk memeriksa validitas referensi — tidak pernah mengonstruksi grant.
        if (action === "activate" && goal.ownerApproval.state === "GRANTED" && authorityPort) {
            // Bug review independen (audit putaran-50, W7R50-ADV-1):
            // `authorityPort` adalah dependency internal tepercaya, tapi
            // panggilan/hasilnya tetap bisa berupa Proxy yang di-revoke
            // atau melempar -- `check.valid` di bawah tetap [[Get]]
            // mentah. Dibungkus try/catch; kegagalan APA PUN diperlakukan
            // SAMA seperti `check` falsy (fail closed ke APPROVAL_EXPIRED,
            // bukan raw-throw).
            let checkValid;
            try {
                const check = authorityPort.checkApproval(goal.ownerApproval.approvalRef);
                checkValid = !!check && !!check.valid;
            } catch {
                checkValid = false;
            }
            if (!checkValid) {
                fail(REASONS.APPROVAL_EXPIRED, "standing approval sudah kedaluwarsa, aktivasi ditolak");
            }
        }

        // Bug review independen (audit putaran-46, W7R46-P2-3): `{...meta,
        // nowIso}` men-spread `meta` mentah -- Proxy yang di-revoke
        // melempar TypeError mentah pada `ownKeys` yang dipakai spread.
        let safeMeta;
        try {
            safeMeta = { ...meta, nowIso: nowIso() };
        } catch {
            fail(REASONS.INVALID_RECORD, "meta tidak dapat diverifikasi dengan aman, ditolak");
        }
        const next = transitionGoal(goal, action, safeMeta);
        goals.set(goalId, next);
        return next;
    }

    function createCommitment(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.commitmentId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // commitmentId yang sudah ada (mis. sudah MET) menimpanya kembali ke
        // OPEN, melewati finalitas state terminal.
        // Bug review independen (audit putaran-31, AUD31-P2-1; putaran-34,
        // AUD34-ADV-1): perbaikan putaran-31 membaca `commitmentId` sekali
        // ke lokal tapi masih melewatkan `...spec` (bukan `...specRest`) ke
        // makeCommitment di bawah -- spread itu SENDIRI membaca getter
        // commitmentId lagi (override-nya cuma membuang hasil baca itu,
        // tidak mencegah baca itu terjadi). Dikeluarkan lewat destructuring
        // supaya spread di bawah benar-benar tidak menyentuhnya lagi.
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec`
        // sudah dijaga BUKAN null/non-objek di atas, tapi Proxy yang
        // di-revoke tetap typeof "object" -- destructuring ini tetap
        // [[Get]] mentah terhadapnya.
        let commitmentId, specRest;
        try {
            ({ commitmentId, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (commitmentId && commitments.has(commitmentId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `commitmentId '${typeof commitmentId === "string" ? commitmentId : typeof commitmentId}' sudah ada`);
        }
        let openCount = 0;
        for (const c of commitments.values()) if (c.state === "OPEN") openCount++;
        if (openCount >= bounds.MAX_OPEN_COMMITMENTS) {
            fail(REASONS.OPEN_COMMITMENT_LIMIT_EXCEEDED, "jumlah komitmen terbuka melebihi batas");
        }
        // Bug review independen (audit putaran-6, W7R6-P2-2): kompaksi dulu
        // berjalan SEBELUM makeCommitment memvalidasi spec -- spec yang
        // ditolak (mis. dueCondition cacat) tetap menghapus satu komitmen
        // terminal yang VALID sebelum error dilempar. Validasi/bangun record
        // dulu, baru kompaksi+simpan.
        const c = makeCommitment({ ...specRest, commitmentId: commitmentId ?? crypto.randomUUID() });
        // Bug review independen (audit putaran-5, W7R5-P2-3, dieskalasi dari
        // advisory putaran-4): MAX_OPEN_COMMITMENTS hanya membatasi yang OPEN
        // -- komitmen terminal (MET/MISSED/RELEASED/RENEGOTIATED) menumpuk
        // selamanya, tak terbatas. Kompaksi tertua saat retensi total penuh,
        // pola yang sama dengan goals sendiri (MAX_TOTAL_GOALS_RETAINED).
        // Selalu menemukan korban di sini karena OPEN dibatasi independen
        // jauh di bawah MAX_TOTAL_COMMITMENTS_RETAINED (lihat cek di atas).
        // Bug ditemukan lewat sapuan mandiri (setelah audit putaran-59):
        // sibling PERSIS dari kelas W7R59-P2-1..5 -- kalau kapasitas total
        // 0 (sanksi sah lewat sanitizeBounds) atau tidak ada commitment
        // terminal untuk dievict, `terminal` undefined, `if (terminal)`
        // menjaga dari raw-throw, TAPI `commitments.set(...)` sesudahnya
        // tetap tanpa syarat -- melampaui cap total secara diam-diam,
        // beda dari goals/tasks sendiri yang SUDAH punya cabang fail-closed
        // (baris di atas komentar aslinya salah asumsi "selalu ada
        // korban"). Sekarang gagal tertutup, sama seperti goals/tasks.
        if (commitments.size >= bounds.MAX_TOTAL_COMMITMENTS_RETAINED) {
            const terminal = [...commitments.values()].filter(x => x.state !== "OPEN")[0];
            if (terminal) {
                commitments.delete(terminal.commitmentId);
            } else {
                fail(REASONS.COMMITMENT_RETENTION_LIMIT_EXCEEDED,
                    `retensi commitment melebihi batas (${bounds.MAX_TOTAL_COMMITMENTS_RETAINED}) dan tidak ada commitment non-OPEN untuk dievict`);
            }
        }
        commitments.set(c.commitmentId, c);
        return c;
    }

    function transitionCommitmentAction(commitmentId, action, meta) {
        const c = commitments.get(commitmentId);
        // Bug review independen (audit putaran-26, AUD26-P2-1): sama seperti grantApproval/transition.
        if (!c) fail(REASONS.UNKNOWN_GOAL, `commitment '${typeof commitmentId === "string" ? commitmentId : typeof commitmentId}' tidak ditemukan`);
        // Bug review independen (audit putaran-23, AUD23-P2-2): meta null
        // diteruskan mentah ke lifecycle's `{ evidenceRef = null } = {}`
        // (default cuma berlaku untuk undefined) jadi TypeError mentah --
        // sibling `transition()` sudah aman lewat `{ ...meta, nowIso }`.
        // Bug review independen (audit putaran-46, W7R46-P2-3): `{...(meta
        // || {})}` men-spread `meta` mentah -- Proxy yang di-revoke
        // melempar TypeError mentah pada `ownKeys` yang dipakai spread.
        let safeMeta;
        try {
            safeMeta = { ...(meta || {}) };
        } catch {
            fail(REASONS.INVALID_RECORD, "meta tidak dapat diverifikasi dengan aman, ditolak");
        }
        const next = transitionCommitment(c, action, safeMeta);
        commitments.set(commitmentId, next);
        return next;
    }

    function createPlan(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.planId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // planId yang sudah ada menimpanya kembali ke state DRAFT, membuang
        // invalidatedBy yang sudah tercatat.
        // Bug review independen (audit putaran-31, AUD31-P2-1; putaran-32,
        // AUD32-P2-1): planId DAN steps wajib dibaca SEKALI SAJA masing-
        // masing. Membaca `planId` lewat `spec.planId` lalu memisahkan
        // `steps` lewat destructuring TERPISAH ternyata tetap salah --
        // rest-destructuring (`...specRest`) menyalin SEMUA kunci enumerable
        // yang tersisa (termasuk `planId`), jadi getter `planId` tetap
        // terpanggil KEDUA kalinya lewat penyalinan rest itu. Keduanya
        // sekarang dikeluarkan bersama dalam SATU pernyataan destructuring
        // supaya `specRest` benar-benar tidak lagi menyentuh planId maupun
        // steps sama sekali.
        // Bug review independen (audit putaran-44, W7R44-P2-2): sibling
        // dari createCommitment/createTask di file yang sama.
        let planId, steps, specRest;
        try {
            ({ planId, steps, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (planId && plans.has(planId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `planId '${typeof planId === "string" ? planId : typeof planId}' sudah ada`);
        }
        // Bug review independen (audit putaran-42, W7R42-P2-3; putaran-43,
        // W7R43-P2-8): versi sebelumnya membaca `steps.length` MENTAH DI SINI
        // untuk cek kuota, LALU makePlan/buildSafeArray membaca
        // `steps.length` LAGI secara terpisah untuk membangun salinan --
        // sebuah Proxy dengan getter `length` yang berbohong pada baca kedua
        // (mis. `1` lalu `1000`) lolos cek kuota tapi menyimpan 1000 elemen,
        // MEMALSUKAN penegakan MAX_STEPS_PER_PLAN sepenuhnya (bukan cuma
        // raw-throw). Kuota sekarang ditegakkan SATU-SATUNYA di dalam
        // buildSafeArray (dipanggil dari makePlan) memakai `len` yang
        // di-cache SEKALI di sana -- tidak ada pembacaan `.length` kedua di
        // sini sama sekali, jadi tidak ada celah divergensi yang mungkin.
        const p = makePlan({ ...specRest, planId: planId ?? crypto.randomUUID(), steps, maxSteps: bounds.MAX_STEPS_PER_PLAN });
        plans.set(p.planId, p);

        // Bug diketemukan review independen (Codex): MAX_PLAN_VERSIONS_RETAINED
        // dideklarasikan tapi tidak pernah ditegakkan — plans per goal bisa
        // tumbuh tak terbatas lewat re-planning berulang. §8: kompaksi tertua.
        // Bug review independen (audit putaran-7, W7R7-P2-1): versi lama
        // memasukkan plan yang BARU DIBUAT (p) sendiri ke kumpulan kandidat
        // korban -- jika versinya kebetulan paling kecil (mis. dibuat di luar
        // urutan: v3,v2,v1, lalu v0), createPlan() mengembalikan record yang
        // barusan dihapusnya sendiri. p sekarang SELALU dikecualikan dari
        // kandidat korban di kedua kompaksi (per-goal dan global).
        const otherSameGoal = [...plans.values()]
            .filter(x => x.goalRef === p.goalRef && x.planId !== p.planId)
            .sort((a, b) => a.version - b.version);
        const totalForGoal = otherSameGoal.length + 1; // +1 untuk p sendiri
        // Bug review independen (audit putaran-59, OpenCode, W7R59-P2-1):
        // bound 0/fractional < 1 (sanksi sah lewat sanitizeBounds) membuat
        // `overflow` melebihi `otherSameGoal.length` (p sendiri, +1 di
        // atas, tidak pernah masuk populasi yang diindeks) -- indeks
        // terakhir membaca `undefined.planId`, raw-throw. Dibulatkan
        // integer >= 0, loop dibatasi ke populasi yang benar-benar ada.
        const keepMax = Math.max(0, Math.trunc(bounds.MAX_PLAN_VERSIONS_RETAINED));
        if (totalForGoal > keepMax) {
            const overflow = Math.min(totalForGoal - keepMax, otherSameGoal.length);
            for (let i = 0; i < overflow; i++) plans.delete(otherSameGoal[i].planId);
        }
        // Bug review independen (audit putaran-6, W7R6-P2-1): MAX_PLAN_VERSIONS_RETAINED
        // hanya membatasi PER goalRef -- createPlan tidak pernah memvalidasi
        // goalRef benar-benar ada, jadi banyak goalRef berbeda (termasuk yang
        // palsu/tidak ada) bisa menumpuk plan tanpa batas TOTAL. Kompaksi
        // global tertua (lintas semua goalRef) saat retensi total penuh --
        // selalu ada korban karena tidak ada kelas plan yang "dilindungi"
        // (selain p sendiri, yang dikecualikan di sini juga).
        if (plans.size > bounds.MAX_TOTAL_PLANS_RETAINED) {
            for (const k of plans.keys()) {
                if (k !== p.planId) { plans.delete(k); break; }
            }
        }
        return p;
    }

    /** P-1: assumption yang superseded/contested membatalkan rencana — dipanggil eksplisit oleh caller (pull, bukan subscription). */
    function invalidatePlanIfAssumptionBroken(planId, brokenBeliefRef) {
        const plan = plans.get(planId);
        // Bug review independen (audit putaran-26, AUD26-P2-1): sama seperti grantApproval/transition.
        if (!plan) fail(REASONS.UNKNOWN_GOAL, `plan '${typeof planId === "string" ? planId : typeof planId}' tidak ditemukan`);
        // Bug review independen (audit putaran-13, AUD13-P2-3): brokenBeliefRef
        // diteruskan mentah ke invalidatedBy -- BigInt meledakkan
        // JSON.stringify saat persist().
        if (typeof brokenBeliefRef !== "string" || !brokenBeliefRef) {
            fail(REASONS.INVALID_RECORD, "brokenBeliefRef wajib string");
        }
        // Bug review independen (audit putaran-57, OpenCode, W7R57-P2-1):
        // (a) tidak ada guard status terminal -- plan yang sudah
        // INVALIDATED tetap menerima entry baru lewat panggilan publik
        // berulang; (b) invalidatedBy tidak dibatasi, tumbuh tak
        // terbatas (diukur: 200000 panggilan -> 200000 entri, O(n^2)
        // karena tiap panggilan menyalin ulang array). Dibatasi
        // MAX_INVALIDATED_BY_PER_PLAN lewat slice(-bound); panggilan
        // berulang pada plan yang sudah INVALIDATED ditolak.
        if (plan.state === "INVALIDATED") {
            fail(REASONS.INVALID_TRANSITION, "plan sudah INVALIDATED");
        }
        // Bug review independen (audit putaran-58, Codex, W7R58-P2-1):
        // `.slice(-bound)` dengan bound 0 jadi `.slice(-0)` -- -0 === 0,
        // `.slice(0)` mengembalikan SELURUH array, bukan array kosong.
        // Bound fractional antara 0 dan 1 trunc ke -0, bug yang sama.
        // Ditangani eksplisit: bound dibulatkan ke integer >= 0, cabang
        // 0 mengembalikan array kosong secara langsung.
        const maxInvalidatedBy = Math.max(0, Math.trunc(bounds.MAX_INVALIDATED_BY_PER_PLAN));
        const combinedInvalidatedBy = [...plan.invalidatedBy, brokenBeliefRef];
        const next = Object.freeze({
            ...plan, state: "INVALIDATED",
            invalidatedBy: Object.freeze(
                maxInvalidatedBy === 0 ? [] : combinedInvalidatedBy.slice(-maxInvalidatedBy)
            )
        });
        plans.set(planId, next);
        return next;
    }

    function createTask(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.taskId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // taskId yang sudah ada mengganti task (termasuk yang sudah
        // ATTEMPTS_EXCEEDED/DONE) dengan attempts:0/state:PENDING baru,
        // melewati batas percobaan dan finalitas state terminal.
        // Bug review independen (audit putaran-31, AUD31-P2-1; putaran-34,
        // AUD34-ADV-1): `spec.taskId`/`spec.maxAttempts` dikeluarkan
        // bersama lewat destructuring (bukan `spec.x` terpisah lalu
        // `{...spec}` di bawah) -- spread objek membaca ULANG setiap
        // properti yang tersisa termasuk keduanya, jadi override sesudahnya
        // cuma membuang hasil baca kedua itu, tidak mencegahnya terjadi.
        // Bug review independen (audit putaran-44, W7R44-P2-2): sibling
        // dari createCommitment/createPlan di file yang sama.
        let taskId, maxAttempts, specRest;
        try {
            ({ taskId, maxAttempts, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (taskId && tasks.has(taskId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `taskId '${typeof taskId === "string" ? taskId : typeof taskId}' sudah ada`);
        }
        // Bug review independen (audit putaran-6, W7R6-P2-2): validasi/bangun
        // record DULU (sama seperti createCommitment), baru kompaksi+simpan.
        // Bug review independen (audit putaran-9, AUD9-P2-4): `Math.min(spec.
        // maxAttempts ?? 5, MAX)` tidak menyaring NaN/string -- `??` hanya
        // menangkap null/undefined, jadi maxAttempts: NaN atau "abc" lolos ke
        // Math.min dan menghasilkan NaN. `attempts > NaN` selalu false, jadi
        // ATTEMPTS_EXCEEDED tidak pernah tercapai (retry tanpa batas).
        const safeMaxAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0
            ? Math.min(maxAttempts, bounds.MAX_ATTEMPTS_PER_TASK)
            : 5;
        const t = makeTask({ ...specRest, taskId: taskId ?? crypto.randomUUID(), maxAttempts: safeMaxAttempts });
        // Bug review independen (audit putaran-5, W7R5-P2-3): tasks tidak
        // punya batas total sama sekali. Kompaksi task terminal (DONE/SKIPPED)
        // tertua saat retensi penuh; task FAILED/lainnya dipertahankan karena
        // masih bisa "retry". Bug review independen (audit putaran-6,
        // W7R6-P1-1): TIDAK SEPERTI commitments, tasks tidak punya batas
        // independen pada kelas yang tidak bisa dievict (PENDING/READY/
        // EXECUTING/VERIFYING/FAILED) -- populasi murni non-terminal bisa
        // tumbuh tak terbatas karena tidak pernah ada korban DONE/SKIPPED.
        // Gagal tertutup di sini, sama seperti proposeGoal's retention check.
        if (tasks.size >= bounds.MAX_TOTAL_TASKS_RETAINED) {
            const terminal = [...tasks.values()].filter(x => x.state === "DONE" || x.state === "SKIPPED")[0];
            if (terminal) {
                tasks.delete(terminal.taskId);
            } else {
                fail(REASONS.TASK_RETENTION_LIMIT_EXCEEDED,
                    `retensi task melebihi batas (${bounds.MAX_TOTAL_TASKS_RETAINED}) dan tidak ada task DONE/SKIPPED untuk dievict`);
            }
        }
        tasks.set(t.taskId, t);
        return t;
    }

    function transitionTaskAction(taskId, action) {
        const t = tasks.get(taskId);
        // Bug review independen (audit putaran-26, AUD26-P2-1): sama seperti grantApproval/transition.
        if (!t) fail(REASONS.UNKNOWN_TASK, `task '${typeof taskId === "string" ? taskId : typeof taskId}' tidak ditemukan`);
        const next = transitionTask(t, action);
        tasks.set(taskId, next);
        return next;
    }

    function getGoal(goalId) { return goals.get(goalId) ?? null; }
    function getTask(taskId) { return tasks.get(taskId) ?? null; }
    function getPlan(planId) { return plans.get(planId) ?? null; }
    function childCountsSize() { return childCounts.size; }
    function creationTimestampsSize() { return creationTimestampsByOrigin.size; }
    function commitmentsSize() { return commitments.size; }
    function tasksSize() { return tasks.size; }
    function plansSize() { return plans.size; }

    async function persist() { return saveSnapshot(store, { goals, commitments, plans, tasks }); }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        proposeGoal, grantApproval, transition, getGoal,
        createCommitment, transitionCommitment: transitionCommitmentAction,
        createPlan, invalidatePlanIfAssumptionBroken, getPlan,
        createTask, transitionTask: transitionTaskAction, getTask,
        childCountsSize, creationTimestampsSize, commitmentsSize, tasksSize, plansSize,
        persist, laws, bounds
    });
}

module.exports = { createGoalEngine, laws, BOUNDS };
