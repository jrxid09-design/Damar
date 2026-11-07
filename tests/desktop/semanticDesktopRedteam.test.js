const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
    DesktopContextCore,
    ContextSnapshot,
    ENTITY_TYPE,
    DESKTOP_EVENT
} = require("../../src/desktop");
const { FakeDesktopAdapter } = require("../../src/desktop/adapters/FakeDesktopAdapter");
const {
    WindowsActiveWindowAdapter,
    SPAWN_ARGS,
    POWERSHELL_SCRIPT,
    POLL_MS_MINIMUM
} = require("../../src/desktop/adapters/WindowsActiveWindowAdapter");
const { makeHarness, rawObservation, E } = require("./helpers");

/**
 * SUITE RED-TEAM — sertifikasi perbaikan blocker B1..B11.
 * Setiap blok memetakan langsung ke temuan red-team.
 */

// =====================================================================
// B1 — DESERIALIZE SEBAGAI BATAS INPUT TAK TERPERCAYA
// =====================================================================

function validSnapshotJson() {
    const { core, adapter } = makeHarness();
    adapter.activateWindow({ windowId: "w1", appId: "a1", documentId: "d1" });
    adapter.selectText({ selectionId: "s1", text: "teks", length: 4, windowId: "w1" });
    return JSON.parse(ContextSnapshot.serialize(core.snapshot()));
}

test("B1: JSON round-trip nyata tetap berhasil", () => {
    const snap = validSnapshotJson();
    const rebuilt = ContextSnapshot.deserialize(JSON.stringify(snap));
    assert.equal(rebuilt.desktopContextId, snap.desktopContextId);
    assert.equal(Object.isFrozen(rebuilt), true);
});

test("B1: field tak dikenal (inject) gagal tertutup, tidak diam-diam bertahan", () => {
    const snap = validSnapshotJson();
    snap.__injected = { evil: true };

    // Validasi skema (tanpa integritas): field asing terdeteksi eksplisit.
    assert.throws(
        () => ContextSnapshot.deserialize(snap, { verifyIntegrity: false }),
        (err) => err.code === "INVALID_SNAPSHOT" &&
            err.errors.some((m) => m.includes("__injected"))
    );
    // Dan dengan integritas aktif pun tetap ditolak.
    assert.throws(
        () => ContextSnapshot.deserialize(snap),
        (err) => err.code === "INVALID_SNAPSHOT"
    );
});

test("B1: provenance palsu, type invalid, confidence invalid, revision invalid ditolak", () => {
    const base = validSnapshotJson();

    const cases = [
        (s) => { s.entities[0].provenance = "trusted-source-x"; },
        (s) => { s.entities[0].type = "ghost"; },
        (s) => { s.entities[0].confidence = 2; },
        (s) => { s.entities[0].revision = 0; },
        (s) => { s.entities[0].revision = 1.5; }
    ];

    for (const mutate of cases) {
        const snap = structuredClone(base);
        mutate(snap);
        assert.throws(
            () => ContextSnapshot.deserialize(snap, { verifyIntegrity: false }),
            (err) => err.code === "INVALID_SNAPSHOT",
            `kasus ${JSON.stringify(mutate)} harus ditolak`
        );
    }
});

test("B1: relasi menunjuk entitas absen (dangling) ditolak", () => {
    const snap = validSnapshotJson();
    snap.relationships.push({ from: "hantu", relation: "references", to: "w1" });
    assert.throws(
        () => ContextSnapshot.deserialize(snap, { verifyIntegrity: false }),
        (err) => err.code === "INVALID_SNAPSHOT" &&
            err.errors.some((m) => m.includes("hantu"))
    );
});

test("B1: pointer aktif ke entitas absen / tipe salah ditolak", () => {
    const base = validSnapshotJson();

    const absent = structuredClone(base);
    absent.active.windowId = "tidak-ada";
    assert.throws(
        () => ContextSnapshot.deserialize(absent, { verifyIntegrity: false }),
        (err) => err.code === "INVALID_SNAPSHOT" &&
            err.errors.some((m) => m.includes("active.windowId"))
    );

    const wrongType = structuredClone(base);
    wrongType.active.documentId = "a1"; // application menempati pointer dokumen
    assert.throws(
        () => ContextSnapshot.deserialize(wrongType, { verifyIntegrity: false }),
        (err) => err.code === "INVALID_SNAPSHOT" &&
            err.errors.some((m) => m.includes("active.documentId") && m.includes("tipe salah"))
    );
});

test("B1: restore attack — konten diubah tapi hash lama dipertahankan → integritas gagal", () => {
    const snap = validSnapshotJson();
    const originalId = snap.desktopContextId;

    // Serangan: ubah label (state palsu), pertahankan hash lama.
    snap.entities[0].label = "PALING GANTI";
    snap.desktopContextId = originalId;

    assert.throws(
        () => ContextSnapshot.deserialize(snap),
        (err) => err.code === "INVALID_SNAPSHOT" &&
            err.errors.some((m) => m.includes("integritas"))
    );

    // Kontrol positif: konten utuh lolos.
    const clean = validSnapshotJson();
    const ok = ContextSnapshot.deserialize(clean);
    assert.equal(ok.desktopContextId, clean.desktopContextId);
});

// =====================================================================
// B2 — INGEST ATOMIK
// =====================================================================

