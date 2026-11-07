"use strict";

/**
 * LANE 5 — INTEGRASI POST-LANE4 (Mata Dewa ↔ Trust Kanonik).
 *
 * Matriks adversarial untuk tujuh area integrasi:
 *   1. Vault kanonik (kredensial provider by-reference, cipher aman).
 *   2. CCTV privat (otorisasi jembatan OwnerTrust, bukan string).
 *   3. RF device trust (eskalasi produksi-live butuh perangkat terdaftar).
 *   4. Mutasi RF teristimewa (Action Intent → Authority → Actuation Fabric).
 *   5. Owner continuity lintas-kanal (tanpa eskalasi).
 *   6. Audit ledger (setiap keputusan, tanpa materi rahasia).
 *   7. ZERO mode (tanpa trust, tanpa RF hardware — tetap hidup).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const {
    composeOwnerTrustForTest,
    canonicalChallenge,
    isCanonicalOwnerTrustComposition
} = require("../../src/authority/ownerTrustComposition");
const { AuthorityRegistry } = require("../../src/authority/registry");
const authorityStore = require("../../src/authority/store");
const { realClock } = require("../../src/embodiment/core/util");
const { createSecretVault } = require("../../src/runtime/vault");
const { createFileSecretStore } = require("../../src/runtime/vault/store");
const { createProductionCipherAdapter } = require("../../src/runtime/vaultProviders");

const {
    buildMataDewaTrustBridges,
    attachMataDewaTrustBridges,
    createCctvAuthorizer
} = require("../../src/mataDewa/trust/composition");
const { createRfDeviceTrustGate } = require("../../src/mataDewa/trust/rfDeviceTrust");
const {
    RF_CONTROL_CAPABILITIES,
    wireMataDewaRfControlActuators
} = require("../../src/mataDewa/capabilities/rfControlWiring");
const { getService } = require("../../src/mataDewa/index.js");
const { CameraRegistry, CAMERA_ACCESS } = require("../../src/mataDewa/media/cctv");
const { CAPABILITY_FAMILIES } = require("../../src/mataDewa/capabilities/index");

// ---------------------------------------------------------------------------

function pem(kp) {
    return kp.publicKey.export({ type: "spki", format: "pem" });
}

function signChallenge(comp, { purpose, credentialId, nonce, context }, privateKey) {
    return crypto.sign(null, canonicalChallenge({ purpose, credentialId, nonce, context }),
        privateKey).toString("base64url");
}

/** Komposisi OwnerTrust lengkap: bootstrap → credential live → proof helper. */
async function makeOwnerComp({ stateFile = null, ledgerOverride = null } = {}) {
    const comp = await composeOwnerTrustForTest({ stateFile, ledgerOverride });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-int" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-int",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    const proof = (purpose = "owner-proof") => {
        const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId: "cred-live" });
        return {
            kind: "owner-proof",
            credentialId: "cred-live",
            nonce: ch.nonce,
            signature: signChallenge(comp, { ...ch, purpose }, kp.privateKey)
        };
    };
    const fullProof = proof;
    return { comp, proof, kp, close: () => { try { comp.close(); } catch { /* sudah */ } } };
}

/** Singleton Mata Dewa di-reset antar tes (komposisi uji per-tes). */
function resetServiceSingleton() {
    require("../../src/mataDewa/composition").resetMataDewaServiceForTests();
}

/**
 * Bridges untuk komposisi uji non-durabel: vault komposisinya insecure
 * (adapter uji deterministik) — attachVault produksi menolaknya dengan
 * benar. Tes yang butuh vault menyediakan vault produksi eksplisit.
 */
function makeBridges(compOrCompObj, { withVault = false, dir = null } = {}) {
    const comp = compOrCompObj.comp ?? compOrCompObj;
    return buildMataDewaTrustBridges(comp, {
        vault: withVault && dir ? makeProductionVault(dir) : null
    });
}

/** Vault produksi (AES-256-GCM, file-backed) di direktori sementara. */
function makeProductionVault(dir) {
    const keyPath = path.join(dir, "vault-master.key");
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    const cipher = createProductionCipherAdapter({ keyFile: keyPath, allowPlatformManagedKeyFile: true });
    const store = createFileSecretStore(path.join(dir, "vault-store"), { cipher });
    return createSecretVault({ store, cipher, now: () => Date.now() });
}

function makeService({ allowLocalUdp = false } = {}) {
    resetServiceSingleton();
    const svc = getService({ allowLocalUdp });
    svc.registerKeyedProviders();
    return svc;
}

// ---------------------------------------------------------------------------
// INTEGRASI 1 — VAULT KANONIK
// ---------------------------------------------------------------------------

test("I1: kredensial provider tersimpan via Vault kanonik by-reference; cipher aman", async () => {
    resetServiceSingleton();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "int1-"));
    const comp = await makeOwnerComp();
    const bridges = buildMataDewaTrustBridges(comp.comp, { vault: makeProductionVault(dir) });
    const svc = makeService();
    attachMataDewaTrustBridges(svc, bridges);

    const set = svc.credentialStore.setCredential("firms", "MAP_KEY_SECRET_VALUE");
    assert.equal(set.ok, true);
    assert.match(set.refString, /^secretref:v1:/);
    const resolved = await svc.registry.credentialResolver("firms");
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value, "MAP_KEY_SECRET_VALUE");
    // Tidak ada salinan secret di state provider/store.
    assert.equal([...svc.credentialStore.refs.values()].join(" ").includes("SECRET_VALUE"), false);
    // Re-attach ditolak (komposisi sekali).
    assert.equal(svc.credentialStore.attachVault(makeProductionVault(dir)).code, "VAULT_ALREADY_BOUND");
    comp.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("I1: vault insecure (cipher uji deterministik) ditolak di produksi", async () => {
    const comp = await makeOwnerComp();
    const insecureVault = createSecretVault({ now: () => Date.now() }); // cipher deterministic
    const bridges = buildMataDewaTrustBridges(comp.comp, { vault: insecureVault });
    const svc = makeService();
    assert.throws(() => attachMataDewaTrustBridges(svc, bridges), /VAULT_CIPHER_NOT_SECURE|MATA_DEWA_VAULT_BIND_FAILED/);
    comp.close();
});

