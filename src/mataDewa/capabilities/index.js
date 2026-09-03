/**
 * Kemampuan Mata Dewa di Canonical Capability Registry Damar.
 *
 * Familia kemampuan diambil dari audit GEV_REALTIME_TOOLS (28 tools) —
 * dipetakan ke kemampuan Damar yang dimiliki Manager, BUKAN dispatcher voice
 * kedua. Tidak ada imperatif yang dihasilkan AI yang dapat melewati
 * Manager/Authority: visualisasi/query read-only tetap di-scope dengan
 * ketat, aksi lain mengikuti jahitan Action Intent → Authority kanonik.
 */

const { createCapabilityRuntime } = require("../../capability/registry");

/** Familia kemampuan (dipetakan dari gevActions upstream — lihat doc). */
const CAPABILITY_FAMILIES = Object.freeze({
    MODE_ACTIVATE: "mata_dewa.mode.activate",
    MODE_DEACTIVATE: "mata_dewa.mode.deactivate",
    VIEW_FLY_TO: "mata_dewa.view.fly_to",
    VIEW_ZOOM: "mata_dewa.view.zoom",
    VIEW_GLOBE: "mata_dewa.view.globe",
    LAYER_SET: "mata_dewa.layer.set",
    ENTITY_INSPECT: "mata_dewa.entity.inspect",
    ENTITY_TRACK: "mata_dewa.entity.track",
    ENTITY_UNTRACK: "mata_dewa.entity.untrack",
    MAP_STACK_SET: "mata_dewa.map_stack.set",
    STYLE_SET: "mata_dewa.style.set",
    SCENE_CONTROL: "mata_dewa.scene.control",
    ANNOTATION_DRAW: "mata_dewa.annotation.draw",
    ANNOTATION_CLEAR: "mata_dewa.annotation.clear",
    WATCH_CREATE: "mata_dewa.watch.create",
    WATCH_REMOVE: "mata_dewa.watch.remove",
    HAZARD_QUERY: "mata_dewa.hazard.query",
    ROUTE_INSPECT: "mata_dewa.route.inspect",
    TIMELINE_QUERY: "mata_dewa.timeline.query",
    ASSET_IMPORT: "mata_dewa.asset.import",
    CCTV_INSPECT: "mata_dewa.cctv.inspect",
    RF_OBSERVE: "mata_dewa.rf.observe"
});

/**
 * Deskriptor kemampuan (schema kanonik v1). Semua read-only/kemampuan
 * visualisasi dideklarasikan dengan operasi jujur; aksi yang mengubah state
 * dunia (impor aset, watch create/remove) mengalir lewat Action Fabric —
 * registrasi di sini DESKRIPTIF (registry tidak pernah mengotorisasi).
 */