test("B2: entitas kedua bersifat sirkular → NOL mutasi kanonik", () => {
    const { core } = makeHarness();
    const circular = {};
    circular.self = circular;

    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED,
        observationId: "o-circ",
        subject: "w-ok",
        entities: [
            E("w-ok", ENTITY_TYPE.WINDOW, "entitas pertama sah"),
            E("x-bad", ENTITY_TYPE.APPLICATION, "entitas kedua rusak", circular)
        ]
    }));

    assert.equal(r.accepted, false);
    assert.equal(r.reasonCode, "ATTRIBUTES_NOT_SERIALIZABLE");
    assert.equal(core.version, 0);
    assert.equal(core.getStats().entities, 0);
    assert.equal(core.getActiveWindow(), null);
    assert.equal(core.getTransitionHistory().length, 0);
});

test("B2: atribut dengan getter yang melempar → NOL mutasi", () => {
    const { core } = makeHarness();
    const evil = {
        get size() { throw new Error("getter meledak"); }
    };

    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED,
        observationId: "o-getter",
        subject: "doc-evil",
        entities: [E("doc-evil", ENTITY_TYPE.DOCUMENT, "dokumen", evil)]
    }));

    assert.equal(r.accepted, false);
    assert.equal(core.version, 0);
    assert.equal(core.getStats().entities, 0);
});

test("B2: retry observasi yang ditolak bersifat deterministik", () => {
    const { core } = makeHarness();
    const circular = {};
    circular.self = circular;
    const obs = rawObservation({
        type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED,
        observationId: "o-retry",
        subject: "doc-x",
        entities: [E("doc-x", ENTITY_TYPE.DOCUMENT, "d", circular)]
    });

    const first = core.ingest(obs);
    const versionAfterFirst = core.version;
    const second = core.ingest(obs);

    assert.equal(first.accepted, false);
    assert.equal(second.accepted, false);
    assert.deepEqual(
        [first.reasonCode, first.detail],
        [second.reasonCode, second.detail]
    );
    assert.equal(core.version, versionAfterFirst);
    assert.equal(core.version, 0);
});

// =====================================================================
// B3 — URUTAN KANONIK & KONVERGENSI
// =====================================================================

function feed(core, list) {
    for (const obs of list) core.ingest(obs);
}

function registeredCore(clock = () => 0, capabilities = ["active_window_metadata", "document_context", "workspace_context"]) {
    const core = new DesktopContextCore({ clock });
    core.registerAdapter({ adapterId: "fake-desktop", trusted: true, capabilities });
    return core;
}

function convergencePair(listA, listB, limits = {}) {
    const clock = () => 5000;
    const a = new DesktopContextCore({ clock, ...limits });
    const b = new DesktopContextCore({ clock, ...limits });
    for (const c of [a, b]) {
        c.registerAdapter({
            adapterId: "fake-desktop",
            trusted: true,
            capabilities: ["active_window_metadata", "document_context", "workspace_context"]
        });
    }
    feed(a, listA);
    feed(b, listB);
    return [ContextSnapshot.serialize(a.snapshot()), ContextSnapshot.serialize(b.snapshot())];
}

test("B3: jendela baru/lama konvergen terlepas dari urutan kedatangan", () => {
    const old_ = rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED, observationId: "o-old", timestamp: 1000,
        subject: "wa", entities: [E("wa", ENTITY_TYPE.WINDOW, "lama"), E("aa", ENTITY_TYPE.APPLICATION, "app")],
        relationships: [{ from: "wa", relation: "active_in", to: "aa" }]
    });
    const new_ = rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED, observationId: "o-new", timestamp: 2000,
        subject: "wb", entities: [E("wb", ENTITY_TYPE.WINDOW, "baru"), E("ab", ENTITY_TYPE.APPLICATION, "app-b")],
        relationships: [{ from: "wb", relation: "active_in", to: "ab" }]
    });

    const [first, second] = convergencePair([new_, old_], [old_, new_]);
    assert.equal(first, second);

    // Dan pemenangnya adalah yang lebih baru.
    const core = registeredCore();
    feed(core, [old_, new_]);
    assert.equal(core.getActiveWindow()?.id, "wb");
});

test("B3: observasi basa yang datang terlambat TIDAK menimpa state baru", () => {
    const core = new DesktopContextCore({ clock: () => 0 });
    core.registerAdapter({
        adapterId: "fake-desktop",
        trusted: true,
        capabilities: ["active_window_metadata", "document_context"]
    });

    feed(core, [rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED, observationId: "o-win", timestamp: 2500,
        subject: "w1", entities: [E("w1", ENTITY_TYPE.WINDOW, "jendela")]
    })]);
    feed(core, [rawObservation({
        type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED, observationId: "o-new", timestamp: 3000,
        subject: "doc-baru",
        entities: [E("doc-baru", ENTITY_TYPE.DOCUMENT, "baru")],
        relationships: [{ from: "doc-baru", relation: "displayed_in", to: "w1" }]
    })]);
    feed(core, [rawObservation({
        type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED, observationId: "o-old", timestamp: 1000,
        subject: "doc-lama",
        entities: [E("doc-lama", ENTITY_TYPE.DOCUMENT, "lama")],
        relationships: [{ from: "doc-lama", relation: "displayed_in", to: "w1" }]
    })]);

    assert.equal(core.getActiveDocument()?.label, "baru");
    const e = core.getView().entities.get("doc-lama");
    assert.equal(e.invalid, true);                       // basa lazim
    assert.equal(e.staleReason, "SUPERSEDED_DOCUMENT");  // alasan tepat
});

test("B3: timestamp sama + confidence sama → tie-break observationId deterministik", () => {
    const o1 = rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: "aaa", timestamp: 1000,
        subject: "ws-a", entities: [E("ws-a", ENTITY_TYPE.WORKSPACE, "label-A")]
    });
    const o2 = rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: "bbb", timestamp: 1000,
        subject: "ws-a", entities: [E("ws-a", ENTITY_TYPE.WORKSPACE, "label-B")]
    });

    // Pemenang harus 'bbb' (lexicographically larger) dalam kedua urutan.
    const [sa, sb] = convergencePair([o1, o2], [o2, o1]);
    assert.equal(sa, sb);
    const core = registeredCore();
    feed(core, [o1, o2]);
    assert.equal(core.getCurrentWorkspace()?.label, "label-B");
});