test("I1: boot tanpa vault → VAULT_NOT_COMPOSED; kegagalan provider ≠ kegagalan Mata Dewa", async () => {
    resetServiceSingleton();
    const svc = makeService();
    // Tanpa ref → credentials_absent (jujur); setCredential tanpa vault →
    // VAULT_NOT_COMPOSED (fail-closed); kegagalan provider ≠ kegagalan core.
    assert.equal((await svc.registry.credentialResolver("firms")).code, "credentials_absent");
    const h = svc.health();
    assert.ok(h.ok !== false);
    await svc.start();
    // Boot jujur: READY bila ada provider hidup, DEGRADED bila semua
    // provider absen — inti tetap hidup keduanya (ZERO mode).
    assert.ok(["ready", "degraded"].includes(svc.state), `state: ${svc.state}`);
    await svc.shutdown();
});

// ---------------------------------------------------------------------------
// INTEGRASI 2 — CCTV PRIVAT
// ---------------------------------------------------------------------------

test("I2: registrasi kamera privat butuh jembatan + principal terautentikasi", async () => {
    const { comp, proof } = await makeOwnerComp();
    const bridges = makeBridges(comp);
    const cams = new CameraRegistry();

    // Pra-integrasi: tanpa jembatan → OWNER_TRUST_NOT_INTEGRATED (tetap).
    assert.equal(cams.registerAuthorizedCamera({ id: "a", snapshotUrl: "http://127.0.0.1/x.jpg" }).code,
        "OWNER_TRUST_NOT_INTEGRATED");

    // Dengan jembatan tapi tanpa evidence → ditolak.
    const denied = cams.registerAuthorizedCamera({
        id: "a", snapshotUrl: "http://127.0.0.1/x.jpg", deviceId: "dev-1",
        authorization: null, cameraAuthorizer: bridges.cameraAuthorizer
    });
    assert.equal(denied.ok, false);

    // Owner proof + device binding aktif → sah.
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "cam-host-1", displayName: "CamHost" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });

    const ok = cams.registerAuthorizedCamera({
        id: "garage", label: "Garage", location: { lat: -6.6, lon: 106.8 },
        snapshotUrl: "http://192.168.1.50/snap.jpg",
        deviceId: dev.deviceId, authorization: { proof: proof() },
        cameraAuthorizer: bridges.cameraAuthorizer
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.camera.cameraAccess, CAMERA_ACCESS.AUTHORIZED_DEVICE);
    assert.equal(ok.camera.trust.deviceId, dev.deviceId);

    // canFetch AUTHORIZED_DEVICE tanpa jembatan → fail-closed.
    assert.equal(cams.canFetch("cctv_garage").ok, false);
    // Dengan jembatan + evidence Owner → sah.
    assert.equal(cams.canFetch("cctv_garage", {
        authorization: { proof: proof() }, cameraAuthorizer: bridges.cameraAuthorizer
    }).ok, true);
    // Principal lain (bukan pemilik binding) → ditolak.
    const comp2 = await makeOwnerComp();
    const bridges2 = makeBridges(comp2.comp);
    assert.equal(cams.canFetch("cctv_garage", {
        authorization: { proof: comp2.proof() }, cameraAuthorizer: bridges2.cameraAuthorizer
    }).ok, false);
    comp2.close();
});

test("I2: revokasi binding perangkat berlaku SEGERA pada otorisasi kamera", async () => {
    const { comp, proof } = await makeOwnerComp();
    const bridges = makeBridges(comp);
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "cam-host-2", displayName: "CamHost2" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });
    const cams = new CameraRegistry();
    const ok = cams.registerAuthorizedCamera({
        id: "yard", label: "Yard", location: { lat: -6.6, lon: 106.8 },
        snapshotUrl: "http://192.168.1.51/snap.jpg",
        deviceId: dev.deviceId, authorization: { proof: proof() },
        cameraAuthorizer: bridges.cameraAuthorizer
    });
    assert.equal(ok.ok, true);
    assert.equal(cams.canFetch("cctv_yard", {
        authorization: { proof: proof() }, cameraAuthorizer: bridges.cameraAuthorizer
    }).ok, true);
    // Revoke credential owner → generation bump → binding basi → ditolak.
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-int",
        newCredential: { credentialId: "cred-live-2", publicKeyPem: pem(kp2) }
    });
    const proof2 = (purpose = "owner-proof") => {
        const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId: "cred-live-2" });
        return {
            kind: "owner-proof", credentialId: "cred-live-2", nonce: ch.nonce,
            signature: signChallenge(comp, { ...ch, purpose }, kp2.privateKey)
        };
    };
    const after = cams.canFetch("cctv_yard", {
        authorization: { proof: proof2() }, cameraAuthorizer: bridges.cameraAuthorizer
    });
    assert.equal(after.ok, false);
});