const CAPABILITY_DESCRIPTORS = Object.freeze([
    { id: CAPABILITY_FAMILIES.MODE_ACTIVATE, operations: ["activate"], effects: ["ui_mode"], description: "Aktifkan mode UI Mata Dewa di aplikasi Damar yang sama." },
    { id: CAPABILITY_FAMILIES.MODE_DEACTIVATE, operations: ["deactivate"], effects: ["ui_mode"], description: "Kembalikan UI Damar ke mode normal." },
    { id: CAPABILITY_FAMILIES.VIEW_FLY_TO, operations: ["fly_to"], effects: [], description: "Terbangkan kamera globe ke titik/lokasi." },
    { id: CAPABILITY_FAMILIES.VIEW_ZOOM, operations: ["zoom"], effects: [], description: "Zoom kamera relatif." },
    { id: CAPABILITY_FAMILIES.VIEW_GLOBE, operations: ["globe_view"], effects: [], description: "Tampilkan seluruh bumi (globe view)." },
    { id: CAPABILITY_FAMILIES.LAYER_SET, operations: ["set"], effects: ["layer_state"], description: "Aktif/nonaktifkan lapisan data spasial." },
    { id: CAPABILITY_FAMILIES.ENTITY_INSPECT, operations: ["inspect"], effects: [], description: "Inspeksi entitas/observasi (read-only)." },
    { id: CAPABILITY_FAMILIES.ENTITY_TRACK, operations: ["track"], effects: ["camera_follow"], description: "Ikuti entitas dengan kamera." },
    { id: CAPABILITY_FAMILIES.ENTITY_UNTRACK, operations: ["untrack"], effects: ["camera_follow"], description: "Berhenti mengikuti entitas." },
    { id: CAPABILITY_FAMILIES.MAP_STACK_SET, operations: ["set"], effects: ["basemap"], description: "Ganti basemap (esri/osm keyless; photoreal bila token ada)." },
    { id: CAPABILITY_FAMILIES.STYLE_SET, operations: ["set"], effects: ["visual"], description: "Set gaya visual (normal/retro/thermal/...)." },
    { id: CAPABILITY_FAMILIES.SCENE_CONTROL, operations: ["play", "stop", "status"], effects: [], description: "Kendali pemutaran scene sinematik." },
    { id: CAPABILITY_FAMILIES.ANNOTATION_DRAW, operations: ["draw"], effects: ["annotations"], description: "Gambar anotasi di globe." },
    { id: CAPABILITY_FAMILIES.ANNOTATION_CLEAR, operations: ["clear"], effects: ["annotations"], description: "Hapus semua anotasi." },
    { id: CAPABILITY_FAMILIES.WATCH_CREATE, operations: ["create"], effects: ["watch_policy", "state"], description: "Buat watch policy pada aset (via Action Fabric)." },
    { id: CAPABILITY_FAMILIES.WATCH_REMOVE, operations: ["remove"], effects: ["watch_policy", "state"], description: "Hapus watch policy (via Action Fabric)." },
    { id: CAPABILITY_FAMILIES.HAZARD_QUERY, operations: ["query"], effects: [], description: "Query bahaya di sekitar lokasi/aset (read-only)." },
    { id: CAPABILITY_FAMILIES.ROUTE_INSPECT, operations: ["inspect"], effects: [], description: "Analisis koridor rute terhadap bahaya/aset (read-only)." },
    { id: CAPABILITY_FAMILIES.TIMELINE_QUERY, operations: ["query"], effects: [], description: "Query riwayat spasial (apa yang berubah di sini)." },
    { id: CAPABILITY_FAMILIES.ASSET_IMPORT, operations: ["import"], effects: ["asset_registry"], description: "Impor aset lokal generik (KML/KMZ/CSV/GeoJSON) via Action Fabric." },
    { id: CAPABILITY_FAMILIES.CCTV_INSPECT, operations: ["inspect"], effects: [], description: "Inspeksi frame kamera publik/berotorisasi via MediaIngress." },
    { id: CAPABILITY_FAMILIES.RF_OBSERVE, operations: ["observe"], effects: [], description: "Inspeksi status sumber RF + estimasi presence/motion terbaru (read-only; bukan klaim identitas)." }
]);

/**
 * Bangun runtime registry kecil milik Mata Dewa (provenance provider:matadewa)
 * dan daftarkan seluruh familia. Registry DESKRIPTIF — tidak pernah
 * mengotorisasi atau mengeksekusi.
 */
function buildMataDewaCapabilityRuntime({ clock = { nowMs: () => Date.now() } } = {}) {
    const runtime = createCapabilityRuntime({
        clock,
        registrars: { provider: "matadewa" }
    });

    const registered = [];
    for (const descriptor of CAPABILITY_DESCRIPTORS) {
        const result = runtime.registrars.provider.registerCanonical({
            schemaVersion: 1,
            kind: "provider",
            provider: "matadewa",
            requirements: [],
            effects: [],
            ...descriptor
        });
        registered.push(result);
    }

    return { runtime, registered };
}

module.exports = { CAPABILITY_FAMILIES, CAPABILITY_DESCRIPTORS, buildMataDewaCapabilityRuntime };