test("B3: revisi = hitungan observasi → konvergen walau payload bertentangan", () => {
    const mk = (oid, ts, label) => rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: oid, timestamp: ts,
        subject: "ws-x",
        entities: [E("ws-x", ENTITY_TYPE.WORKSPACE, label)]
    });
    const list = [mk("a1", 1000, "satu"), mk("b2", 2000, "dua"), mk("c3", 3000, "tiga")];
    const reversed = [...list].reverse();

    const [sa, sb] = convergencePair(list, reversed);
    const pa = JSON.parse(sa), pb = JSON.parse(sb);
    const ea = pa.entities.find((e) => e.id === "ws-x");
    const eb = pb.entities.find((e) => e.id === "ws-x");
    assert.equal(ea.revision, eb.revision);
    assert.equal(ea.revision, 3);          // tiga observasi diterima
    assert.equal(ea.label, eb.label);      // pemenang sama (terbaru)
    assert.equal(sa, sb);                  // snapshot byte-identik
});

// =====================================================================
// B4 — IDENTITAS OBSERVASI TAHAN RESTART
// =====================================================================

test("B4: restart adapter (seq reset) menghasilkan ID baru yang diterima", () => {
    const sent = [];
    const clock = () => 1000;

    const mkAdapter = (nonce) => new FakeDesktopAdapter({
        emit: (o) => sent.push(o),
        clock,
        instanceNonce: nonce
    });

    const a1 = mkAdapter("inst-1");
    a1.start();
    a1.changeWorkspace({ workspaceId: "ws-1", label: "satu" });
    a1.stop();

    const a2 = mkAdapter("inst-2");   // instance baru, nonce berbeda
    a2.start();
    a2.changeWorkspace({ workspaceId: "ws-1", label: "satu" });
    a2.stop();

    assert.notEqual(sent[0].observationId, sent[1].observationId);
    assert.match(sent[0].observationId, /^fake-desktop:inst-1:/);
    assert.match(sent[1].observationId, /^fake-desktop:inst-2:/);

    // Core menerima keduanya (keduanya unik).
    const core = new DesktopContextCore({ clock });
    core.registerAdapter({
        adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"]
    });
    for (const o of sent) {
        const r = core.ingest(o);
        assert.equal(r.accepted, true, r.detail);
    }
});

test("B4: ID sama + payload sama → DUPLICATE; ID sama + payload beda → CONFLICTING", () => {
    const core = new DesktopContextCore({ clock: () => 0 });
    core.registerAdapter({
        adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"]
    });

    const o1 = rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: "dup-1",
        subject: "ws-a", entities: [E("ws-a", ENTITY_TYPE.WORKSPACE, "A")]
    });
    assert.equal(core.ingest(o1).accepted, true);

    // Duplikat persis.
    const dup = core.ingest(structuredClone(o1));
    assert.equal(dup.accepted, false);
    assert.equal(dup.reasonCode, "DUPLICATE_OBSERVATION");

    // ID sama, payload beda → KONFLIK, bukan duplikat biasa.
    const conflicting = rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: "dup-1",
        subject: "ws-a", entities: [E("ws-a", ENTITY_TYPE.WORKSPACE, "A-PALSU")]
    });
    const conf = core.ingest(conflicting);
    assert.equal(conf.accepted, false);
    assert.equal(conf.reasonCode, "CONFLICTING_OBSERVATION");
    assert.ok(core.getDiagnostics().some((d) => d.reasonCode === "CONFLICTING_OBSERVATION"));
});

// =====================================================================
// B5 — PROVENANCE DARI REGISTRASI TERPERCAYA
// =====================================================================

test("B5: plugin jahat yang mengklaim provenance windows tetap evil-plugin", () => {
    const core = new DesktopContextCore({ clock: () => 0 });
    core.registerAdapter({
        adapterId: "evil-plugin", trusted: true, capabilities: ["workspace_context"]
    });

    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED,
        observationId: "evil-1",
        subject: "ws-e",
        entities: [{
            id: "ws-e", type: ENTITY_TYPE.WORKSPACE, label: "curian",
            provenance: "adapter:windows-active-window"   // KLAIM PALSU
        }],
        adapterId: "evil-plugin"
    }));

    assert.equal(r.accepted, true);
    const e = core.getCurrentWorkspace();
    // Fakta kanonik = registrasi; klaim disimpan terpisah sebagai metadata.
    assert.equal(e.provenance, "adapter:evil-plugin");
    assert.equal(e.claimedProvenance, "adapter:windows-active-window");
});

test("B5: adapter hanya boleh mengirim event sesuai kapabilitas terdaftar", () => {
    const core = new DesktopContextCore({ clock: () => 0 });
    core.registerAdapter({
        adapterId: "windows-active-window",
        trusted: true,
        capabilities: ["active_window_metadata"]   // tanpa text_selection_metadata
    });

    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.SELECTION_CHANGED,
        observationId: "out-of-scope",
        subject: "sel-x",
        entities: [E("sel-x", ENTITY_TYPE.TEXT_SELECTION, "seleksi curian")],
        adapterId: "windows-active-window"
    }));
    assert.equal(r.accepted, false);
    assert.equal(r.reasonCode, "REJECTED_CAPABILITY");
    assert.equal(core.version, 0);
});