test("I2: akuisisi frame privat — SSRF tetap kencang, tanpa jembatan tidak ada LAN", async () => {
    const { comp, proof } = await makeOwnerComp();
    const bridges = makeBridges(comp);
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "cam-host-3", displayName: "CamHost3" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });

    // Server JPEG kecil di loopback (simulasi kamera LAN).
    const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(32, 7), Buffer.from([0xFF, 0xD9])]);
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(JPEG);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    server.unref(); // jangan tahan event loop
    const port = server.address().port;

    const cams = new CameraRegistry();
    cams.registerAuthorizedCamera({
        id: "lab", label: "Lab", location: { lat: -6.6, lon: 106.8 },
        snapshotUrl: `http://127.0.0.1:${port}/snap.jpg`,
        deviceId: dev.deviceId, authorization: { proof: proof() },
        cameraAuthorizer: bridges.cameraAuthorizer
    });

    // Tanpa otorisasi → TIDAK ada fetch LAN sama sekali.
    const denied = await require("../../src/mataDewa/media/cctv").acquireAuthorizedCameraFrame(
        cams, "cctv_lab", { cameraAuthorizer: bridges.cameraAuthorizer });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "PRINCIPAL_NOT_AUTHENTICATED");

    // Dengan otorisasi → fetch trusted-lan + deskriptor inert (tanpa URL).
    const ok = await require("../../src/mataDewa/media/cctv").acquireAuthorizedCameraFrame(
        cams, "cctv_lab", {
            authorization: { proof: proof() }, cameraAuthorizer: bridges.cameraAuthorizer
        });
    assert.equal(ok.ok, true);
    assert.equal(ok.bytes[0], 0xFF);
    assert.equal(ok.mediaDescriptor.declaredMimeType, "image/jpeg");
    assert.equal(JSON.stringify(ok.mediaDescriptor).includes("127.0.0.1"), false);
    assert.equal(ok.mediaIngest.code, "MEDIA_INGRESS_NOT_COMPOSED");

    // Redirect lintas host tetap ditolak oleh batas kanonik.
    server.close();
});

// ---------------------------------------------------------------------------
// INTEGRASI 3 — RF DEVICE TRUST
// ---------------------------------------------------------------------------

test("I3: perangkat tak dikenal → tidak ada eskalasi produksi-live", async () => {
    const { comp } = await makeOwnerComp();
    const bridges = makeBridges(comp);
    const gate = bridges.rfDeviceTrustGate;
    assert.equal(gate.stateOf("ghost-sensor"), "UNENROLLED");
    const verdict = gate.authorizeLiveBinding({ sensorId: "ghost-sensor", sourceKind: "udp" });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.state, "UNENROLLED");
    // Simulasi/replay tidak pernah produksi-live apa pun state-nya.
    assert.equal(gate.authorizeLiveBinding({ sensorId: "x", sourceKind: "replay" }).ok, false);
});

test("I3: enroll butuh binding perangkat kanonik aktif; revoke segera", async () => {
    const { comp, proof } = await makeOwnerComp();
    const bridges = makeBridges(comp);
    const gate = bridges.rfDeviceTrustGate;
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "rf-host-1", displayName: "RFHost" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;

    // Tanpa binding perangkat → enroll ditolak.
    assert.equal(gate.enroll({ sensorId: "rf-s1", deviceId: dev.deviceId }).code, "RF_DEVICE_NOT_BOUND");

    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });
    const enrolled = gate.enroll({ sensorId: "rf-s1", deviceId: dev.deviceId });
    assert.equal(enrolled.ok, true);
    assert.equal(gate.stateOf("rf-s1"), "TRUSTED");
    assert.equal(gate.authorizeLiveBinding({ sensorId: "rf-s1", sourceKind: "udp" }).ok, true);

    // Rotasi kredensial owner → binding basi → state REVOKED (segera).
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-int",
        newCredential: { credentialId: "cred-live-2", publicKeyPem: pem(kp2) }
    });
    assert.equal(gate.stateOf("rf-s1"), "REVOKED");
    assert.equal(gate.authorizeLiveBinding({ sensorId: "rf-s1", sourceKind: "udp" }).ok, false);
    // Binding basi (rotasi) → enroll butuh binding BARU (jujur, bukan palsu).
    assert.equal(gate.enroll({ sensorId: "rf-s1", deviceId: dev.deviceId }).code, "RF_DEVICE_NOT_BOUND");
    // Revoke EKSPLISIT bersifat terminal: enroll ulang dilarang keras.
    assert.equal(gate.revoke({ sensorId: "rf-s1", reason: "terminal" }).ok, true);
    assert.equal(gate.enroll({ sensorId: "rf-s1", deviceId: dev.deviceId }).code, "RF_DEVICE_REVOKED");
});

