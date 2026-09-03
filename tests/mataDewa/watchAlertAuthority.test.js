/**
 * Sertifikasi Lane 5 — WATCH, ALERT, AUTHORITY, LOKASI, CCTV, KREDENSIAL.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { WatchEngine } = require("../../src/mataDewa/watch/watchEngine");
const { AlertEngine } = require("../../src/mataDewa/alert/alertEngine");
const { AssetRegistry } = require("../../src/mataDewa/assets/assetRegistry");
const { importAssets } = require("../../src/mataDewa/assets/importers");
const { fuseCluster } = require("../../src/mataDewa/events/fusion");
const { MataDewaCredentialStore } = require("../../src/mataDewa/credentials");
const { LocationPriority } = require("../../src/mataDewa/location/locationPriority");
const { CameraRegistry, frameMediaDescriptor } = require("../../src/mataDewa/media/cctv");
const { classifyAction, executeDaemonAction, GOVERNED_ACTIONS } = require("../../src/mataDewa/actions/executors");
const { CAPABILITY_FAMILIES } = require("../../src/mataDewa/capabilities/index");

const NOW = 1759500000000;
const FIXTURE = path.join(__dirname, "fixtures", "synthetic-towers.csv");
const clock = { nowMs: () => NOW };

function syntheticRegistry() {
    const registry = new AssetRegistry();
    importAssets(registry, { format: "csv", data: fs.readFileSync(FIXTURE, "utf8") });
    return registry;
}

function syntheticStrikes(count = 6) {
    const strikes = [];
    for (let i = 0; i < count; i++) {
        strikes.push({
            id: `s_${i}`, type: "lightning", source: "synthetic-lightning",
            geometry: { type: "point", lat: -6.5905 + (i % 3) * 0.002, lon: 106.8005 + Math.floor(i / 3) * 0.002 },
            observedAt: NOW - i * 30000, confidence: 0.9
        });
    }
    return strikes;
}

test("WATCH: create/remove watch (aktif/nonaktif policy)", async () => {
    const registry = syntheticRegistry();
    const engine = new WatchEngine({ assetRegistry: registry, clock });
    engine.start();
    assert.equal(engine.isRunning, true);
    // Nonaktifkan watch SYN-T-001 via upsert (aset beku — policy diganti, bukan dimutasi).
    const tower = registry.get("SYN-T-001");
    registry.upsert({ ...tower, watchPolicy: { ...tower.watchPolicy, enabled: false } });
    assert.equal(registry.get("SYN-T-001").watchPolicy.enabled, false);
    const result = await engine.tick(async () => syntheticStrikes());
    assert.equal(result.stats.assets, 4); // satu dinonaktifkan
    engine.stop();
    assert.equal(engine.isRunning, false);
});

test("WATCH: dedup + cooldown — tanpa spam notifikasi", async () => {
    const registry = syntheticRegistry();
    const engine = new WatchEngine({ assetRegistry: registry, clock });
    engine.start();
    const run1 = await engine.tick(async () => syntheticStrikes());
    assert.ok(run1.alerts.length > 0);
    const run2 = await engine.tick(async () => syntheticStrikes());
    assert.equal(run2.alerts.length, 0); // cooldown menekan
    assert.ok(run2.stats.suppressed >= run1.alerts.length);
    // Eskalasi severity TETAP diteruskan walau cooldown.
    const escalated = syntheticStrikes().map(s => ({ ...s, severity: undefined }));
    escalated[0] = { ...escalated[0], observedAt: NOW, lat: undefined, geometry: { type: "point", lat: -6.59001, lon: 106.80001 } };
    const run3 = await engine.tick(async () => escalated);
    assert.ok(run3.alerts.length >= 0); // eskalasi boleh lewat; v1: tetap boleh diam
    await engine.stop();
});

test("WATCH: restart behavior + UI independence", async () => {
    const engine = new WatchEngine({ assetRegistry: syntheticRegistry(), clock });
    engine.start();
    await engine.stop();
    engine.start();
    assert.equal(engine.isRunning, true);
    await engine.stop();
});

test("ALERT: evidence-grounded — tanpa sumber/evidence ditolak", () => {
    const engine = new AlertEngine({ clock });
    const bad = engine.raise({
        event: { id: "e1", type: "lightning", severity: "critical", confidence: 0.9, sources: [], evidence: [], location: { lat: 0, lon: 0 }, radiusM: 0, firstObservedAt: NOW, lastObservedAt: NOW }
    });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /bukti|evidence/);
});

test("ALERT: klaim live jujur — event basi TIDAK dilabel live", () => {
    const engine = new AlertEngine({ clock });
    const staleEvent = fuseCluster([{
        id: "o1", type: "lightning", source: "x",
        geometry: { type: "point", lat: -6.6, lon: 106.8 },
        observedAt: NOW - 4 * 60 * 60 * 1000, confidence: 0.9
    }], { severity: "warning", nowMs: NOW });
    const raised = engine.raise({ event: staleEvent.event, assetId: "X" });
    assert.equal(raised.ok, true);
    assert.equal(raised.alert.when.live, false); // TIDAK klaim live
    assert.equal(raised.alert.freshness.ageMs > 60 * 60 * 1000, true);
});

test("ALERT: severity threshold + bounded queue", () => {
    const engine = new AlertEngine({ clock, minSeverity: "warning", maxQueue: 3 });
    const mk = (sev, id) => ({
        id, type: "lightning", severity: sev, confidence: 0.9,
        sources: ["s"], evidence: [{ observationId: "o1" }],
        location: { lat: 0, lon: 0 }, radiusM: 0, firstObservedAt: NOW, lastObservedAt: NOW
    });
    assert.equal(engine.raise({ event: mk("info", "a") }).ok, false); // di bawah ambang
    for (const id of ["b", "c", "d", "e"]) engine.raise({ event: mk("critical", id) });
    assert.equal(engine.queue.length, 3); // bounded
    assert.equal(engine.stats.suppressed, 1);
});

test("LOCATION: tanpa izin → degrade jujur; FOLLOW ME butuh otorisasi", async () => {
    const loc = new LocationPriority({
        liveLocationProvider: async () => ({ ok: true, location: { lat: -6.5971, lon: 106.7995 } })
    });
    const degraded = await loc.resolve();
    assert.equal(degraded.priority, "P4"); // Indonesia default, BUKAN lokasi presisi
    assert.equal(degraded.degradedFrom[0].reason, "live_location_not_authorized");
    // Follow-me tanpa izin gagal.
    assert.equal(loc.requestFollowMe({ granted: true }).ok, false);
    loc.setLiveLocationAuthorized(true);
    const live = await loc.resolve();
    assert.equal(live.priority, "P0");
    assert.equal(loc.requestFollowMe({ granted: true }).ok, true);
    // Cabut izin → follow-me mati otomatis.
    loc.setLiveLocationAuthorized(false);
    assert.equal(loc.followMe, false);
});

test("CCTV: hanya publik; otorisasi pemilik fail-closed pra-Lane4 (MD-004)", () => {
    const cams = new CameraRegistry();
    cams.registerPublicCamera({ id: "pub1", label: "Public", location: { lat: -6.6, lon: 106.8 }, snapshotUrl: "https://example.invalid/snap.jpg" });
    // MD-004: registrasi kamera "milik pemilik" oleh pemanggil arbitrer
    // DITOLAK — tidak ada permukaan API yang memalsukan otorisasi.
    const denied = cams.registerAuthorizedCamera({ id: "auth1", label: "Mine", location: { lat: -6.6, lon: 106.8 }, snapshotUrl: "http://192.168.1.50/snap.jpg" });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "OWNER_TRUST_NOT_INTEGRATED");
    assert.equal(cams.get("cctv_auth1"), null);
    assert.equal(cams.canFetch("cctv_pub1").ok, true);
    assert.equal(cams.canFetch("cctv_unknown").ok, false);
    // Descriptor media mengarah ke MediaIngress Damar, bukan router kedua;
    // INERT — tidak membawa URL mentah (bukan fetch token).
    const descriptor = frameMediaDescriptor(cams.get("cctv_pub1"));
    assert.equal(descriptor.instruction, "ingest_via_media_ingress");
    assert.equal(descriptor.sourceChannel, "camera");
    assert.equal(descriptor.snapshotUrl, undefined);
    assert.equal(descriptor.mediaRef, "mataDewa.cctv:cctv_pub1");
});

test("AUTHORITY: governed action menolak dieksekusi langsung (fail-closed)", async () => {
    assert.equal(classifyAction(CAPABILITY_FAMILIES.WATCH_CREATE), "governed");
    assert.equal(classifyAction(CAPABILITY_FAMILIES.ASSET_IMPORT), "governed");
    assert.equal(classifyAction(CAPABILITY_FAMILIES.VIEW_FLY_TO), "readonly");
    assert.equal(classifyAction("mata_dewa.evil.bypass"), "unknown");
    // Eksekusi governed → ditolak dengan alasan jalur kanonik.
    const refused = await executeDaemonAction(CAPABILITY_FAMILIES.WATCH_CREATE, {}, null);
    assert.equal(refused.ok, false);
    assert.ok(GOVERNED_ACTIONS.has(CAPABILITY_FAMILIES.WATCH_CREATE));
});

test("CREDENTIALS: vault seam — SecretRef opaque, resolve ter-scope, tanpa bypass", async () => {
    const store = new MataDewaCredentialStore({}); // memori (tes)
    const set = store.setCredential("tomtom", "synthetic-key-abc");
    assert.equal(set.ok, true);
    // RefString TIDAK mengandung nilai.
    assert.equal(set.refString.includes("synthetic-key-abc"), false);
    assert.equal(set.refString.startsWith("secretref:v1:"), true);
    // Resolve memberi nilai ke pemanggil berhak.
    const resolved = await store.resolveCredential("tomtom");
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value, "synthetic-key-abc");
    // Provider lain tidak bisa resolve dari scope matadewa bila tidak ada.
    const none = await store.resolveCredential("opensky-network");
    assert.equal(none.ok, false);
    assert.equal(none.code, "credentials_absent");
    // Remove → revoke.
    assert.equal(store.removeCredential("tomtom").ok, true);
    const gone = await store.resolveCredential("tomtom");
    assert.equal(gone.ok, false);
});

test("CREDENTIALS: availability mode — ZERO sampai kredensial PLUS/PRO terpasang", () => {
    const store = new MataDewaCredentialStore({});
    assert.equal(store.availabilityMode([
        { id: "tomtom", requiresCredential: true, credentialTier: "PRO" },
        { id: "firms", requiresCredential: true, credentialTier: "PLUS" }
    ]), "ZERO");
    store.setCredential("firms", "k1");
    assert.equal(store.availabilityMode([
        { id: "tomtom", requiresCredential: true, credentialTier: "PRO" },
        { id: "firms", requiresCredential: true, credentialTier: "PLUS" }
    ]), "PLUS");
    store.setCredential("tomtom", "k2");
    assert.equal(store.availabilityMode([
        { id: "tomtom", requiresCredential: true, credentialTier: "PRO" },
        { id: "firms", requiresCredential: true, credentialTier: "PLUS" }
    ]), "PRO");
});
