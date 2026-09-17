"use strict";

/**
 * W8-L3 SPATIAL, SCENE AND ENVIRONMENT MODEL.
 *
 * ACC subdomain `src/cognition/spatial/**`, new -- builds on
 * `src/mataDewa/spatial/**` primitives (epistemic freshness bands reused
 * below), does not re-derive them.
 *
 * SPATIAL ESTIMATE != AUTHORITY. L3 never moves anything and never
 * authorizes motion; it only answers occupancy/reachability queries that a
 * caller (eventually L4/Authority, via L6) consults before acting.
 *
 * Contract: C:\Workspace\Damar-audit-evidence\wave7-10\wave8-recon\WAVE8_CONTRACTS_FROZEN.md
 * "## W8-L3 -- Spatial / Scene Model". Baseline SHA f397ce4.
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { sanitizeBounds } = require("../core/bounds");
const { laws } = require("./laws");
const utilTypes = require("node:util").types;
const { isDeepStrictEqual } = require("node:util");
/** `Object.getOwnPropertyDescriptor` lewat intrinsic tetap (tanpa pencarian properti). */
const GET_OWN_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const { makeFrame, makeTransform, makeSceneNode, readSpecFields, requireStringId, canonicalRegionKey, buildSafeSpatialValue } = require("./records");
const { loadSnapshot, saveSnapshot } = require("./store");
const { freshnessBand } = require("../../mataDewa/spatial/epistemic");

// Bands other than "fresh"/"aging" are treated as stale for blocking
// purposes -- "unknown never means clear" extends to "stale never means
// clear either" (audit round 1, AUDL3-P1-1).
const NON_BLOCKING_BANDS = new Set(["fresh", "aging"]);

function sceneNodeKey(frameId, region) {
    return `${frameId}::${canonicalRegionKey(region)}`;
}

/**
 * Resolve `append` milik audit ledger lewat DESKRIPTOR, di sepanjang rantai
 * prototipe.
 *
 * `typeof auditLedger.append === "function"` adalah `[[Get]]` mentah: ledger
 * yang memasang getter di sana menjalankan kode pemanggil SEBELUM hook audit
 * sempat menangkap kegagalannya, jadi batas "tanpa eksekusi kode" tidak benar
 * (audit Wave8 L3/L5). Accessor diperlakukan sebagai tidak dapat dipakai.
 */