test("I3: service ingest live UDP — tanpa gerbang/terdaftar → tidak di-mark trusted", async () => {
    resetServiceSingleton();
    const { comp, proof } = await makeOwnerComp();
    const svc = makeService({ allowLocalUdp: true });
    const bridges = makeBridges(comp);
    attachMataDewaTrustBridges(svc, bridges);

    // Sumber UDP live di loopback; frame RuView ADR-018 asli diproses
    // lewat jalur kanonik (processUdpFrame → sesi → estimasi → submit).
    const added = svc.rfManager.addUdpSource({
        id: "u-ghost", sensorId: "ghost", bindAddress: "127.0.0.1", bindPort: 0,
        maxRateHz: 50, location: { lat: -6.6, lon: 106.8 }
    });
    assert.equal(added.ok, true);
    const started = await svc.rfManager.startUdp("u-ghost");
    assert.equal(started.ok, true);

    const { parseRuviewFrame, ADR018_MAGIC, ADR018_HEADER_SIZE } = require("../../src/mataDewa/rf/capture/sources");
    const makeFrame = (seq) => {
        const header = Buffer.alloc(ADR018_HEADER_SIZE);
        header.writeUInt32LE(ADR018_MAGIC, 0);
        header.writeUInt8(1, 4);
        header.writeUInt8(1, 5);
        header.writeUInt16LE(52, 6);
        header.writeUInt32LE(2437, 8);
        header.writeUInt32LE(seq, 12);
        header.writeInt8(-55, 16);
        header.writeInt8(-98, 17);
        const iq = Buffer.alloc(52 * 2);
        for (let sc = 0; sc < 52; sc++) { iq.writeInt8(((sc + seq) % 3) - 1, sc * 2); iq.writeInt8(0, sc * 2 + 1); }
        const parsed = parseRuviewFrame(Buffer.concat([header, iq]));
        assert.equal(parsed.ok, true);
        return parsed.frame;
    };
    for (let i = 0; i < 20; i++) svc.rfManager.processUdpFrame("u-ghost", makeFrame(i));

    const stored = [...svc.observations.values()].find((o) => o.attributes?.sensorId === "ghost");
    assert.ok(stored, "observasi live UDP harus tersimpan");
    assert.equal(stored.attributes?.sourceKind, "udp");
    // TIDAK dipercaya-live: verifikator menolak (tidak di-mark trusted).
    assert.equal(svc.verifyTrustedLiveRf(stored) ?? null, null);
    await svc.shutdown();
    comp.close();
});

test("I4: capability RF terdaftar; tanpa grant → DENY (availability ≠ authority)", async () => {
    const boot = require("../../src/action/bootstrap");
    const facade = boot.createCanonicalActionFacade();
    const ser = JSON.stringify({
        schemaVersion: 1,
        capabilityId: CAPABILITY_FAMILIES.RF_DEVICE_ENROLL,
        operation: "enroll",
        arguments: { sensorId: "rf-s9", deviceId: "dev-x" }
    });
    const intent = facade.admit(ser, { source: "test" });
    assert.deepEqual(intent.scope, ["rf-s9"]);
    const verdict = await facade.evaluate(intent, { session: null });
    assert.equal(verdict.decision, "DENY");
});

test("I4: argumen berbentuk otoritas ditolak di admission (tidak ada bypass)", async () => {
    const boot = require("../../src/action/bootstrap");
    const facade = boot.createCanonicalActionFacade();
    const ser = JSON.stringify({
        schemaVersion: 1,
        capabilityId: CAPABILITY_FAMILIES.RF_DEVICE_ENROLL,
        operation: "enroll",
        arguments: { sensorId: "s", deviceId: "d", owner: true, grant: "all" }
    });
    assert.throws(() => facade.admit(ser, { source: "test" }), /authority-shaped/);
});

test("I4/MD-019: permukaan kontrol TIDAK hidup di service; tidak ada resolver ekspor", async () => {
    resetServiceSingleton();
    const { comp } = await makeOwnerComp();
    // Permukaan kontrol tidak boleh dapat di-mint dari service — enumerable
    // maupun tidak — dan tidak ada resolver yang diekspor modul mana pun.
    const svc = makeService();
    assert.equal(svc.rfControl, undefined);
    assert.equal(Object.getOwnPropertyNames(svc).includes("rfControl"), false);
    assert.deepEqual(Object.getOwnPropertySymbols(svc).length, 0);
    // Tidak ada resolver permukaan di ekspor jembatan trust.
    const trustCompositionExports = Object.keys(
        require("../../src/mataDewa/trust/composition"));
    for (const banned of ["resolveMataDewaRfControlSurface", "getRfControlSurface",
        "resolveRfMutationSurface", "getRfAdmin", "lookupRfControl", "getPrivateRfControl"]) {
        assert.equal(trustCompositionExports.includes(banned), false, `${banned} tidak boleh diekspor`);
    }
    // Tidak ada resolver permukaan di ekspor modul wiring RF.
    const wiringExports = Object.keys(require("../../src/mataDewa/capabilities/rfControlWiring"));
    for (const banned of ["resolveMataDewaRfControlSurface", "getRfControlSurface",
        "resolveRfMutationSurface", "getRfAdmin", "lookupRfControl", "getPrivateRfControl",
        "surfaceForService", "rfControlSurfacesByService"]) {
        assert.equal(wiringExports.includes(banned), false, `${banned} tidak boleh diekspor`);
    }
    // Tanpa attach trust, actuator fail-closed (permukaan tidak ada).
    assert.equal((await makeActuatorBindings({ svc }).bindings
        .find((b) => b.actuatorId === "act-matadewa-rf-enroll").invoke({
            parameters: { sensorId: "x", deviceId: "d" }
        })).reason, "MATA_DEWA_SERVICE_UNAVAILABLE");
    await svc.shutdown();

    // Setelah attach trust kanonik: service tetap tidak memegang permukaan.
    const svc2 = makeService({ allowLocalUdp: true });
    const bridges = makeBridges(comp);
    attachMataDewaTrustBridges(svc2, bridges);
    assert.equal(svc2.rfControl, undefined);
    assert.equal(Object.getOwnPropertyNames(svc2).includes("rfControl"), false);
    // Gerbang kanonik menempel (non-enumerable) — sumber kebenaran untuk
    // permukaan yang lahir di closure modul wiring saat actuator dipasang.
    assert.ok(svc2._trustBridges?.rfDeviceTrustGate);
    // Fail-closed tanpa binding perangkat OwnerTrust aktif: actuator
    // menjangkau gerbang (dibawa bridges), tapi enroll menuntut binding
    // kanonik (Integrasi 3) — deny melalui jalur actuator produksi.
    const enrollResult = await makeActuatorBindings({ svc: svc2 }).bindings
        .find((b) => b.actuatorId === "act-matadewa-rf-enroll").invoke({
            parameters: { sensorId: "x", deviceId: "d" }
        });
    assert.equal(enrollResult.code, "RF_DEVICE_NOT_BOUND");
    await svc2.shutdown();
    comp.close();
});

