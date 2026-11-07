const test = require("node:test");
const assert = require("node:assert");

const {
    DesktopContextCore,
    ContextReferenceResolver,
    ENTITY_TYPE,
    DESKTOP_EVENT,
    TRANSITION
} = require("../../src/desktop");
const { makeHarness, rawObservation, E } = require("./helpers");

/**
 * SUITE RESOLVER — resolusi referensi deterministik ("ini", "yang
 * tadi") dengan confidence, provenance, reason code, ambiguitas.
 */

// ---- 17. seleksi saat ini ------------------------------------------------

test("resolve current_selection mengembalikan seleksi aktif", () => {
    const { adapter, resolve } = makeHarness();
    adapter.activateWindow({ windowId: "w1", appId: "a1" });
    adapter.selectText({ selectionId: "s1", text: "paragraf ini", length: 12, windowId: "w1" });

    const r = resolve({ kind: "current_selection" });
    assert.equal(r.status, "resolved");
    assert.equal(r.targets[0].id, "s1");
    assert.equal(r.targets[0].type, ENTITY_TYPE.TEXT_SELECTION);
    assert.equal(r.reasonCode, "RESOLVED");
});

// ---- 18. dokumen aktif ------------------------------------------------------

test("resolve active_document, active_window, dan active_application", () => {
    const { adapter, resolve } = makeHarness();
    adapter.activateWindow({
        windowId: "w1",
        appId: "app-notepad",
        documentId: "doc-1",
        documentPath: "/c/catatan.txt"
    });

    assert.equal(resolve({ kind: "active_document" }).targets[0]?.id, "doc-1");
    assert.equal(resolve({ kind: "active_application" }).targets[0]?.id, "app-notepad");
    assert.equal(resolve({ kind: "active_window" }).targets[0]?.id, "w1");
});

// ---- 19. visual aktif ---------------------------------------------------------

test("resolve active_visual mengembalikan referensi visual (bukan byte)", () => {
    const { adapter, resolve } = makeHarness();
    adapter.showVisualReference({ imageId: "img-1", sourceRef: "kucing.png", width: 64 });

    const r = resolve({ kind: "active_visual" });
    assert.equal(r.status, "resolved");
    assert.equal(r.targets[0].attributes.captureRequired, true);
});

// ---- 20. file terpilih -------------------------------------------------------------

test("resolve selected_files mengembalikan seluruh anggota grup", () => {
    const { adapter, resolve } = makeHarness();
    adapter.selectFiles({
        groupId: "g1",
        files: [
            { id: "f1", label: "a", path: "/a" },
            { id: "f2", label: "b", path: "/b" }
        ]
    });

    const r = resolve({ kind: "selected_files" });
    assert.equal(r.status, "resolved");
    assert.equal(r.targets.length, 2);
    // Confidence resolusi = minimum rantai (grup + anggota).
    assert.equal(r.confidence, 1);
});

// ---- 21. konteks terbaru ("yang tadi") ------------------------------------------------

test("resolve recent_context menelusuri riwayat dari yang terbaru", () => {
    const { adapter, resolve } = makeHarness();
    adapter.activateWindow({ windowId: "w1", appId: "a1" });
    adapter.selectText({ selectionId: "s1", text: "satu", length: 4, windowId: "w1" });
    adapter.selectText({ selectionId: "s2", text: "dua", length: 3, windowId: "w1" }); // s1 basi
    adapter.selectFiles({ groupId: "g1", files: [{ id: "f1", label: "a", path: "/a" }] });

    // "seleksi yang tadi" → transisi selection_changed terbaru yang masih hidup.
    const r = resolve({
        kind: "recent_context",
        constraints: { transitionTypes: [TRANSITION.SELECTION_CHANGED] }
    });
    assert.equal(r.status, "resolved");
    assert.equal(r.targets[0].id, "s2");

    // "dokumen yang tadi"
    adapter.openDocument({ documentId: "doc-x", path: "/x", windowId: "w1" });
    const rd = resolve({
        kind: "recent_context",
        constraints: { transitionTypes: [TRANSITION.DOCUMENT_OPENED] }
    });
    assert.equal(rd.targets[0]?.id, "doc-x");
});