function resolveAuditAppend(auditLedger) {
    if (!auditLedger || (typeof auditLedger !== "object" && typeof auditLedger !== "function")) return null;
    let level = auditLedger;
    const seen = new Set();
    while (level && (typeof level === "object" || typeof level === "function")) {
        if (level === Object.prototype || level === Function.prototype) break;
        if (seen.has(level)) break;
        seen.add(level);
        if (utilTypes.isProxy(level)) return null;
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(level, "append");
        } catch {
            return null;
        }
        if (desc) {
            if (desc.get || desc.set) return null;
            return typeof desc.value === "function" ? desc.value : null;
        }
        try {
            level = Object.getPrototypeOf(level);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Absorpsi hasil audit, TANPA pernah memanggil `then` milik pemanggil.
 *
 * Versi-versi sebelumnya memanggil `then` (lewat `then.call` lalu lewat
 * `Reflect.apply`) dan hanya bisa menyerap promise yang DIKEMBALIKAN. Itu tidak
 * cukup: sebuah `then` milik pemanggil dapat mengeksekusi `Promise.reject(...)`
 * lalu mengembalikan `undefined`, sehingga penolakan itu lepas sama sekali dan
 * hanya bisa diamati sebagai `unhandledRejection` -- di bawah kebijakan Node
 * yang ketat, proses berhenti (audit a9cc5db). Memanggil kode pemanggil juga
 * bertentangan dengan batas "hook audit tidak menjalankan kode pemanggil".
 *
 * Karena itu `then` milik pemanggil TIDAK PERNAH dijalankan. Hanya promise ASLI
 * (dikenali lewat brand intrinsik `util.types.isPromise`, yang juga benar untuk
 * promise lintas-realm) yang diberi handler, dan handler itu dipasang lewat
 * `Promise.prototype.then` INTRINSIK sehingga tidak ada pencarian properti pada
 * objek pemanggil.
 *
 * Konsekuensi yang DISEBUT: thenable buatan sendiri (bukan Promise asli) tidak
 * lagi diikuti. Untuk hook audit itu justru yang diinginkan -- hook yang ingin
 * hasilnya diobservasi harus mengembalikan Promise asli.
 */
const REFLECT_APPLY = Reflect.apply;
const PROMISE_THEN = Promise.prototype.then;
const IS_PROMISE_INTRINSIC = utilTypes.isPromise;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;

function absorbAuditResult(result) {
    if (!result || (typeof result !== "object" && typeof result !== "function")) return;
    let isRealPromise;
    try {
        isRealPromise = REFLECT_APPLY(IS_PROMISE_INTRINSIC, utilTypes, [result]);
    } catch {
        return;
    }
    if (!isRealPromise) return;   // thenable pemanggil tidak pernah dipanggil
    // `Promise.prototype.then` membaca `constructor`/`Symbol.species` milik
    // promise itu untuk menentukan konstruktor hasil. Accessor yang melempar di
    // sana membuat pemasangan handler GAGAL dan rejection aslinya lepas sebagai
    // unhandledRejection (audit 03956b6). Karena itu `constructor` dinetralkan
    // dulu menjadi data-property yang menunjuk ke `Promise` bawaan.
    try {
        REFLECT_APPLY(DEFINE_PROPERTY, Object, [result, "constructor", {
            value: Promise, writable: true, enumerable: false, configurable: true
        }]);
    } catch { /* non-extensible + non-configurable: tidak dapat dinetralkan */ }
    try {
        REFLECT_APPLY(PROMISE_THEN, result, [undefined, () => {}]);
    } catch { /* handler sudah terpasang bila memungkinkan */ }
}

async function createSpatialModel({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS, auditLedger = null } = {}) {
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    // Audit hook (contract L3: "frame registration, transform changes,
    // occupancy CONTRADICTIONS are audited"; and "overflow evicts STALE
    // regions first (never live/fresh ones), audited"). Kegagalan audit TIDAK
    // PERNAH menggagalkan operasi yang diaudit -- pola yang sama dengan lane
    // Wave7 lainnya.
    function audit(eventType, fields) {
        try {
            const append = resolveAuditAppend(auditLedger);
            if (append) {
                // `append.call(...)` adalah pencarian properti `call` pada objek
                // fungsi milik pemanggil: getter `call` yang melempar dapat
                // men-detach rejection dan membuat hook audit gagal tanpa jejak
                // (audit 03956b6). `Reflect.apply` yang dibekukan tidak melakukan
                // pencarian properti apa pun. `FREEZE` juga dibekukan agar
                // penimpaannya tidak dapat membuat payload audit dapat diubah.
                const result = REFLECT_APPLY(append, auditLedger, [FREEZE({
                    eventType, source: "acc.spatial", outcome: "ok",
                    metadata: FREEZE({ lane: "W8-L3", ...fields })
                })]);
                // Hook audit bisa ASYNC dan menolak. Seluruh pemeriksaan hasil
                // (termasuk nilai kembalian `then`) ditangani absorbAuditResult
                // tanpa satu pun pencarian properti pada objek pemanggil.
                absorbAuditResult(result);
            }
        } catch { /* audit failure never blocks the lane */ }
    }

    const snapshot = await loadSnapshot(store);
    const frames = snapshot.frames;
    const transforms = snapshot.transforms;
    const sceneNodes = snapshot.sceneNodes;
    const coldStart = snapshot.coldStart;
    if (snapshot.degraded) {
        audit("cognition.spatial.store_unreadable", { reason: "store-unreadable-or-hostile" });
    }

    /**
     * Record tersimpan harus lulus builder lane ini DAN tidak dinormalkan olehnya.
     *
     * Builder MENORMALKAN beberapa medan (mis. `observationRefs` non-array
     * menjadi `[]`). "Lulus builder" saja karena itu bukan bukti bentuk yang
     * benar: record ASLINYA tetap tersimpan apa adanya, sehingga
     * `observationRefs` berisi objek tetap ter-expose lewat getScene() /
     * queryOccupancy() dan membuat update sah gagal dengan TypeError (audit
     * 472b6e0).
     *
     * Karena itu SALINAN AMAN record tersimpan dibandingkan dengan hasil
     * builder: setiap medan yang dinormalkan membuat keduanya tidak sama, jadi
     * record itu ditolak. Salinan diambil lewat buildSafeSpatialValue
     * (deskriptor, tanpa accessor) dan hasil builder sudah disanitasi builder,
     * sehingga perbandingan ini tidak menjalankan kode pemanggil.
     */
    function isCanonicallyEqual(stored, canonical, defaults = null) {
        let safeStored;
        try {
            safeStored = buildSafeSpatialValue(stored);
        } catch {
            return false;
        }
        if (!safeStored || typeof safeStored !== "object") return false;
        if (defaults !== null) {
            // Medan yang boleh ABSEN di snapshot lama dibandingkan sebagai
            // nilai default-nya. Disalin dari hasil sanitasi (objek milik kita),
            // bukan dari input mentah.
            const withDefaults = {};
            for (const key of Object.keys(safeStored)) withDefaults[key] = safeStored[key];
            for (const key of Object.keys(defaults)) {
                if (withDefaults[key] === undefined) withDefaults[key] = defaults[key];
            }
            return isDeepStrictEqual(withDefaults, canonical);
        }
        return isDeepStrictEqual(safeStored, canonical);
    }

    /** Record tersimpan harus lulus BUILDER lane ini, bukan sekadar berbentuk objek. */
    function isWellFormedPersistedFrame(id, frame) {
        if (!frame || typeof frame !== "object") return false;
        if (frame.frameId !== id) return false;
        if (!Number.isFinite(frame.registeredAt) || frame.registeredAt > now()) return false;
        let canonical;
        try {
            canonical = makeFrame({
                frameId: frame.frameId, kind: frame.kind, ref: frame.ref,
                source: frame.source, nowMs: frame.registeredAt
            }, bounds);
        } catch { return false; }
        return isCanonicallyEqual(frame, canonical);
    }

    function isWellFormedPersistedTransform(id, transform) {
        if (!transform || typeof transform !== "object") return false;
        if (transform.transformId !== id) return false;
        // `registeredAt` masa depan TIDAK sah: builder hanya menyalin `nowMs`,
        // jadi memakai builder saja tidak menangkapnya, padahal transform
        // seperti itu menempati kapasitas dan mengevict transform sah pada
        // batas retensi (audit de9553c).
        if (!Number.isFinite(transform.registeredAt) || transform.registeredAt > now()) return false;
        if (!frames.has(transform.fromFrameId) || !frames.has(transform.toFrameId)) return false;
        let canonical;
        try {
            canonical = makeTransform({
                transformId: transform.transformId, fromFrameId: transform.fromFrameId,
                toFrameId: transform.toFrameId, data: transform.data, nowMs: transform.registeredAt
            }, bounds);
        } catch { return false; }
        return isCanonicallyEqual(transform, canonical);
    }

    function isWellFormedPersistedSceneNode(key, node) {
        if (!node || typeof node !== "object") return false;
        if (!frames.has(node.frameId)) return false;
        if (key !== sceneNodeKey(node.frameId, node.region)) return false;
        if (!Number.isFinite(node.updatedAtMs) || node.updatedAtMs > now()) return false;
        // `sources` ditambahkan pada revisi ini. Snapshot lama yang BELUM punya
        // medan itu tetap sah dan diperlakukan sebagai daftar kosong -- tetapi
        // HANYA bila medannya benar-benar tidak ada. Sebelumnya `undefined`
        // eksplisit diperlakukan sama dengan "tidak ada" untuk perbandingan,
        // sementara nilai `undefined` itu tetap tersimpan dan ter-expose, jadi
        // persamaan kanonik bisa dilewati (audit a9cc5db). Keberadaan medan
        // diperiksa lewat DESKRIPTOR, bukan `in`/`hasOwnProperty` yang dapat
        // ditimpa pada objek pemanggil.
        let hasOwnSources = false;
        try {
            hasOwnSources = REFLECT_APPLY(GET_OWN_DESCRIPTOR, Object, [node, "sources"]) !== undefined;
        } catch {
            return false;
        }
        if (hasOwnSources && !Array.isArray(node.sources)) return false;
        const sourcesForCompare = hasOwnSources ? node.sources : [];
        let canonical;
        try {
            canonical = makeSceneNode({
                nodeId: node.nodeId, frameId: node.frameId, region: node.region,
                state: node.state, observationRefs: node.observationRefs,
                sources: sourcesForCompare,
                updatedAtMs: node.updatedAtMs
            }, bounds);
        } catch { return false; }
        return isCanonicallyEqual(node, canonical, hasOwnSources ? null : { sources: [] });
    }

    // Persisted maps are untrusted input. Reconcile them BEFORE compaction:
    // compacting first lets a MALFORMED entry occupy capacity and evict a
    // VALID record, so good state is lost while the bad state is merely dropped
    // afterwards (audit fdda055).
    //
    // Validasi memakai BUILDER lane ini, bukan pemeriksaan sebagian. Versi
    // sebelumnya hanya memeriksa id/waktu, sehingga sebuah frame dengan `kind`
    // tidak dikenal dan `source` kosong lolos rekonsiliasi lalu -- karena
    // validasi berjalan sebelum kompaksi -- menempati kapasitas dan mengevict
    // frame SAH yang lebih lama (audit ba68903). Builder adalah kontrak bentuk
    // record, jadi memakainya ulang menutup SELURUH medan sekaligus.
    for (const [id, frame] of [...frames]) {
        if (!isWellFormedPersistedFrame(id, frame)) frames.delete(id);
    }
    for (const [id, transform] of [...transforms]) {
        if (!isWellFormedPersistedTransform(id, transform)) transforms.delete(id);
    }
    // SIKLUS TERSIMPAN. Transform yang membentuk siklus (A→B→A) HARUS ditolak
    // saat penulisan, dan snapshot lama bisa membawanya; membiarkannya berarti
    // graf transform yang mustahil tetap dapat di-query sebagai geometri sah
    // dan menghidupkan precondition di atas geometri palsu (audit fdda055).
    // Setiap transform yang ikut siklus dibuang dan diaudit sampai asiklik.
    for (;;) {
        let droppedOne = false;
        for (const [id, transform] of [...transforms]) {
            if (wouldCreateCycle(transform.fromFrameId, transform.toFrameId, id)) {
                transforms.delete(id);
                audit("cognition.spatial.transform_cycle_rejected", { transformId: id, reason: "restart-reconciliation" });
                droppedOne = true;
            }
        }
        if (!droppedOne) break;
    }
    for (const [key, node] of [...sceneNodes]) {
        if (!isWellFormedPersistedSceneNode(key, node)) sceneNodes.delete(key);
    }

    // Bug-class awareness (this session's own Wave7 audit history, rounds
    // 71-73): a reloaded snapshot persisted under a larger bound must be
    // compacted to the ACTIVE bound at construction, before any record is
    // exposed -- not just at insert time.
    //
    // Bug review independen (audit round 1, Codex, AUDL3-P1-2): transforms
    // MUST be compacted BEFORE frames -- a frame still referenced by a live
    // transform can never be evicted, so compacting frames first (while
    // over-bound transforms still hold references) stalls frame compaction
    // early and leaves the frame collection over its active bound. Reversed
    // order.
    {
        const maxTransforms = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS));
        while (transforms.size > maxTransforms) {
            let victimId = null, victimAt = Infinity;
            for (const t of transforms.values()) {
                if (t.registeredAt < victimAt) { victimAt = t.registeredAt; victimId = t.transformId; }
            }
            if (!victimId) break;
            transforms.delete(victimId);
        }
        const maxFrames = Math.max(0, Math.trunc(bounds.MAX_FRAMES));
        while (frames.size > maxFrames) {
            let victimId = null, victimAt = Infinity;
            for (const f of frames.values()) {
                const referenced = [...transforms.values()].some(t => t.fromFrameId === f.frameId || t.toFrameId === f.frameId);
                if (referenced) continue;
                if (f.registeredAt < victimAt) { victimAt = f.registeredAt; victimId = f.frameId; }
            }
            if (!victimId) break;
            frames.delete(victimId);
            // Bug review independen (audit round 2, Codex, AUDL3-P1-1):
            // mengevict frame TANPA mengevict scene node yang menunjuk ke
            // frame itu membuat geometri yatim tetap queryable sebagai KNOWN
            // -- getScene()/queryOccupancy() melaporkan occupancy untuk frame
            // yang sudah tidak ada, melanggar konsistensi snapshot dan bisa
            // meloloskan precondition fisik pakai geometri basi.
            for (const [k, n] of [...sceneNodes]) {
                if (n.frameId === victimId) sceneNodes.delete(k);
            }
        }
        const maxNodes = Math.max(0, Math.trunc(bounds.MAX_SCENE_NODES));
        while (sceneNodes.size > maxNodes) {
            // evict-stale-first: prefer UNKNOWN/CONTESTED, oldest updatedAtMs, never live/fresh KNOWN nodes if a stale one exists.
            // Memakai CLOCK YANG DISUNTIKKAN, bukan Date.now(): jam dinding
            // membuat klasifikasi stale bergantung pada waktu nyata alih-alih
            // waktu lane, sehingga hasilnya tidak deterministik di test
            // (audit Wave8 L3/L5).
            const compactionNowMs = now();
            let victimKey = null, victimAt = Infinity, foundStale = false;
            for (const [k, n] of sceneNodes) {
                const isStale = !NON_BLOCKING_BANDS.has(freshnessBand(n.updatedAtMs, {}, compactionNowMs));
                if (foundStale && !isStale) continue;
                if (isStale && !foundStale) { foundStale = true; victimAt = Infinity; }
                if (n.updatedAtMs < victimAt) { victimAt = n.updatedAtMs; victimKey = k; }
            }
            if (!victimKey) break;
            sceneNodes.delete(victimKey);
            // Eviction saat restart juga diaudit, sama seperti eviction saat
            // insert (audit Wave8 L3/L5).
            audit("cognition.spatial.scene_node_evicted", { nodeId: victimKey, reason: "restart-compaction" });
        }
    }

    function now() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }

    // (Reconciliation already ran BEFORE compaction above -- see that block.)

    function registerFrame(spec) {
        const { frameId, kind, ref, source } = readSpecFields(spec, ["frameId", "kind", "ref", "source"]);
        const existing = frames.get(frameId);
        const frame = makeFrame({ frameId, kind, ref, source, nowMs: now() }, bounds);
        if (!existing) {
            const maxFrames = Math.max(0, Math.trunc(bounds.MAX_FRAMES));
            while (frames.size >= maxFrames) {
                let victimId = null, victimAt = Infinity;
                for (const f of frames.values()) {
                    if (f.frameId === frame.frameId) continue;
                    const referenced = [...transforms.values()].some(t => t.fromFrameId === f.frameId || t.toFrameId === f.frameId);
                    if (referenced) continue;
                    if (f.registeredAt < victimAt) { victimAt = f.registeredAt; victimId = f.frameId; }
                }
                if (!victimId) {
                    if (maxFrames === 0) return frame; // cap 0: never stored, report the built record as-is
                    fail(REASONS.BOUND_EXCEEDED, `retensi frame melebihi batas (${maxFrames}) dan tidak ada frame tak-terpakai untuk dievict`);
                }
                frames.delete(victimId);
                // AUDL3-P1-1 sibling: evicting a frame at insert-time must
                // also evict any scene node it owns, same as the
                // construction-time compaction fix above.
                for (const [k, n] of [...sceneNodes]) {
                    if (n.frameId === victimId) sceneNodes.delete(k);
                }
            }
        }
        frames.set(frame.frameId, frame);
        // Frame registration is audited (contract L3 verification hooks).
        audit(existing ? "cognition.spatial.frame_updated" : "cognition.spatial.frame_registered",
            { frameId: frame.frameId, kind: frame.kind });
        return frame;
    }

    function wouldCreateCycle(fromFrameId, toFrameId, ignoreTransformId = null) {
        // Would adding fromFrameId -> toFrameId let toFrameId reach fromFrameId already? DFS from toFrameId.
        const stack = [toFrameId];
        const seen = new Set();
        let steps = 0;
        const maxSteps = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS)) + 1;
        while (stack.length) {
            if (++steps > maxSteps) return true; // pathological graph -- fail closed as a cycle
            const cur = stack.pop();
            if (cur === fromFrameId) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const t of transforms.values()) {
                if (t.transformId === ignoreTransformId) continue;
                if (t.fromFrameId === cur) stack.push(t.toFrameId);
            }
        }
        return false;
    }

    function registerTransform(spec) {
        const { transformId, fromFrameId, toFrameId, data } = readSpecFields(spec, ["transformId", "fromFrameId", "toFrameId", "data"]);
        if (!frames.has(fromFrameId)) fail(REASONS.UNKNOWN_FRAME, `fromFrameId '${typeof fromFrameId === "string" ? fromFrameId : typeof fromFrameId}' belum terdaftar`);
        if (!frames.has(toFrameId)) fail(REASONS.UNKNOWN_FRAME, `toFrameId '${typeof toFrameId === "string" ? toFrameId : typeof toFrameId}' belum terdaftar`);
        const existing = transforms.get(transformId);
        if (wouldCreateCycle(fromFrameId, toFrameId, existing?.transformId ?? null)) {
            fail(REASONS.TRANSFORM_CYCLE_REJECTED, "transform ditolak: akan membentuk siklus pada graf frame");
        }
        const transform = makeTransform({ transformId, fromFrameId, toFrameId, data, nowMs: now() }, bounds);
        if (!existing) {
            const maxTransforms = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS));
            while (transforms.size >= maxTransforms) {
                let victimId = null, victimAt = Infinity;
                for (const t of transforms.values()) {
                    if (t.transformId === transform.transformId) continue;
                    if (t.registeredAt < victimAt) { victimAt = t.registeredAt; victimId = t.transformId; }
                }
                if (!victimId) {
                    if (maxTransforms === 0) return transform;
                    fail(REASONS.BOUND_EXCEEDED, `retensi transform melebihi batas (${maxTransforms})`);
                }
                transforms.delete(victimId);
                audit("cognition.spatial.transform_evicted", { transformId: victimId, reason: "overflow" });
            }
        }
        transforms.set(transform.transformId, transform);
        // Transform changes are audited (contract L3 verification hooks).
        audit(existing ? "cognition.spatial.transform_changed" : "cognition.spatial.transform_registered",
            { transformId: transform.transformId, fromFrameId: transform.fromFrameId, toFrameId: transform.toFrameId });
        return transform;
    }

    /** Reports occupancy for a region as observed by one observationRef. Disagreement -> CONTESTED (blocks), never silently picked. */
    function reportOccupancy(spec) {
        const { frameId, region, state, observationRef, source } = readSpecFields(spec, ["frameId", "region", "state", "observationRef", "source"]);
        requireStringId(frameId, "frameId");
        if (!frames.has(frameId)) fail(REASONS.UNKNOWN_FRAME, `frameId '${frameId}' belum terdaftar`);
        if (typeof observationRef !== "string" || !observationRef) fail(REASONS.INVALID_RECORD, "observationRef wajib string");
        const sourceId = (typeof source === "string" && source) ? source : observationRef;
        const key = sceneNodeKey(frameId, region);
        const existing = sceneNodes.get(key);
        let nextState = state;
        let refs = [observationRef];
        let sources = [sourceId];
        if (existing) {
            const alreadyKnown = existing.observationRefs.includes(observationRef);
            refs = alreadyKnown ? [...existing.observationRefs] : [...existing.observationRefs, observationRef];
            const priorSources = Array.isArray(existing.sources) && existing.sources.length > 0
                ? existing.sources
                : existing.observationRefs;
            sources = priorSources.includes(sourceId) ? [...priorSources] : [...priorSources, sourceId];
            if (existing.state !== "CONTESTED" && existing.state !== state) {
                // Kontes = PERSELISIHAN ANTAR-SUMBER (kontrak L3), dan kontes
                // MEMBLOKIR precondition gerak.
                //
                // BATAS YANG DISEBUT JUJUR: lane ini TIDAK memiliki identitas
                // pelapor yang terautentikasi. `observationRef` dan `source`
                // sama-sama label yang diberikan pemanggil, jadi aturan ini
                // hanya membedakan "pelapor yang sama merevisi bacaannya" dari
                // "pelapor berbeda berselisih" SEJAUH label itu jujur -- ia
                // bukan pertahanan terhadap pemanggil yang berniat buruk.
                // (Pemanggil `reportOccupancy` berada di domain kepercayaan yang
                // sama dan memang dapat menyatakan state apa pun; kontrak tidak
                // menyediakan medan identitas terautentikasi untuk lane ini,
                // berbeda dari lane lain yang memakai provenance bertanda
                // tangan.)
                //
                // Dua aturan alternatif sudah dicoba dan ditolak:
                //   - memakai `source` (audit de9553c) -> dua pelapor cukup
                //     memakai label yang sama untuk menyembunyikan perselisihan;
                //   - menandai SETIAP perubahan sebagai CONTESTED (audit
                //     a9cc5db) -> region terkunci permanen hanya karena satu
                //     sensor memperbarui bacaannya, yang justru melanggar
                //     temuan yang sudah diterima (L3-audit-4) dan membuat
                //     kesegaran tidak bermakna.
                //
                // Karena itu perilaku kontrak dipertahankan: observasi dari slot
                // yang SAMA adalah revisi, `observationRef` BARU adalah kontes.
                // `source` tetap disimpan sebagai provenance.
                nextState = alreadyKnown ? state : "CONTESTED";
            } else if (existing.state === "CONTESTED") {
                nextState = "CONTESTED"; // once contested, stays contested until an explicit resolve (out of this lane's scope)
            }
        }
        const node = makeSceneNode({ nodeId: key, frameId, region, state: nextState, observationRefs: refs, sources, updatedAtMs: now() }, bounds);
        if (!existing) {
            const maxNodes = Math.max(0, Math.trunc(bounds.MAX_SCENE_NODES));
            while (sceneNodes.size >= maxNodes) {
                let victimKey = null, victimAt = Infinity, foundStale = false;
                for (const [k, n] of sceneNodes) {
                    if (k === node.nodeId) continue;
                    const isStale = !NON_BLOCKING_BANDS.has(freshnessBand(n.updatedAtMs, {}, now()));
                    if (foundStale && !isStale) continue;
                    if (isStale && !foundStale) { foundStale = true; victimAt = Infinity; }
                    if (n.updatedAtMs < victimAt) { victimAt = n.updatedAtMs; victimKey = k; }
                }
                if (!victimKey) {
                    if (maxNodes === 0) return node;
                    fail(REASONS.BOUND_EXCEEDED, `retensi scene node melebihi batas (${maxNodes})`);
                }
                sceneNodes.delete(victimKey);
                audit("cognition.spatial.scene_node_evicted", { nodeId: victimKey, reason: "overflow" });
            }
        }
        sceneNodes.set(node.nodeId, node);
        // Occupancy CONTRADICTIONS are audited (contract L3 verification
        // hooks) -- dua sumber yang berselisih mengunci region jadi CONTESTED
        // dan itu harus terlihat.
        if (nextState === "CONTESTED" && existing && existing.state !== "CONTESTED") {
            audit("cognition.spatial.occupancy_contradiction", {
                nodeId: node.nodeId, frameId, from: existing.state, to: nextState
            });
        }
        return node;
    }

    /**
     * UNKNOWN NEVER MEANS CLEAR: no node for a region -> blocked:true.
     * Bug review independen (audit round 1, Codex, AUDL3-P1-1): a KNOWN
     * node whose freshness band has decayed to "stale"/"expired" reported
     * blocked:false purely because `state === "KNOWN"` -- staleness never
     * fed into the blocking decision at all. Stale/expired KNOWN claims now
     * block too, same as UNKNOWN/CONTESTED -- "stale never means clear
     * either."
     */
    function queryOccupancy(spec) {
        const { frameId, region } = readSpecFields(spec, ["frameId", "region"]);
        requireStringId(frameId, "frameId");
        const key = sceneNodeKey(frameId, region);
        const node = sceneNodes.get(key);
        if (!node) return Object.freeze({ state: "UNKNOWN", blocked: true, freshnessMs: null, band: "unknown", provenance: Object.freeze([]) });
        const nowMs = now();
        const freshnessMs = nowMs - node.updatedAtMs;
        const band = freshnessBand(node.updatedAtMs, {}, nowMs);
        const blocked = node.state !== "KNOWN" || !NON_BLOCKING_BANDS.has(band);
        return Object.freeze({
            state: node.state,
            blocked,
            freshnessMs,
            band,
            provenance: node.observationRefs
        });
    }

    /** Sequence of hops; blocked if ANY hop is unknown/contested/stale. Bounded path length -- never a runaway traversal. */
    function queryReachability(spec) {
        const { frameId, path } = readSpecFields(spec, ["frameId", "path"]);
        requireStringId(frameId, "frameId");
        // Bug review independen (audit round 2, Codex, AUDL3-P2-1): `[...path]`
        // adalah spread biasa -- iterator/index [[Get]] yang mengeksekusi
        // accessor pada elemen manapun SEBELUM sanitasi apa pun berjalan.
        // Disaring sekali lewat buildSafeSpatialValue (descriptor-based,
        // sekarang juga memvalidasi properti non-indeks per AUDL3-P2-2),
        // bukan spread mentah.
        let hops;
        if (path === null || path === undefined) {
            hops = [];
        } else {
            let isArray;
            try {
                isArray = Array.isArray(path);
            } catch {
                fail(REASONS.INVALID_RECORD, "path tidak dapat diverifikasi dengan aman, ditolak");
            }
            if (!isArray) fail(REASONS.INVALID_RECORD, "path wajib array");
            hops = buildSafeSpatialValue(path);
        }
        const maxPath = Math.max(0, Math.trunc(bounds.MAX_REACHABILITY_PATH_LENGTH));
        if (hops.length > maxPath) fail(REASONS.BOUND_EXCEEDED, `panjang path reachability melebihi batas (${maxPath})`);
        const provenance = [];
        const freshness = [];
        for (let i = 0; i < hops.length; i++) {
            const result = queryOccupancy({ frameId, region: hops[i] });
            provenance.push(...result.provenance);
            freshness.push({ freshnessMs: result.freshnessMs, band: result.band });
            if (result.blocked) {
                return Object.freeze({ reachable: false, blockedAtIndex: i, blockedState: result.state,
                    provenance: Object.freeze(provenance), freshness: Object.freeze(freshness) });
            }
        }
        return Object.freeze({ reachable: true, blockedAtIndex: -1, blockedState: null,
            provenance: Object.freeze(provenance), freshness: Object.freeze(freshness) });
    }

    /** Returns the frame plus the ordered chain of transformIds connecting fromFrameId to toFrameId, or null if unreachable. Bounded BFS. */
    function resolveFrame(fromFrameId, toFrameId) {
        requireStringId(fromFrameId, "frameId");
        const frame = frames.get(fromFrameId);
        if (!frame) fail(REASONS.UNKNOWN_FRAME, `frameId '${fromFrameId}' belum terdaftar`);
        if (toFrameId === undefined || toFrameId === null) return Object.freeze({ frame, path: Object.freeze([]) });
        requireStringId(toFrameId, "toFrameId");
        if (!frames.has(toFrameId)) fail(REASONS.UNKNOWN_FRAME, `toFrameId '${toFrameId}' belum terdaftar`);
        const maxSteps = Math.max(0, Math.trunc(bounds.MAX_TRANSFORMS)) + 1;
        const queue = [[fromFrameId, []]];
        const seen = new Set([fromFrameId]);
        let steps = 0;
        while (queue.length) {
            if (++steps > maxSteps) break;
            const [cur, chain] = queue.shift();
            if (cur === toFrameId) return Object.freeze({ frame, path: Object.freeze(chain) });
            for (const t of transforms.values()) {
                if (t.fromFrameId === cur && !seen.has(t.toFrameId)) {
                    seen.add(t.toFrameId);
                    queue.push([t.toFrameId, [...chain, t.transformId]]);
                }
            }
        }
        return null;
    }

    function getScene() {
        return Object.freeze({
            frames: Object.freeze([...frames.values()]),
            transforms: Object.freeze([...transforms.values()]),
            sceneNodes: Object.freeze([...sceneNodes.values()])
        });
    }

    function framesSize() { return frames.size; }
    function transformsSize() { return transforms.size; }
    function sceneNodesSize() { return sceneNodes.size; }

    async function persist() {
        return saveSnapshot(store, { frames, transforms, sceneNodes });
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        spatialColdStart: coldStart,
        registerFrame, registerTransform, reportOccupancy,
        queryOccupancy, queryReachability, resolveFrame, getScene,
        framesSize, transformsSize, sceneNodesSize,
        persist, laws, bounds
    });
}

module.exports = { createSpatialModel, BOUNDS, SCHEMA_VERSION };