test("I4/MD-019: jalur impor gaya controller/plugin/tool tidak dapat meraih permukaan RF", async () => {
    resetServiceSingleton();
    const { comp } = await makeOwnerComp();
    const svc = makeService({ allowLocalUdp: true });
    attachMataDewaTrustBridges(svc, makeBridges(comp));

    // Impor gaya tool/plugin terhadap modul publik — semuanya tidak boleh
    // mengekspor resolver/permukaan, tidak boleh ada jalur pembuatan
    // on-demand dari service publik.
    const publicMataDewa = require("../../src/mataDewa");
    assert.equal(publicMataDewa.getService(), svc);
    const toolVisibleExports = new Set([
        ...Object.keys(publicMataDewa),
        ...Object.keys(require("../../src/mataDewa/index.js")),
        ...Object.keys(require("../../src/mataDewa/trust/composition")),
        ...Object.keys(require("../../src/mataDewa/capabilities/rfControlWiring")),
        ...Object.keys(require("../../src/mataDewa/composition"))
    ]);
    for (const banned of ["resolveMataDewaRfControlSurface", "getRfControlSurface",
        "getPrivateRfControl", "resolveRfMutationSurface", "getRfAdmin", "lookupRfControl",
        "rfControlSurfacesByService", "surfaceForService"]) {
        assert.equal(toolVisibleExports.has(banned), false, `ekspor publik tidak boleh memuat ${banned}`);
    }
    // Service publik tidak memegang permukaan (properti, simbol, non-enum).
    assert.equal(svc.rfControl, undefined);
    assert.equal(Object.getOwnPropertyNames(svc).includes("rfControl"), false);
    assert.equal(Object.getOwnPropertyNames(svc).includes("_rfControl"), false);
    assert.equal(Object.getOwnPropertySymbols(svc).includes(Symbol.for("rfControl")), false);
    // Tidak ada nested reference yang membuka permukaan dari service: semua
    // nilai properti (dangkal) bukan permukaan RF.
    for (const key of Object.getOwnPropertyNames(svc)) {
        const v = svc[key];
        if (v && typeof v === "object" && typeof v.enable === "function" &&
            typeof v.revoke === "function" && typeof v.recalibrate === "function") {
            assert.fail(`properti service ${key} mengekspos permukaan RF`);
        }
    }
    // Permukaan TIDAK bisa di-mint dari service kosong (belum attach).
    await svc.shutdown();
    resetServiceSingleton();
    const svc0 = getService({ allowLocalUdp: true });
    assert.equal(svc0.rfControl, undefined);
    assert.ok(!svc0._trustBridges);
    // Semua modul yang bisa diimpor tidak mengekspor mint/resolver.
    for (const mod of [
        "../../src/mataDewa",
        "../../src/mataDewa/index.js",
        "../../src/mataDewa/composition",
        "../../src/mataDewa/trust/composition",
        "../../src/mataDewa/capabilities/rfControlWiring"
    ]) {
        const exported = Object.keys(require(mod));
        for (const banned of ["resolveMataDewaRfControlSurface", "getRfControlSurface",
            "getPrivateRfControl", "resolveRfMutationSurface", "getRfAdmin", "lookupRfControl",
            "createRfControlSurface"]) {
            if (mod === "../../src/mataDewa/capabilities/rfControlWiring") {
                assert.equal(exported.includes("createRfControlSurface"), false,
                    "modul wiring tidak mengekspor pabrik permukaan");
            }
            assert.equal(exported.includes(banned), false, `${mod} tidak boleh mengekspor ${banned}`);
        }
    }
    await svc0.shutdown();
    resetServiceSingleton();
    comp.close();
});

/** Actuator binding produksi + registry actuator test-domain minimal. */
function makeActuatorBindings({ svc }) {
    const registered = [];
    const bindings = wireMataDewaRfControlActuators({
        actuatorRegistry: {
            register(spec) {
                const binding = Object.freeze({ ...spec, invoke: spec.invoke });
                registered.push(binding);
                return binding;
            }
        },
        wiring: { capabilities: Object.fromEntries(RF_CONTROL_CAPABILITIES.map((d) => [d.id, { id: d.id, incarnationId: `inc-${d.id}` }])) },
        resolveService: () => svc
    });
    return { bindings, registered };
}

test("I4/MD-019: actuator RF fail-closed tanpa komposisi trust (permukaan tidak lahir)", async () => {
    resetServiceSingleton();
    const svc = makeService();
    const { bindings } = makeActuatorBindings({ svc });
    const enrollBinding = bindings.find((b) => b.actuatorId === "act-matadewa-rf-enroll");
    const enableBinding = bindings.find((b) => b.actuatorId === "act-matadewa-rf-enable");
    assert.equal((await enrollBinding.invoke({ parameters: { sensorId: "x", deviceId: "d" } })).reason,
        "MATA_DEWA_SERVICE_UNAVAILABLE");
    assert.equal((await enableBinding.invoke({ parameters: { sensorId: "x", location: { lat: 1, lon: 2 } } })).reason,
        "MATA_DEWA_SERVICE_UNAVAILABLE");
    // Argumen asing (token otoritas) tetap ditolak allowlist.
    assert.equal((await enrollBinding.invoke({ parameters: { sensorId: "x", deviceId: "d", grant: "all" } })).reason,
        "argument 'grant' tidak sah untuk enroll");
    await svc.shutdown();
});