// ---- 22. ambiguitas ---------------------------------------------------------------------

test("dua seleksi hidup di jendela berbeda → AMBIGUOUS; constraint jendela memutus", () => {
    const { core, adapter } = makeHarness();

    adapter.activateWindow({ windowId: "wa", appId: "a1" });
    adapter.selectText({ selectionId: "sa", text: "A", length: 1, windowId: "wa" });
    adapter.activateWindow({ windowId: "wb", appId: "a2" });
    adapter.selectText({ selectionId: "sb", text: "B", length: 1, windowId: "wb" });

    const r = ContextReferenceResolver.resolve(core.getView(), { kind: "current_selection" });
    assert.equal(r.status, "ambiguous");
    assert.equal(r.reasonCode, "AMBIGUOUS_TARGETS");
    // Tepat DUA kandidat valid (sa & sb) — bukan satu kandidat tersamar.
    assert.deepEqual([...r.candidates.map((c) => c.id)].sort(), ["sa", "sb"]);
    assert.equal(r.targets.length, 0);

    // Constraint jendela membuat keputusan deterministik lagi.
    const scoped = ContextReferenceResolver.resolve(core.getView(),
        { kind: "current_selection", constraints: { windowId: "wa" } });
    assert.equal(scoped.status, "resolved");
    assert.equal(scoped.targets[0].id, "sa");
});

// ---- 23. ketiadaan konteks → alasan deterministik -------------------------------------------

test("konteks hilang menghasilkan reason code deterministik per jenis", () => {
    const { resolve } = makeHarness();

    const expectations = [
        [{ kind: "current_selection" }, "NO_SELECTION"],
        [{ kind: "active_document" }, "NO_ACTIVE_DOCUMENT"],
        [{ kind: "active_visual" }, "NO_VISUAL_CONTEXT"],
        [{ kind: "selected_files" }, "NO_SELECTED_FILES"],
        [{ kind: "current_workspace" }, "NO_WORKSPACE"],
        [{ kind: "recent_context" }, "HISTORY_EMPTY"],
        [{ kind: "tidak_ada" }, "UNKNOWN_RESOLUTION_KIND"]
    ];

    for (const [request, expected] of expectations) {
        const r = resolve(request);
        assert.equal(r.status, "unavailable", JSON.stringify(request));
        assert.equal(r.reasonCode, expected);
        assert.equal(r.targets.length, 0);
    }
});

// ---- 24-25. provenance & confidence tertanam --------------------------------------------------

test("provenance kanonik dari registrasi + confidence dipertahankan sampai resolusi", () => {
    const clock = () => 1000;
    const core = new DesktopContextCore({ clock });
    core.registerAdapter({ adapterId: "fake-desktop", trusted: true, capabilities: ["workspace_context"] });

    const r = core.ingest(rawObservation({
        type: DESKTOP_EVENT.WORKSPACE_CHANGED,
        observationId: "o1",
        subject: "ws-lowconf",
        entities: [{
            id: "ws-lowconf",
            type: ENTITY_TYPE.WORKSPACE,
            label: "lab",
            confidence: 0.7,
            provenance: "adapter:sumber-palsu-klaim"
        }]
    }));
    assert.equal(r.accepted, true);

    const resolved = ContextReferenceResolver.resolve(core.getView(), { kind: "current_workspace" });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.confidence, 0.7);
    // Provenance kanonik = identitas registrasi, bukan klaim payload.
    assert.equal(resolved.provenance[0], "adapter:fake-desktop");
    assert.equal(resolved.targets[0].claimedProvenance, "adapter:sumber-palsu-klaim");
});

// ---- resolusi atas snapshot (bukan live core) -----------------------------------------------

test("resolver bekerja sama pada snapshot immutable", () => {
    const { core, adapter, resolve } = makeHarness();
    adapter.selectText({ selectionId: "s1", text: "x", length: 1, windowId: "w0" });
    const snap = core.snapshot();

    const live = resolve({ kind: "current_selection" });
    const frozen = ContextReferenceResolver.resolve(snap, { kind: "current_selection" });
    assert.deepEqual(
        live.targets.map((t) => t.id),
        frozen.targets.map((t) => t.id)
    );
});