test("B5: provenance adapter windows yang sah tetap benar", () => {
    const core = new DesktopContextCore({ clock: () => 0 });
    core.registerAdapter({
        adapterId: "windows-active-window",
        trusted: true,
        capabilities: ["active_window_metadata"]
    });

    core.ingest(rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED,
        observationId: "win-1",
        subject: "w1",
        entities: [
            E("w1", ENTITY_TYPE.WINDOW, "catatan.txt - Notepad"),
            E("app-1", ENTITY_TYPE.APPLICATION, "pid:123")
        ],
        relationships: [{ from: "w1", relation: "active_in", to: "app-1" }],
        adapterId: "windows-active-window"
    }));

    assert.equal(core.getActiveWindow()?.provenance, "adapter:windows-active-window");
});

// =====================================================================
// B6 — INVALIDASI TIDAK MELINTAS BATAS KONTEKS
// =====================================================================

test("B6: terminal tak berlingkup tidak menginvalidasi dokumen jendela", () => {
    const { core, adapter } = makeHarness();
    adapter.activateWindow({
        windowId: "w1", appId: "a1", documentId: "doc-utama", documentPath: "/utama.txt"
    });
    // Terminal hanya terikat workspace, BUKAN jendela.
    adapter.addTerminal({ terminalId: "term-1", cwd: "/x", workspaceId: "ws-1" });

    assert.equal(core.getActiveDocument()?.id, "doc-utama");
    const doc = core.getView().entities.get("doc-utama");
    assert.equal(doc.invalid, false);
});

test("B6: dokumen berlingkup w2 tidak menginvalidasi anak w1", () => {
    const { core, adapter } = makeHarness();
    adapter.activateWindow({
        windowId: "w1", appId: "a1", documentId: "doc-w1", documentPath: "/1.txt"
    });
    adapter.activateWindow({ windowId: "w2", appId: "a2" });
    adapter.openDocument({ documentId: "doc-w2", path: "/2.txt", windowId: "w2" });

    const view = core.getView();
    const docW1 = view.entities.get("doc-w1");
    if (view.active.windowId === "w2") {
        // Jendela aktif kini w2; doc-w1 tetap HIDUP sebagai milik w1.
        assert.equal(docW1.invalid, false);
    } else {
        assert.fail("jendela aktif seharusnya w2");
    }
    // Penggantian se-jendela w2 bekerja normal.
    assert.equal(view.entities.get("doc-w2").invalid, false);
    assert.equal(core.getActiveDocument()?.id, "doc-w2");
});

test("B6: penggantian dokumen SE-JENDELA tetap mensupersediakan yang lama", () => {
    const { core, adapter } = makeHarness();
    adapter.activateWindow({ windowId: "w1", appId: "a1", documentId: "doc-a" });
    adapter.openDocument({ documentId: "doc-b", path: "/b.txt", windowId: "w1" });

    const view = core.getView();
    assert.equal(view.entities.get("doc-a").staleReason, "SUPERSEDED_DOCUMENT");
    assert.equal(core.getActiveDocument()?.id, "doc-b");
});

// =====================================================================
// B7 — VIEW TIDAK MEMBUKA STATE HIDUP
// =====================================================================

test("B7: getView() terdetach — set/delete/mutasi-nested tidak menyentuh core", () => {
    const { core, adapter } = makeHarness();
    adapter.changeWorkspace({ workspaceId: "ws-1", label: "asli" });

    const statsBefore = core.getStats();
    const versionBefore = core.version;

    const view = core.getView();

    // 1. set entitas palsu ke Map view
    view.entities.set("fake", { id: "fake", type: ENTITY_TYPE.WINDOW, label: "palsu" });
    // 2. delete entitas asli dari Map view
    view.entities.delete("ws-1");
    // 3. mutasi nested pada entitas hasil view
    const wsCopy = [...view.entities.values()][0];
    try {
        wsCopy.attributes.projectRoot = "DISENTUH";
        wsCopy.attributes.leak = true;
    } catch { /* frozen → boleh throw di strict mode */ }

    // Core tak tersentuh: versi sama, statistik sama, state segar bersih.
    assert.equal(core.version, versionBefore);
    assert.equal(core.getStats().entities, statsBefore.entities);
    const fresh = core.getView();
    assert.equal(fresh.entities.has("fake"), false);
    assert.equal(fresh.entities.has("ws-1"), true);
    assert.equal(fresh.entities.get("ws-1").attributes.leak, undefined);
    // Nilai asli utuh di core:
    assert.equal(core.getCurrentWorkspace()?.label, "asli");
});

test("B7: nilai nested view dibekukan", () => {
    const { core, adapter } = makeHarness();
    adapter.changeWorkspace({ workspaceId: "ws-1", label: "x", projectRoot: "/root" });
    const view = core.getView();
    const ws = view.entities.get("ws-1");
    assert.equal(Object.isFrozen(ws), true);
    assert.equal(Object.isFrozen(ws.attributes), true);
});

// =====================================================================
// B8 — SEMUA SUMBER DAYA BENAR-BENAR BERBATAS
// =====================================================================

function stormHarness() {
    const clock = () => 1000;
    const core = new DesktopContextCore({
        clock,
        maxHistory: 10,
        maxLiveEntities: 20,
        maxStaleRetained: 10,
        maxRelationships: 30,
        maxDedupeIds: 50,
        maxAttributeBytes: 512
    });
    const adapter = new FakeDesktopAdapter({ emit: (o) => core.ingest(o), clock, instanceNonce: "storm" });
    core.registerAdapter({
        adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"]
    });
    adapter.start();
    return { core, adapter };
}