test("I4: enable listener butuh perangkat TRUSTED + allowLocalUdp + audit", async () => {
    resetServiceSingleton();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "int4-"));
    const { comp, proof } = await makeOwnerComp();
    const svc = makeService({ allowLocalUdp: true });
    const bridges = makeBridges(comp, { withVault: true, dir });
    attachMataDewaTrustBridges(svc, bridges);
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "rf-host-9", displayName: "RFHost9" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });
    const { bindings } = makeActuatorBindings({ svc });
    const byOp = Object.fromEntries(bindings.map((b) => [b.actuatorId, b]));

    // Belum enroll → enable ditolak (lewat jalur actuator).
    assert.equal((await byOp["act-matadewa-rf-enable"].invoke({
        parameters: { sensorId: "rf-e1", location: { lat: -6.6, lon: 106.8 } }
    })).code, "RF_DEVICE_NOT_TRUSTED");
    // Enroll → enable sah (lewat jalur actuator).
    assert.equal((await byOp["act-matadewa-rf-enroll"].invoke({
        parameters: { sensorId: "rf-e1", deviceId: dev.deviceId }
    })).ok, true);
    const enabled = await byOp["act-matadewa-rf-enable"].invoke({
        parameters: { sensorId: "rf-e1", bindPort: 0, location: { lat: -6.6, lon: 106.8 } }
    });
    assert.equal(enabled.ok, true);
    // Tanpa allowLocalUdp (komposisi lain) → ditolak.
    const svc2 = makeService({ allowLocalUdp: false });
    const bridges2 = makeBridges(comp);
    attachMataDewaTrustBridges(svc2, bridges2);
    const { bindings: bindings2 } = makeActuatorBindings({ svc: svc2 });
    assert.equal((await bindings2.find((b) => b.actuatorId === "act-matadewa-rf-enable").invoke({
        parameters: { sensorId: "rf-e1", location: { lat: -6.6, lon: 106.8 } }
    })).code, "AUTHORIZED_LOCAL_SOURCE_REJECTED");
    await svc2.shutdown();
    // Revoke → listener langsung mati (sumber live dihapus dari rfManager).
    assert.equal((await byOp["act-matadewa-rf-revoke"].invoke({
        parameters: { sensorId: "rf-e1", reason: "test" }
    })).ok, true);
    assert.equal(svc.rfManager.sources.has("rf_udp_rf-e1"), false);
    // Re-enable setelah revoke → ditolak (device REVOKED, fail-closed).
    const reEnable = await byOp["act-matadewa-rf-enable"].invoke({
        parameters: { sensorId: "rf-e1", location: { lat: -6.6, lon: 106.8 } }
    });
    assert.equal(reEnable.ok, false);
    await svc.shutdown();
    comp.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// INTEGRASI 5 — OWNER CONTINUITY LINTAS-KANAL
// ---------------------------------------------------------------------------

test("I5: Owner yang sama lintas kanal; kanal tak tepercaya tidak dapat Owner", async () => {
    const { comp, proof } = await makeOwnerComp();
    const B = comp.channelBinders;
    await B.console.bind({ proof: proof(), purpose: "owner-proof", provenance: comp.testMint.console("local") });
    await B.telegram.bind({ proof: proof(), purpose: "owner-proof", provenance: comp.testMint.telegram("777") });
    assert.equal(B.console.authenticate({ provenance: comp.testMint.console("local") }).principalId, "owner-int");
    assert.equal(B.telegram.authenticate({ provenance: comp.testMint.telegram("777") }).principalId, "owner-int");
    // Peer baru/asing → bukan Owner.
    assert.equal(B.telegram.authenticate({ provenance: comp.testMint.telegram("99999") }).ok, false);
    // Device trust ≠ Owner: reconnect perangkat tidak me-mint otoritas Owner.
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "dev-cont", displayName: "Dev" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });
    const reconnect = await comp.principalBindings.verifyDeviceReconnect({
        deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });
    assert.equal(reconnect.ok, true);
    assert.equal(reconnect.principalId, "owner-int");
    // Namun device trust TIDAK mengotorisasi kamera tanpa principal evidence.
    const bridges = makeBridges(comp);
    assert.equal(bridges.cameraAuthorizer.authenticate({}).ok, false);
    comp.close();
});

// ---------------------------------------------------------------------------
// INTEGRASI 6 — AUDIT LEDGER
// ---------------------------------------------------------------------------

