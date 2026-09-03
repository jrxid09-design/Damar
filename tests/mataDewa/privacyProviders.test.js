/**
 * Sertifikasi Lane 5 — PRIVACY REGRESSION & PROVIDER.
 *
 * Hukum keras: TIDAK ADA data menara PLN UPT Bogor (URL My Maps privat,
 * koordinat nyata, nama situs) di git/source/tests/fixtures/docs.
 * Repo hanya memuat fixture SINTETIS.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { ProviderRegistry, PROVIDER_STATE } = require("../../src/mataDewa/registry/providerRegistry");
const { fetchText, isPrivateIp } = require("../../src/mataDewa/providers/http");
const { MataDewaCredentialStore } = require("../../src/mataDewa/credentials");

const REPO_ROOT = path.join(__dirname, "..", "..");
const NOW = 1759500000000;

test("PRIVACY: private data paths di-ignore (.gitignore)", () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    for (const pattern of ["private-data/", "local-data/private/", "*.private.kml",
        "*.private.kmz", "*.private.csv", "*.private.geojson", ".mata-dewa-cache/",
        "data/mataDewa/"]) {
        assert.ok(gitignore.includes(pattern), `.gitignore harus memuat ${pattern}`);
    }
});

test("PRIVACY: tidak ada URL My Maps privat di tracked files", () => {
    // Google My Maps URL pattern — scan seluruh tracked file.
    const tracked = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" })
        .split("\n").filter(Boolean);
    const offenders = [];
    for (const file of tracked) {
        const full = path.join(REPO_ROOT, file);
        let content = "";
        try {
            const stat = fs.statSync(full);
            if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
            content = fs.readFileSync(full, "utf8");
        }
        catch { continue; }
        // My Maps publik/privat URL pattern
        if (/maps\.my\.mymaps|google\.com\/maps\/d\/(edit|viewer)/i.test(content)) {
            offenders.push(file);
        }
    }
    assert.deepEqual(offenders, []);
});

test("PRIVACY: tidak ada koordinat menara privat — hanya fixture sintetis", () => {
    // Fixture sintetis di-rename eksplisit "(synthetic)" dan tunduk pada id SYN-.
    const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "synthetic-towers.csv"), "utf8");
    assert.ok(fixture.includes("(synthetic)"));
    const tracked = execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    // Tidak ada file fixture menara lain di luar synthetic-towers.csv
    const towerFixtures = tracked.filter(f =>
        /tower|menara/i.test(f) && !f.includes("synthetic") &&
        /\.(csv|kml|kmz|geojson|json)$/i.test(f));
    assert.deepEqual(towerFixtures, []);
});

test("PRIVACY: kredensial tidak pernah muncul di SecretRef string / persist", async () => {
    const store = new MataDewaCredentialStore({});
    const secret = "SUPER-SECRET-VALUE-xyz";
    store.setCredential("firms", secret);
    // Ref opaque.
    assert.equal(store.refs.get("firms").includes(secret), false);
    // Persist memori tidak menyimpan nilai.
    const persisted = JSON.stringify(Object.fromEntries(store.refs));
    assert.equal(persisted.includes(secret), false);
});

test("PRIVACY: scrub — tidak ada method store yang mengekspos nilai dalam list/dump", async () => {
    const store = new MataDewaCredentialStore({});
    store.setCredential("firms", "SECRET-123");
    const dump = JSON.stringify({ list: store.listProviderIds(), has: store.hasCredential("firms") });
    assert.equal(dump.includes("SECRET-123"), false);
});

test("HTTP: private/loopback host ditolak (SSRF guard)", async () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("10.0.0.5"), true);
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("172.16.0.9"), true);
    assert.equal(isPrivateIp("169.254.1.1"), true);
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("fd00::1"), true);
    assert.equal(isPrivateIp("8.8.8.8"), false);
    await assert.rejects(() => fetchText("http://127.0.0.1:9/x"), /privat|loopback|ditolak/);
    await assert.rejects(() => fetchText("http://192.168.1.1/admin"), /privat|loopback|ditolak/);
    await assert.rejects(() => fetchText("http://[::1]:9/x"), /privat|loopback|ditolak/);
});

test("PROVIDER: registry — timeout/malformed/stale ditangani sebagai failureReason", async () => {
    const registry = new ProviderRegistry({ clock: { nowMs: () => NOW } });
    registry.registerProvider({
        id: "timeout-pr", types: ["x"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => { await new Promise((_, reject) => setTimeout(() => reject(new Error("timeout setelah 1ms")), 1)); }
    });
    registry.registerProvider({
        id: "malformed-pr", types: ["x"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => { throw new Error("respons malformed (bukan JSON)"); }
    });
    registry.registerProvider({
        id: "bad-geo-pr", types: ["x"], accessMode: "PUBLIC_NO_KEY",
        // Observasi tak valid → difilter, provider tetap available.
        poll: async () => [{ type: "x", geometry: { type: "point", lat: 999, lon: 0 }, observedAt: NOW }]
    });
    const r1 = await registry.pollProvider("timeout-pr");
    assert.equal(r1.ok, false);
    assert.match(r1.failureReason, /timeout/);
    const r2 = await registry.pollProvider("malformed-pr");
    assert.equal(r2.ok, false);
    assert.match(r2.failureReason, /malformed/);
    const r3 = await registry.pollProvider("bad-geo-pr");
    assert.equal(r3.ok, true);
    assert.equal(r3.observations.length, 0); // observasi invalid dibuang
    // Kegagalan berulang → unavailable.
    await registry.pollProvider("timeout-pr");
    assert.equal(registry.getProvider("timeout-pr").state, PROVIDER_STATE.UNAVAILABLE);
});

test("PROVIDER: attribution & license terdeklarasi di setiap provider baseline", () => {
    const { registerKeylessProviders } = require("../../src/mataDewa/providers");
    const registry = new ProviderRegistry({ clock: { nowMs: () => NOW } });
    const fakeService = { registry, registerProvider: (d) => registry.registerProvider(d) };
    registerKeylessProviders(fakeService);
    for (const desc of registry.listProviders()) {
        assert.ok(desc.attribution, `${desc.id} butuh attribution`);
        assert.ok(desc.license, `${desc.id} butuh license`);
    }
    // Kelas akses keyless = PUBLIC.
    for (const desc of registry.listProviders()) {
        assert.equal(desc.accessClass, "PUBLIC");
        assert.equal(desc.requiresCredential, false);
    }
});

test("PROVIDER: fallback chain terdeklarasi (opensky → adsb.lol)", () => {
    const { createOpenSkyProvider } = require("../../src/mataDewa/providers/keyed");
    const opensky = createOpenSkyProvider();
    assert.deepEqual(opensky.fallbacks, ["adsb-lol-flights"]);
});