test("B8: badai ribuan observasi tetap dalam batas terkonfigurasi", () => {
    const { core, adapter } = stormHarness();

    for (let i = 0; i < 600; i++) {
        const r = adapter.changeWorkspace({ workspaceId: `ws-${i}`, label: `ws${i}` });
        assert.equal(r.accepted, true, `observasi ${i} ditolak: ${r.detail}`);
    }

    const stats = core.getStats();
    assert.ok(stats.entities <= 30, `entities bocor: ${stats.entities}`);
    assert.ok(stats.relationships <= 30, `relationships bocor: ${stats.relationships}`);
    assert.ok(stats.dedupeIds <= 50, `dedupeIds bocor: ${stats.dedupeIds}`);
    assert.ok(stats.history <= 10, `history bocor: ${stats.history}`);

    // Snapshot tetap di bawah batas default dan relasi tidak menggantung.
    const json = ContextSnapshot.serialize(core.snapshot());
    assert.ok(Buffer.byteLength(json) < 65536);
    for (const rel of core.getView().relationships) {
        assert.ok(
            core.getView().entities.has(rel.from) && core.getView().entities.has(rel.to),
            `relasi menggantung: ${rel.from}->${rel.to}`
        );
    }
});

test("B8: dedupe LRU mengeviksi ID lama secara deterministik", () => {
    const clock = () => 1000;
    const core = new DesktopContextCore({ clock, maxDedupeIds: 10 });
    core.registerAdapter({
        adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"]
    });

    const send = (i) => core.ingest(rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: `obs-${String(i).padStart(3, "0")}`,
        timestamp: 1000 + i, subject: `ws-${i}`,
        entities: [E(`ws-${i}`, ENTITY_TYPE.WORKSPACE, String(i))]
    }));

    for (let i = 0; i < 14; i++) assert.equal(send(i).accepted, true);
    assert.equal(core.getStats().dedupeIds, 10);

    // obs-000..003 sudah tereviksi → dikirim ulang diterima lagi (bukan duplikat).
    const replayOld = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: "obs-000",
        timestamp: 1000, subject: "ws-0",
        entities: [E("ws-0", ENTITY_TYPE.WORKSPACE, "0")]
    }));
    assert.equal(replayOld.accepted, true);

    // Yang masih hidup di LRU (terbaru) tetap terdedupe.
    const replayNew = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED, observationId: "obs-013",
        timestamp: 1013, subject: "ws-13",
        entities: [E("ws-13", ENTITY_TYPE.WORKSPACE, "13")]
    }));
    assert.equal(replayNew.accepted, false);
    assert.equal(replayNew.reasonCode, "DUPLICATE_OBSERVATION");
});

test("B8: atribut oversize ditolak sesuai kebijakan (fail closed)", () => {
    const { core, adapter } = stormHarness();
    const bigText = "x".repeat(600);

    const before = core.getStats();
    const r = core.ingest({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED,
        observationId: `${Date.now()}-oversize`,
        timestamp: 1000,
        source: { adapterId: "fake-desktop" },
        subject: "ws-big",
        entities: [{
            id: "ws-big", type: ENTITY_TYPE.WORKSPACE, label: "besar",
            attributes: { blob: bigText }
        }],
        relationships: [],
        payload: {}
    });

    assert.equal(r.accepted, false);
    assert.equal(r.reasonCode, "ATTRIBUTES_TOO_LARGE");
    assert.equal(core.getStats().entities, before.entities);
});

// =====================================================================
// B9 — SUBJECT/RELASI MENGGANTUNG GAGAL
// =====================================================================

test("B9: aktivasi jendela yang tak ada → UNRESOLVED_SUBJECT, nol efek", () => {
    const { core } = makeHarness();
    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WINDOW_ACTIVATED,
        observationId: "ghost-win",
        subject: "w-tidak-ada",
        entities: []
    }));
    assert.equal(r.accepted, false);
    assert.equal(r.reasonCode, "UNRESOLVED_SUBJECT");
    assert.equal(core.version, 0);
    assert.equal(core.getTransitionHistory().length, 0);
    assert.equal(core.getActiveWindow(), null);
});

test("B9: relasi hantu → DANGLING_RELATIONSHIP, riwayat tidak berbohong", () => {
    const { core } = makeHarness();
    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED,
        observationId: "ghost-rel",
        subject: "doc-1",
        entities: [E("doc-1", ENTITY_TYPE.DOCUMENT, "d")],
        relationships: [{ from: "doc-1", relation: "displayed_in", to: "w-hantu" }]
    }));
    assert.equal(r.accepted, false);
    assert.equal(r.reasonCode, "DANGLING_RELATIONSHIP");
    assert.equal(core.getTransitionHistory().length, 0);
    assert.equal(core.version, 0);
});

test("B9: tipe subject salah untuk semantik event → INVALID_ACTIVE_TARGET", () => {
    const { core } = makeHarness();
    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.APPLICATION_ACTIVATED,
        observationId: "wrong-type",
        subject: "bukan-app",
        entities: [E("bukan-app", ENTITY_TYPE.WINDOW, "jendela")]
    }));
    assert.equal(r.accepted, false);
    assert.equal(r.reasonCode, "INVALID_ACTIVE_TARGET");
    assert.equal(core.getActiveApplication(), null);
});

// =====================================================================
// B10 — LIFECYCLE PROSES ADAPTER WINDOWS
// =====================================================================

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killed = false;
    }
    kill() {
        this.killed = true;
        process.nextTick(() => this.emit("close"));
        return true;
    }
}