test("I6: setiap keputusan tercatat; tidak ada materi rahasia di record", async () => {
    resetServiceSingleton();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "int6-"));
    const { comp, proof } = await makeOwnerComp({ stateFile: path.join(dir, "ot.json") });
    const bridges = makeBridges(comp);
    const svc = makeService({ allowLocalUdp: true });
    attachMataDewaTrustBridges(svc, bridges);
    // Komposisi durabel: vault cipher aman → attach vault sah (Integrasi 1).
    assert.equal(svc.credentialStore.attachVault(comp.vault).ok, true);
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "rf-audit", displayName: "RFAudit" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });

    const { bindings } = makeActuatorBindings({ svc });
    const byOp = Object.fromEntries(bindings.map((b) => [b.actuatorId, b]));
    await byOp["act-matadewa-rf-enroll"].invoke({ parameters: { sensorId: "rf-a1", deviceId: dev.deviceId } });
    await byOp["act-matadewa-rf-enable"].invoke({ parameters: { sensorId: "rf-a1", location: { lat: -6.6, lon: 106.8 } } });
    await byOp["act-matadewa-rf-revoke"].invoke({ parameters: { sensorId: "rf-a1", reason: "audit-test" } });

    const events = comp.ledger.list({}, { limit: 10000 });
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes("matadewa.rf.device.enrolled"), `enrolled event hilang: ${types.join(",")}`);
    assert.ok(types.includes("matadewa.rf.listener.enabled"));
    assert.ok(types.includes("matadewa.rf.device.revoked"));
    const blob = JSON.stringify(events);
    assert.equal(blob.includes("SECRET"), false);
    assert.equal(blob.includes("secretref"), false);
    await svc.shutdown();
    comp.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("I6: audit gagal → mutasi ditolak (fail closed)", async () => {
    resetServiceSingleton();
    // Ledger yang selalu menolak — hanya sink Mata Dewa; registry OwnerTrust
    // punya audit gate-nya sendiri, jadi binding Owner di bawah tetap sah.
    // MD-018: override disumbangkan lewat seam komposisi (ledgerOverride
    // forTest) — bukan lewat spread komposisi yang kini tidak ter-brand.
    const failingLedger = { appendSafe: () => ({ ok: false, code: "LEDGER_FULL" }) };
    const { comp, proof } = await makeOwnerComp({ ledgerOverride: failingLedger });
    const svcIdentity = require("../../src/embodiment").createIdentityService({});
    const dev = svcIdentity.registerIdentity({ namespace: "channel", stableKey: "rf-audit2", displayName: "RFAudit2" });
    const pairing = svcIdentity.beginPairing(dev.deviceId);
    svcIdentity.submitChallenge({ pairingId: pairing.pairingId, challengeId: pairing.challenge.challengeId, secret: pairing.challenge.secret });
    const { secret: bindingSecret } = svcIdentity.ownerConfirm(pairing.pairingId).bindingCredential;
    await comp.principalBindings.bindOwnerDevice({
        proof: proof(), deviceId: dev.deviceId, bindingSecret, identityService: svcIdentity
    });
    const bridges = makeBridges(comp);
    const svc = makeService({ allowLocalUdp: true });
    attachMataDewaTrustBridges(svc, bridges);
    // Enrollment dengan sink audit gagal → ditolak (fail closed) — lewat
    // jalur actuator kanonik (MD-019).
    const { bindings } = makeActuatorBindings({ svc });
    const enrollBinding = bindings.find((b) => b.actuatorId === "act-matadewa-rf-enroll");
    assert.equal((await enrollBinding.invoke({
        parameters: { sensorId: "rf-a2", deviceId: dev.deviceId }
    })).code, "LEDGER_FULL");
    await svc.shutdown();
    comp.close();
});

// ---------------------------------------------------------------------------
// INTEGRASI 7 — ZERO MODE
// ---------------------------------------------------------------------------

test("I7: ZERO mode tanpa trust/vault/RF hardware — core hidup, semua fail-closed", async () => {
    resetServiceSingleton();
    const svc = makeService();
    await svc.start();
    const st = svc.status();
    assert.equal(st.mode, "ZERO");
    assert.ok(["ready", "degraded"].includes(svc.state), `state: ${svc.state}`);
    // Semua permukaan berotorisasi fail-closed tanpa komposisi trust.
    // MD-019: permukaan kontrol tidak hidup di service; tanpa attach trust,
    // actuator tidak dapat menjangkau permukaan → MATA_DEWA_SERVICE_UNAVAILABLE.
    assert.equal(svc.rfControl, undefined);
    const { bindings } = makeActuatorBindings({ svc });
    assert.equal((await bindings.find((b) => b.actuatorId === "act-matadewa-rf-enroll").invoke({
        parameters: { sensorId: "x", deviceId: "d" }
    })).reason, "MATA_DEWA_SERVICE_UNAVAILABLE");
    assert.equal(svc.credentialStore.setCredential("firms", "v").code, "VAULT_NOT_COMPOSED");
    const cams = new CameraRegistry();
    assert.equal(cams.registerAuthorizedCamera({ id: "x", snapshotUrl: "http://127.0.0.1/x.jpg" }).code,
        "OWNER_TRUST_NOT_INTEGRATED");
    assert.equal(cams.canFetch("cctv_x").ok, false);
    // Watch tetap hidup untuk provider keyless/publik.
    const h = svc.health();
    assert.ok(h.ok !== false);
    await svc.shutdown();
});

// ---------------------------------------------------------------------------
// MD-018 — BRAND KOMPOSISI KANONIK (authority palsu ≠ sumber trust)
// ---------------------------------------------------------------------------

test("MD-018: jembatan menolak komposisi tiruan (spread/duck-typed, brand hilang)", async () => {
    const { comp } = await makeOwnerComp();
    // Salinan spread: shape identik, brand WeakSet hilang → ditolak.
    assert.throws(() => buildMataDewaTrustBridges({ ...comp }), /TRUST_BRIDGES_INVALID/);
    // Lookalike duck-typed penuh (registry/authVerifier asli dipinjam) → ditolak.
    const fake = { ...comp, registry: comp.registry, authVerifier: comp.authVerifier };
    assert.throws(() => buildMataDewaTrustBridges(fake), /TRUST_BRIDGES_INVALID/);
    assert.throws(() => buildMataDewaTrustBridges(null), /TRUST_BRIDGES_INVALID/);
    // Komposisi kanonik asli → diterima (kontrol positif).
    const bridges = buildMataDewaTrustBridges(comp, { vault: null });
    assert.ok(bridges.rfDeviceTrustGate && bridges.cameraAuthorizer);
    comp.close();
});

