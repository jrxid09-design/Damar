const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * Matematika gestur tangan (port Ultron handTracker).
 *
 * Menguji bagian yang mudah rusak diam-diam — histeresis pinch, pemilihan
 * mode, dan klamp zoom — tanpa webcam/MediaPipe/DOM. Modul di-import
 * dinamis karena ES module; MediaPipe di-lazy load jadi import ini aman
 * di Node.
 */

const MOD = pathToFileURL(
    path.join(__dirname, "../../apps/console/renderer/lib/gesture/handTracker.js")
).href;

test("histeresis pinch: aktif <0.32, lepas >0.45, tahan di antara", async () => {
    const { applyHysteresis, PINCH_ON, PINCH_OFF } = await import(MOD);
    assert.equal(PINCH_ON, 0.32);
    assert.equal(PINCH_OFF, 0.45);

    assert.equal(applyHysteresis(false, 0.30), true, "rasio kecil → mencubit");
    assert.equal(applyHysteresis(true, 0.40), true, "zona tengah → tetap mencubit");
    assert.equal(applyHysteresis(true, 0.50), false, "rasio besar → lepas");
    assert.equal(applyHysteresis(false, 0.40), false, "zona tengah dari lepas → tetap lepas");
});

test("mode dari jumlah tangan mencubit", async () => {
    const { computeMode } = await import(MOD);
    assert.equal(computeMode(0), "idle");
    assert.equal(computeMode(1), "spin");
    assert.equal(computeMode(2), "zoom");
    assert.equal(computeMode(3), "zoom");
});

test("klamp zoom di [0.85, 1.18]", async () => {
    const { clampZoom, ZOOM_MIN, ZOOM_MAX } = await import(MOD);
    assert.equal(clampZoom(1, 1), 1);
    assert.equal(clampZoom(2, 1), ZOOM_MAX, "renggang ekstrem → klamp atas");
    assert.equal(clampZoom(1, 2), ZOOM_MIN, "rapat ekstrem → klamp bawah");
    assert.ok(clampZoom(1.05, 1) > 1 && clampZoom(1.05, 1) < ZOOM_MAX);
});

test("dist2d = jarak euklidean", async () => {
    const { dist2d } = await import(MOD);
    assert.equal(dist2d({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test("modul aman diimpor di Node (MediaPipe lazy, tak error tanpa DOM)", async () => {
    const m = await import(MOD);
    assert.equal(typeof m.HandTracker, "function");
});