function timerHarness() {
    const scheduled = [];
    let now = 0;
    const setTimeoutImpl = (fn, ms) => {
        const handle = { fn, ms, id: ++now };
        scheduled.push(handle);
        return handle;
    };
    const cleared = [];
    const clearTimeoutImpl = (handle) => {
        cleared.push(handle?.id ?? null);
        const i = scheduled.indexOf(handle);
        if (i >= 0) scheduled.splice(i, 1);
    };
    const fireNext = () => {
        const handle = scheduled.shift();
        if (!handle) throw new Error("tidak ada timer terjadwal");
        handle.fn();
    };
    return { scheduled, cleared, setTimeoutImpl, clearTimeoutImpl, fireNext };
}

function winAdapter({ spawnLog, childBehavior }) {
    const timers = timerHarness();
    const children = [];
    const spawnImpl = () => {
        const child = new FakeChild();
        children.push(child);
        spawnLog.push(child);
        childBehavior?.(child);
        return child;
    };
    const emitted = [];
    const adapter = new WindowsActiveWindowAdapter({
        emit: (o) => emitted.push(o),
        clock: () => 42,
        pollMs: 1,                     // sengaja di bawah minimum
        instanceNonce: "nonce-x",
        deps: {
            platform: "win32",
            spawnImpl,
            setTimeoutImpl: timers.setTimeoutImpl,
            clearTimeoutImpl: timers.clearTimeoutImpl
        }
    });
    return { adapter, emitted, children, ...timers };
}

const VALID_PS_OUTPUT = JSON.stringify({ title: "catatan.txt - Notepad", processId: 4242 });

test("B10: satu poll in-flight — poll kedua tidak men-spawn ganda", () => {
    const spawnLog = [];
    const { adapter, emitted, children } = winAdapter({
        spawnLog,
        childBehavior: () => { /* child menggantung */ }
    });

    adapter.start();
    assert.ok(adapter.effectivePollMs >= POLL_MS_MINIMUM,
        `interval efektif ${adapter.effectivePollMs} harus >= ${POLL_MS_MINIMUM}`);

    // Poll pertama berjalan dan menggantung di child.
    adapter._poll();
    assert.equal(spawnLog.length, 1);
    assert.equal(adapter.inFlight, true);

    // Poll tumpuk ditolak selama in-flight.
    adapter._poll();
    adapter._poll();
    assert.equal(spawnLog.length, 1);

    // Selesaikan child → loop menjadwalkan siklus berikutnya.
    children[0].stdout.emit("data", VALID_PS_OUTPUT);
    children[0].emit("close");
    assert.equal(adapter.inFlight, false);
    assert.equal(emitted.length, 1);
    assert.match(emitted[0].observationId, /^windows-active-window:nonce-x:0001$/);
});

test("B10: stop() membunuh child hidup dan meninggalkan nol timer/nol child", () => {
    // --- Fase 1: child menggantung saat stop → dibunuh, tak ada timer ---
    const spawnLog = [];
    const { adapter, children, scheduled } = winAdapter({ spawnLog });

    adapter.start();
    const t = scheduled.shift();
    t.fn();                                   // poll berjalan, child menggantung

    assert.equal(children.length, 1);
    assert.ok(adapter.liveChild);

    adapter.stop();
    assert.equal(children[0].killed, true);
    assert.equal(adapter.liveChild, null);
    assert.equal(adapter.liveTimer, null);
    assert.equal(scheduled.length, 0);

    // Child lambat menutup setelah stop → TIDAK ada reschedule/spawn baru.
    children[0].stdout.emit("data", VALID_PS_OUTPUT);
    children[0].emit("close");
    assert.equal(scheduled.length, 0);
    assert.equal(spawnLog.length, 1);

    // --- Fase 2: siklus selesai → timer dijadwalkan ulang → stop membersihkan ---
    const spawnLog2 = [];
    const { adapter: a2, children: c2, cleared: cleared2, scheduled: sched2 } =
        winAdapter({ spawnLog: spawnLog2 });

    a2.start();
    const t2a = sched2.shift();
    t2a.fn();
    c2[0].stdout.emit("data", VALID_PS_OUTPUT);
    c2[0].emit("close");                      // selesai → loop menjadwalkan lagi
    assert.equal(sched2.length, 1);           // timer siklus berikutnya hidup

    a2.stop();
    assert.equal(cleared2.length, 1);         // timer dibatalkan
    assert.equal(sched2.length, 0);
    assert.equal(a2.liveTimer, null);
});

test("B10: stderr dikonsumsi dan tidak menyumbat fixture", () => {
    const spawnLog = [];
    const { adapter, children } = winAdapter({ spawnLog });
    adapter.start();
    adapter._poll();

    assert.doesNotThrow(() => {
        children[0].stderr.emit("data", Buffer.from("beban stderr"));
        children[0].stderr.emit("data", Buffer.from("lagi"));
        children[0].emit("close");
    });
});

test("B10: keluaran PowerShell divalidasi — cacat menjadi diagnostik, bukan observasi", () => {
    const spawnLog = [];
    const { adapter, emitted, children } = winAdapter({ spawnLog });
    adapter.start();

    const cycle = (output) => {
        adapter._poll();
        const child = children[children.length - 1];
        child.stdout.emit("data", output);
        child.emit("close");
    };

    cycle("bukan json{{{");
    cycle(JSON.stringify({ title: 123, processId: "bukan-angka" }));
    cycle(JSON.stringify({ title: "ok" }));                    // processId hilang
    assert.equal(emitted.length, 0);
    const codes = adapter.getDiagnostics().map((d) => d.reasonCode);
    assert.ok(codes.includes("ADAPTER_OUTPUT_UNPARSEABLE"));
    assert.ok(codes.includes("ADAPTER_OUTPUT_INVALID"));

    cycle(VALID_PS_OUTPUT);
    assert.equal(emitted.length, 1);

    // Signature sama → tidak dobel emit (idempoten alami).
    cycle(VALID_PS_OUTPUT);
    assert.equal(emitted.length, 1);
});