test("MD-018: attach menolak bridges tiruan; hanya bridges pabrik kanonik menempel", async () => {
    resetServiceSingleton();
    const { comp } = await makeOwnerComp();
    const svc = makeService();
    const realBridges = makeBridges(comp);
    // Bridges palsu (spread + shape sama) → ditolak attach.
    assert.throws(() => attachMataDewaTrustBridges(svc, { ...realBridges }), /ATTACH_TRUST_INVALID/);
    assert.equal(svc._trustBridges, undefined);
    assert.equal(svc.rfControl, undefined);
    // Bridges kanonik → menempel (kontrol positif); service tetap tidak
    // memegang permukaan kontrol apa pun.
    attachMataDewaTrustBridges(svc, realBridges);
    assert.ok(svc._trustBridges);
    assert.equal(svc.rfControl, undefined);
    await svc.shutdown();
    comp.close();
});

test("MD-018: tidak ada mint brand yang bisa diimpor; fake tidak bisa di-brand", async () => {
    const { comp } = await makeOwnerComp();
    // Setiap nama mint/mark/register yang lazim → tidak callable / tidak ada
    // di ekspor komposisi kanonik, dan modul brand lama sudah dihapus.
    const otc = require("../../src/authority/ownerTrustComposition");
    for (const name of ["brandCanonicalComposition", "markCanonicalComposition",
        "mintCanonicalComposition", "registerCanonicalComposition",
        "addCanonicalComposition"]) {
        assert.equal(otc[name], undefined, `${name} tidak boleh diekspor`);
    }
    for (const subpath of ["ownerTrust/canonicalCompositionBrand",
        "ownerTrust/brand"]) {
        assert.throws(() => require(`../../src/authority/${subpath}`),
            /Cannot find module/, `modul ${subpath} harus sudah dihapus`);
    }
    // Predikat read-only tidak bisa menambahkan keanggotaan: memanggilnya
    // dengan objek apa pun TIDAK mengubah status apa pun.
    const fake = { ...comp, registry: comp.registry, authVerifier: comp.authVerifier };
    const wrapper = Object.create(comp);
    assert.equal(isCanonicalOwnerTrustComposition(fake), false);
    assert.equal(isCanonicalOwnerTrustComposition(wrapper), false);
    assert.equal(isCanonicalOwnerTrustComposition(comp), true);
    // Spread/wrapper tetap ditolak oleh jembatan (verifikasi menyeluruh).
    assert.throws(() => buildMataDewaTrustBridges(fake, { vault: null }), /TRUST_BRIDGES_INVALID/);
    assert.throws(() => buildMataDewaTrustBridges(wrapper, { vault: null }), /TRUST_BRIDGES_INVALID/);
    // Kontrol positif: komposisi asli diterima.
    const bridges = buildMataDewaTrustBridges(comp, { vault: null });
    assert.ok(bridges.rfDeviceTrustGate);
    comp.close();
});

test("MD-018: komposisi asing tanpa mint tidak pernah bisa menjadi kanonik", async () => {
    const { comp } = await makeOwnerComp();
    // Komposisi independen (dari modul lain) yang TIDAK lahir dari compose()
    // di ownerTrustComposition — bentuk apa pun — tidak akan di-brand.
    const foreign = {
        registry: comp.registry,
        authVerifier: comp.authVerifier,
        firstOwnerBootstrap: comp.firstOwnerBootstrap,
        principalBindings: comp.principalBindings,
        channelBinders: comp.channelBinders
    };
    assert.equal(isCanonicalOwnerTrustComposition(foreign), false);
    assert.throws(() => buildMataDewaTrustBridges(foreign, { vault: null }), /TRUST_BRIDGES_INVALID/);
    comp.close();
});

// ---------------------------------------------------------------------------
// MD-020 — OTORISASI KAMERA VIA BINDER TERSERTIFIKASI (bukan klaim pemanggil)
// ---------------------------------------------------------------------------

test("MD-020: klaim principalId/viaChannel dari pemanggil bukan lagi kontrak", async () => {
    const { comp } = await makeOwnerComp();
    const authorizer = makeBridges(comp).cameraAuthorizer;
    // Bentuk evidence lama (principalId/viaChannel disumbang pemanggil) →
    // ditolak, meski principalId-nya nyata.
    assert.equal(authorizer.authenticate({ principalId: "owner-int", viaChannel: "console" }).ok, false);
    assert.equal(authorizer.authenticate({ principalId: "owner-int", viaChannel: "telegram", provenance: {} }).ok, false);
    // Provenance asing yang tidak pernah di-mint → bukan bukti kanonik.
    assert.equal(authorizer.authenticate({ provenance: { transport: "console", peerKey: "local" } }).ok, false);
    comp.close();
});

test("MD-020: provenance kanonik + binder tersertifikasi → Owner; peer asing ditolak", async () => {
    const { comp, proof } = await makeOwnerComp();
    const B = comp.channelBinders;
    await B.console.bind({ proof: proof(), purpose: "owner-proof", provenance: comp.testMint.console("local") });
    const authorizer = makeBridges(comp).cameraAuthorizer;
    const auth = authorizer.authenticate({ provenance: comp.testMint.console("local") });
    assert.equal(auth.ok, true);
    assert.equal(auth.principalId, "owner-int");
    assert.equal(auth.role, "owner");
    // Peer lain di kanal yang sama → bukan Owner (ditolak binder).
    assert.equal(authorizer.authenticate({ provenance: comp.testMint.console("other-peer") }).ok, false);
    comp.close();
});
