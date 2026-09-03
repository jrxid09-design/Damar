/**
 * Sertifikasi Lane 5 — ZERO MODE, UI STRUCTURE, CAPABILITY/VOICE, DOCS.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const md = require("../../src/mataDewa");
const composition = require("../../src/mataDewa/composition");
const { MataDewaService, SUBSYSTEM_STATE } = require("../../src/mataDewa/service");
const { buildMataDewaCapabilityRuntime, CAPABILITY_FAMILIES } = require("../../src/mataDewa/capabilities/index");

const NOW = 1759500000000;
const REPO_ROOT = path.join(__dirname, "..", "..");

test("ZERO MODE: boot dengan NOL kunci pihak ketiga → READY + baseline bermakna", async () => {
    // MD-008: komposisi tersegel — penggantian singleton hanya lewat
    // seam test-only di composition.js (tidak ada lagi di permukaan publik).
    composition.resetMataDewaServiceForTests();
    const fresh = new MataDewaService({ clock: { nowMs: () => Date.now() } });
    composition.setMataDewaServiceForTests(fresh);
    require("../../src/mataDewa/providers").registerKeylessProviders(fresh);
    const status = await fresh.start();
    assert.equal(status.state, SUBSYSTEM_STATE.READY);
    assert.equal(status.mode, "ZERO");
    const available = status.providers.filter(p => p.availability === "available");
    assert.ok(available.length >= 4, `baseline keyless harus hidup: ${available.length}`);
    // Kemampuan bermakna: ask menghasilkan observasi nyata dari provider publik.
    const ask = await fresh.ask({ types: ["earthquake"] });
    assert.ok(ask.observations.length > 0, "USGS harus menghasilkan observasi nyata tanpa kunci");
    assert.ok(ask.providerStatuses.every(s => s.failureReason === null || s.state === "available"));
    await fresh.shutdown();
});

test("ZERO MODE: premium tanpa kredensial → unavailable jujur, core tetap hidup", async () => {
    const service = new MataDewaService({ clock: { nowMs: () => NOW } });
    service.registerKeyedProviders();
    // Boot tanpa provider keyless → tetap hidup (degraded), tak pernah crash.
    const status = await service.start();
    assert.equal(status.state, SUBSYSTEM_STATE.DEGRADED);
    assert.equal(service.health().healthy, true);
    const registryDescs = service.registry.listProviders();
    const keyed = registryDescs.filter(d => d.requiresCredential);
    assert.ok(keyed.length >= 4);
    for (const desc of keyed) {
        const poll = await service.registry.pollProvider(desc.id, {});
        if (typeof service.registry.getProvider(desc.id).poll === "function") {
            assert.equal(poll.failureReason, "credentials_absent", desc.id);
        }
    }
    assert.equal(service.health().healthy, true);
});

test("UI STRUCTURE: satu aplikasi — entri APPS tunggal, tanpa lifecycle kedua", () => {
    const appSrc = fs.readFileSync(
        path.join(REPO_ROOT, "apps", "console", "renderer", "app.js"), "utf8");
    // Entri mata-dewa terdaftar sebagai satu app di registry yang sama.
    assert.match(appSrc, /id:\s*"mata-dewa"/);
    assert.equal((appSrc.match(/id:\s*"mata-dewa"/g) ?? []).length, 1);
    // View Mata Dewa dipakai sebagai view registry — bukan window kedua.
    assert.match(appSrc, /view:\s*mataDewa/);
});

test("UI STRUCTURE: view memiliki render/mount/unmount (siklus layar Damar)", () => {
    // Parse statis modul ESM tanpa browser globals.
    const viewSrc = fs.readFileSync(
        path.join(REPO_ROOT, "apps", "console", "renderer", "views", "mataDewa", "view.js"), "utf8");
    assert.match(viewSrc, /render\(root\)/);
    assert.match(viewSrc, /async mount\(root\)/);
    assert.match(viewSrc, /unmount\(\)/);
    // destroyGlobe dipanggil saat unmount (GPU dibebaskan), tapi TIDAK
    // mematikan inti (inti ada di daemon).
    assert.match(viewSrc, /globe\.destroyGlobe\(\)/);
});

test("UI STRUCTURE: modul GEV diadopsi dengan atribusi MIT terjaga", () => {
    const libDir = path.join(REPO_ROOT, "apps", "console", "renderer", "views", "mataDewa", "lib");
    for (const file of ["mapStack.js", "renderGovernor.js", "styles.js"]) {
        const src = fs.readFileSync(path.join(libDir, file), "utf8");
        assert.match(src, /Copyright \(c\) 2026 Bilawal Sidhu/, `${file} kehilangan atribusi MIT`);
        assert.match(src, /github\.com\/bilawalsidhu\/gods-eye-view/, `${file} kehilangan link upstream`);
    }
    const notice = fs.readFileSync(path.join(REPO_ROOT, "apps", "console", "renderer", "views", "mataDewa", "NOTICE.md"), "utf8");
    assert.match(notice, /Copyright \(c\) 2026 Bilawal Sidhu/);
});

test("Cesium tervendor: bundle + notice Apache-2.0 ada", () => {
    const vendor = path.join(REPO_ROOT, "apps", "console", "renderer", "vendor", "cesium");
    assert.ok(fs.existsSync(path.join(vendor, "cesium.bundle.js")));
    assert.ok(fs.existsSync(path.join(vendor, "Assets")));
    assert.ok(fs.existsSync(path.join(vendor, "Workers")));
    const notice = fs.readFileSync(path.join(vendor, "NOTICE"), "utf8");
    assert.match(notice, /Apache License 2\.0/);
});

test("CAPABILITY: 21 kemampuan terdaftar di canonical registry (kind provider)", () => {
    const { runtime, registered } = buildMataDewaCapabilityRuntime({ clock: { nowMs: () => NOW } });
    assert.equal(registered.length, 21);
    for (const r of registered) {
        assert.equal(r.registered, true);
        assert.match(r.id, /^mata_dewa\./);
        assert.match(r.incarnationId, /^inc-/);
    }
    // Keluarga kunci ada.
    for (const family of ["mata_dewa.mode.activate", "mata_dewa.view.fly_to",
        "mata_dewa.watch.create", "mata_dewa.hazard.query"]) {
        assert.ok(CAPABILITY_FAMILIES[Object.keys(CAPABILITY_FAMILIES).find(k => CAPABILITY_FAMILIES[k] === family)]);
    }
});

test("VOICE: tanpa runtime OpenAI — tidak ada import gevRealtime/realtime", () => {
    const mataDewaRoot = path.join(REPO_ROOT, "src", "mataDewa");
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".js")) continue;
            const src = fs.readFileSync(full, "utf8");
            if (/openai|gevRealtime|realtime\/token|api\.openai\.com/i.test(src)) {
                offenders.push(path.relative(REPO_ROOT, full));
            }
        }
    };
    walk(mataDewaRoot);
    assert.deepEqual(offenders, []);
    // Renderer juga bersih.
    const rendererRoot = path.join(REPO_ROOT, "apps", "console", "renderer", "views", "mataDewa");
    const offenders2 = [];
    const walk2 = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk2(full); continue; }
            if (!entry.name.endsWith(".js")) continue;
            const src = fs.readFileSync(full, "utf8");
            if (/openai|gevRealtime|api\.openai\.com/i.test(src)) {
                offenders2.push(path.relative(REPO_ROOT, full));
            }
        }
    };
    walk2(rendererRoot);
    assert.deepEqual(offenders2, []);
});

test("VOICE: VoiceRuntime Damar tidak diubah oleh Lane 5", () => {
    // src/voice tidak boleh disentuh Lane 5 — verifikasi tidak ada referensi mataDewa di dalamnya.
    const voiceRoot = path.join(REPO_ROOT, "src", "voice");
    let touched = false;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".js")) continue;
            if (/mataDewa|mata_dewa|mata-dewa/i.test(fs.readFileSync(full, "utf8"))) touched = true;
        }
    };
    walk(voiceRoot);
    assert.equal(touched, false);
});

test("DOCS: adoption + capability map ada dan membahas boundary wajib", () => {
    const adoption = fs.readFileSync(path.join(REPO_ROOT, "docs", "architecture", "MATA-DEWA-GODS-EYE-ADOPTION.md"), "utf8");
    for (const must of ["KEEP", "ADAPT", "REPLACE", "REMOVE", "Bilawal Sidhu",
        "mapStackController", "gevRealtime", "MIT"]) {
        assert.ok(adoption.includes(must), `adoption doc kehilangan ${must}`);
    }
    const capMap = fs.readFileSync(path.join(REPO_ROOT, "docs", "architecture", "MATA-DEWA-CAPABILITY-MAP.md"), "utf8");
    for (const must of ["governed", "mata_dewa.watch.create", "Manager", "readonly"]) {
        assert.ok(capMap.includes(must), `capability map kehilangan ${must}`);
    }
});

test("ROUTES: mata-dewa API terdaftar di console router dengan gating benar", () => {
    const routesSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "routes", "api", "v1", "console.js"), "utf8");
    // Read-only endpoints tanpa managerOnly.
    assert.match(routesSrc, /router\.get\("\/matadewa\/status", mataDewaController\.status\)/);
    assert.match(routesSrc, /router\.post\("\/matadewa\/ask", mataDewaController\.ask\)/);
    // Mutating endpoints WAJIB managerOnly.
    assert.match(routesSrc, /mataDewaManagerOnly, mataDewaController\.activate\)/);
    assert.match(routesSrc, /mataDewaManagerOnly, mataDewaController\.setCredential\)/);
    assert.match(routesSrc, /mataDewaManagerOnly, mataDewaController\.removeCredential\)/);
});

test("LIFECYCLE: no new public listener in production boot path", () => {
    const serverSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "server.js"), "utf8");
    // Mata Dewa boot hanya getService+register+start — tidak ada listen kedua.
    const mataDewaBoot = serverSrc.match(/Mata Dewa[^]*?catch \(error\)[^]*?\}/);
    assert.ok(mataDewaBoot, "boot Mata Dewa harus ada di server.js");
    assert.equal(/listen\(/.test(mataDewaBoot[0]), false);
    assert.match(serverSrc, /mataDewa\.getService\(\{\s*credentialsFilePath/);
    // Shutdown memanggil shutdown Mata Dewa (MD-008: tanpa chained call
    // pada getter publik — instance diambil sekali lewat komposisi tersegel).
    assert.match(serverSrc, /mdInstance\.shutdown\(\)/);
});