test("B10: script PowerShell konstan, tanpa shell=true, tanpa interpolasi pemanggil", () => {
    assert.equal(typeof POWERSHELL_SCRIPT, "string");
    assert.ok(!POWERSHELL_SCRIPT.includes("${"));
    assert.ok(Object.isFrozen(SPAWN_ARGS));
    assert.deepEqual(SPAWN_ARGS.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(SPAWN_ARGS[3], POWERSHELL_SCRIPT);
});

test("B10: restart start/stop/start bekerja; platform non-Windows tetap graceful", () => {
    const { adapter } = winAdapter({});
    adapter.start();
    adapter.stop();
    adapter.start();          // restart sah
    adapter.stop();

    const linuxAdapter = new WindowsActiveWindowAdapter({
        emit: () => {},
        deps: { platform: "linux" }
    });
    assert.throws(() => linuxAdapter.start(), (err) => err.code === "UNSUPPORTED_PLATFORM");
    assert.equal(linuxAdapter.isRunning, false);
});

// =====================================================================
// B11 — ANTI-SURVEILLANCE MEKNIS (bukan sekadar cek setInterval)
// =====================================================================

test("B11: tidak ada adapter desktop yang memuat API tangkapan layar", () => {
    const adaptersDir = path.join(__dirname, "..", "..", "src", "desktop", "adapters");
    const files = fs.readdirSync(adaptersDir).filter((f) => f.endsWith(".js"));

    const captureApiRegex =
        /\b(bitblt|stretchblt|printwindow|capturescreen|screencapture|grabdesktop)\b/i;

    for (const file of files) {
        const src = fs.readFileSync(path.join(adaptersDir, file), "utf8");
        assert.ok(!captureApiRegex.test(src), `${file} memuat API capture layar`);
    }
});

test("B11: polling metadata Windows mematuhi interval minimum & single-flight", () => {
    // Interval minimum ditegakkan meski pemanggil minta 1 ms.
    const spawnLog = [];
    const { adapter, scheduled } = winAdapter({ spawnLog });
    adapter.start();

    // start() menajadwalkan tepat satu timer dengan delay efektif >= minimum.
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, adapter.effectivePollMs);
    assert.ok(scheduled[0].ms >= POLL_MS_MINIMUM);
    // Metadata polling saja — bukan kelas capture visual.
    assert.deepEqual([...adapter.capabilities], ["active_window_metadata"]);

    // Kontrak perilaku (dibuktikan penuh di tes B10):
    assert.equal(typeof adapter.inFlight, "boolean");
});

// =====================================================================
// REPAIR ROUND 2 — SNAPSHOT TRIM ORDER + BOUNDED scopedWinners
// =====================================================================

test("R2-1: snapshot melebihi batas terpangkas melalui riwayat (trim sukses)", () => {
    const clock = () => 1000;
    const core = new DesktopContextCore({ clock, maxSnapshotBytes: 4096, maxHistory: 30 });
    core.registerAdapter({
        adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"]
    });

    // observationId panjang → entri transisi besar; entitas tetap kecil
    // (12 entitas ≈ 3KB < 4096) sehingga trimming riwayat pasti cukup.
    for (let i = 0; i < 12; i++) {
        const r = core.ingest(rawObservation({
            type: DESKTOP_EVENT.WORKSPACE_CHANGED,
            observationId: `obs-${String(i).padStart(3, "0")}-${"x".repeat(400)}`,
            timestamp: 1000 + i,
            subject: `ws-${i}`,
            entities: [E(`ws-${i}`, ENTITY_TYPE.WORKSPACE, String(i))]
        }));
        assert.equal(r.accepted, true);
    }

    // Tanpa trim jelas >4096; setelah trim riwayat harus muat.
    const snap = core.snapshot();
    const json = ContextSnapshot.serialize(snap);
    assert.ok(Buffer.byteLength(json, "utf8") <= 4096,
        `snapshot ${Buffer.byteLength(json)} byte harus <= 4096`);
    // Hasil pangkas tetap snapshot sah yang bisa dibangun ulang.
    const rebuilt = ContextSnapshot.deserialize(json);
    assert.equal(rebuilt.desktopContextId, snap.desktopContextId);
});

test("R2-2: batas DEFAULT — konten entitas dominan gagal SNAPSHOT_TOO_LARGE eksplisit", () => {
    const clock = () => 1000;
    const core = new DesktopContextCore({ clock });   // SEMUA limit default
    core.registerAdapter({
        adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"]
    });

    // 60 workspace dengan atribut ~1.4KB (di bawah cap atribut 2048B):
    // total >> 64KB default bahkan tanpa satu pun transisi yang membantu.
    for (let i = 0; i < 60; i++) {
        const r = core.ingest({
            type: DESKTOP_EVENT.WORKSPACE_CHANGED,
            observationId: `big-${String(i).padStart(3, "0")}`,
            timestamp: 1000 + i,
            source: { adapterId: "fake-desktop" },
            subject: `ws-big-${i}`,
            entities: [{
                id: `ws-big-${i}`, type: ENTITY_TYPE.WORKSPACE, label: `ws${i}`,
                attributes: { blob: "z".repeat(1400) }
            }],
            relationships: [],
            payload: {}
        });
        assert.equal(r.accepted, true);
    }

    let thrown = null;
    try {
        core.snapshot();
    } catch (err) {
        thrown = err;
    }

    // Gagal deterministik dengan alasan terdokumentasi — bukan TypeError mentah.
    assert.ok(thrown, "snapshot() wajib gagal tertutup untuk konten ini");
    assert.equal(thrown.code, "SNAPSHOT_TOO_LARGE");
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /65536/);
});

test("R2-3: badai lingkup — 600 window+document vs entityCap=30 & maxScopedWinners", () => {
    const limits = {
        maxLiveEntities: 20,
        maxStaleRetained: 10,          // entityCap = 30
        maxScopedWinners: 8,
        maxRelationships: 40,
        maxHistory: 20
    };
    const clock = () => 1000;
    const core = new DesktopContextCore({ clock, ...limits });
    core.registerAdapter({
        adapterId: "fake-desktop",
        trusted: true,
        capabilities: ["active_window_metadata", "document_context"]
    });

    let acceptedCount = 0;
    for (let i = 0; i < 600; i++) {
        const r = core.ingest({
            type: DESKTOP_EVENT.WINDOW_ACTIVATED,
            observationId: `storm-${String(i).padStart(4, "0")}`,
            timestamp: 1000 + i,
            source: { adapterId: "fake-desktop" },
            subject: `w-${i}`,
            entities: [
                { id: `w-${i}`, type: ENTITY_TYPE.WINDOW, label: `jendela ${i}`, confidence: 1 },
                { id: `d-${i}`, type: ENTITY_TYPE.DOCUMENT, label: `doc ${i}`, confidence: 1 }
            ],
            relationships: [{ from: `d-${i}`, relation: "displayed_in", to: `w-${i}` }],
            payload: {}
        });
        if (r.accepted) acceptedCount += 1;
    }

    assert.equal(acceptedCount, 600);   // tidak ada observasi ditolak

    const stats = core.getStats();
    assert.ok(stats.entities <= 30, `entities bocor: ${stats.entities}`);
    assert.ok(stats.scopedWinners <= 8,
        `scopedWinners bocor: ${stats.scopedWinners} > 8`);

    // Relasi tidak menggantung: seluruh endpoint ada di entitas retained.
    const view = core.getView();
    for (const rel of view.relationships) {
        assert.ok(view.entities.has(rel.from) && view.entities.has(rel.to),
            `relasi menggantung: ${rel.from}->${rel.to}`);
    }

    // Pointer aktif sah dan menunjuk observasi TERBARU (lingkupnya
    // selamat karena eviksi lingkup memilih kunci aktivasi terlama).
    assert.equal(view.active.windowId, "w-599");
    assert.equal(view.active.documentId, "d-599");
    assert.equal(core.getActiveWindow()?.id, "w-599");
    assert.equal(core.getActiveDocument()?.id, "d-599");

    // Snapshot berhasil atau gagal hanya dengan alasan terdokumentasi.
    try {
        const snap = core.snapshot();
        assert.ok(ContextSnapshot.serialize(snap).length > 0);
    } catch (err) {
        assert.equal(err.code, "SNAPSHOT_TOO_LARGE");
    }
});

test("R2-4: konfigurasi DEFAULT — ribuan observasi berlingkup tetap berbatas", () => {
    const clock = () => 1000;
    const core = new DesktopContextCore({ clock });   // default semua
    core.registerAdapter({
        adapterId: "fake-desktop",
        trusted: true,
        capabilities: ["active_window_metadata", "document_context"]
    });

    for (let i = 0; i < 3000; i++) {
        const r = core.ingest({
            type: DESKTOP_EVENT.WINDOW_ACTIVATED,
            observationId: `def-${String(i).padStart(5, "0")}`,
            timestamp: 1000 + i,
            source: { adapterId: "fake-desktop" },
            subject: `w-${i}`,
            entities: [
                { id: `w-${i}`, type: ENTITY_TYPE.WINDOW, label: `jendela ${i}`, confidence: 1 },
                { id: `d-${i}`, type: ENTITY_TYPE.DOCUMENT, label: `doc ${i}`, confidence: 1 }
            ],
            relationships: [{ from: `d-${i}`, relation: "displayed_in", to: `w-${i}` }],
            payload: {}
        });
        assert.equal(r.accepted, true, `observasi ${i}: ${r.detail}`);
    }

    const stats = core.getStats();
    assert.ok(stats.entities <= 600,  `entities bocor: ${stats.entities}`);
    assert.ok(stats.scopedWinners <= 256, `scopedWinners bocor: ${stats.scopedWinners}`);
    assert.ok(stats.dedupeIds <= 1024, `dedupeIds bocor: ${stats.dedupeIds}`);

    // Adapter tanpa WINDOW_CLOSED sekalipun tidak menyebabkan pertumbuhan
    // permanen — jalankan gelombang kedua, batas tetap.
    for (let i = 3000; i < 4500; i++) {
        core.ingest({
            type: DESKTOP_EVENT.WINDOW_ACTIVATED,
            observationId: `def-${String(i).padStart(5, "0")}`,
            timestamp: 1000 + i,
            source: { adapterId: "fake-desktop" },
            subject: `w-${i}`,
            entities: [
                { id: `w-${i}`, type: ENTITY_TYPE.WINDOW, label: `jendela ${i}`, confidence: 1 },
                { id: `d-${i}`, type: ENTITY_TYPE.DOCUMENT, label: `doc ${i}`, confidence: 1 }
            ],
            relationships: [{ from: `d-${i}`, relation: "displayed_in", to: `w-${i}` }],
            payload: {}
        });
    }
    const stats2 = core.getStats();
    assert.ok(stats2.entities <= 600, `entities bocor gelombang 2: ${stats2.entities}`);
    assert.ok(stats2.scopedWinners <= 256, `scopedWinners bocor gelombang 2: ${stats2.scopedWinners}`);

    // Pointer aktif valid: jendela/dokumen terbaru hidup dan ditunjuk.
    assert.equal(core.getActiveWindow()?.id, "w-4499");
    assert.equal(core.getActiveDocument()?.id, "d-4499");
});
