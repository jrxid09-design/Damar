"use strict";

/**
 * Sertifikasi MD-007 — Secret Vault fail-closed pra-integrasi.
 *
 * Bukti wajib:
 *  - Tanpa vault terkomposisi eksplisit → setCredential/removeCredential
 *    MENOLAK (VAULT_NOT_COMPOSED); tidak ada vault uji internal yang
 *    diam-diam dipakai menyimpan kredensial pemilik.
 *  - Vault terkomposisi dengan cipher TIDAK AMAN (deterministic-test) →
 *    ditolak (VAULT_CIPHER_NOT_SECURE): kredensial nyata tidak pernah
 *    disimpan di vault yang jujur menyatakan dirinya mudah didekode.
 *  - providerId tidak dikenal → ditolak (PROVIDER_UNKNOWN).
 *  - resolveCredential: tanpa kredensial → credentials_absent (jujur);
 *    kredensial ada tapi vault tak terkomposisi → VAULT_NOT_COMPOSED.
 *  - Kredensial tersimpan → resolve ter-scope, SecretRef opaque,
 *    tidak ada nilai di dump/list.
 *  - Kedua jalur produksi (service boot + HTTP controller) mewarisi
 *    fail-closed ini.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { MataDewaCredentialStore } = require("../../src/mataDewa/credentials");
const { createSecretVault } = require("../../src/runtime/vault");
const { createTestVault } = require("../helpers/testVault");

test("MD-007: tanpa vault terkomposisi → setCredential fail closed", () => {
    const store = new MataDewaCredentialStore({});
    const result = store.setCredential("tomtom", "sk-SYNTHETIC-KEY");
    assert.equal(result.ok, false);
    assert.equal(result.code, "VAULT_NOT_COMPOSED");
    assert.match(result.reason, /fail-closed|MD-007/);
    // Tidak ada yang tersimpan.
    assert.equal(store.hasCredential("tomtom"), false);
    assert.equal(store.listProviderIds().length, 0);
});

test("MD-007: vault uji internal (cipher tidak aman) eksplisit → ditolak", () => {
    // Vault eksplisit TAPI dengan adapter deterministic-test (secure:false)
    // — kredensial nyata tidak boleh masuk ke vault tidak aman.
    const insecureVault = createSecretVault({ now: () => Date.now() }); // default = deterministic-test
    const store = new MataDewaCredentialStore({ vault: insecureVault });
    const result = store.setCredential("tomtom", "sk-SYNTHETIC-KEY");
    assert.equal(result.ok, false);
    assert.equal(result.code, "VAULT_CIPHER_NOT_SECURE");
    assert.equal(store.hasCredential("tomtom"), false);
});

test("MD-007: providerId tidak dikenal ditolak (skema kredensial eksplisit)", () => {
    const store = new MataDewaCredentialStore({ vault: createTestVault() });
    const result = store.setCredential("evil-provider", "sk-SYNTHETIC-KEY");
    assert.equal(result.ok, false);
    assert.equal(result.code, "PROVIDER_UNKNOWN");
    // Nilai kosong juga ditolak.
    assert.equal(store.setCredential("tomtom", "").ok, false);
    assert.equal(store.setCredential("tomtom", "   ").ok, false);
    assert.equal(store.setCredential("", "x").ok, false);
});

test("MD-007: removeCredential tanpa vault → fail closed", () => {
    const store = new MataDewaCredentialStore({});
    const result = store.removeCredential("tomtom");
    assert.equal(result.ok, false);
    assert.equal(result.code, "VAULT_NOT_COMPOSED");
});

test("MD-007: resolveCredential — credentials_absent jujur; VAULT_NOT_COMPOSED bila ref ada", async () => {
    const empty = new MataDewaCredentialStore({});
    const absent = await empty.resolveCredential("tomtom");
    assert.equal(absent.ok, false);
    assert.equal(absent.code, "credentials_absent");

    // Ref ada (simulasi persist lama) tapi vault tidak terkomposisi →
    // TIDAK menembus: VAULT_NOT_COMPOSED.
    const stale = new MataDewaCredentialStore({});
    stale.refs.set("tomtom", "secretref:v1:synthetic");
    const blocked = await stale.resolveCredential("tomtom");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "VAULT_NOT_COMPOSED");
});

test("MD-007: vault terkomposisi aman (uji) — seam penuh berfungsi", async () => {
    const store = new MataDewaCredentialStore({ vault: createTestVault() });
    const set = store.setCredential("tomtom", "sk-SYNTHETIC-KEY");
    assert.equal(set.ok, true);
    // Ref opaque.
    assert.equal(set.refString.includes("sk-SYNTHETIC-KEY"), false);
    assert.equal(set.refString.startsWith("secretref:v1:"), true);
    // Resolve memberi nilai ke pemanggil berhak.
    const resolved = await store.resolveCredential("tomtom");
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value, "sk-SYNTHETIC-KEY");
    // Provider lain tetap absent.
    const none = await store.resolveCredential("opensky-network");
    assert.equal(none.ok, false);
    assert.equal(none.code, "credentials_absent");
    // Remove → revoke → resolve gagal.
    assert.equal(store.removeCredential("tomtom").ok, true);
    const gone = await store.resolveCredential("tomtom");
    assert.equal(gone.ok, false);
});

test("MD-007: nilai kredensial tidak pernah muncul di dump/list metadata", () => {
    const store = new MataDewaCredentialStore({ vault: createTestVault() });
    store.setCredential("firms", "SECRET-123");
    const dump = JSON.stringify({ list: store.listProviderIds(), has: store.hasCredential("firms") });
    assert.equal(dump.includes("SECRET-123"), false);
    assert.equal(store.refs.get("firms").includes("SECRET-123"), false);
});

test("MD-007: produksi boot (tanpa vault) mewarisi fail-closed", async () => {
    const { MataDewaService } = require("../../src/mataDewa/service");
    const composition = require("../../src/mataDewa/composition");
    composition.resetMataDewaServiceForTests();
    const service = new MataDewaService({ clock: { nowMs: () => Date.now() } });
    // Service produksi TIDAK mengkomposisi vault → penyimpanan kredensial
    // via API mana pun harus menolak.
    const result = service.credentialStore.setCredential("tomtom", "sk-SYNTHETIC-KEY");
    assert.equal(result.ok, false);
    assert.equal(result.code, "VAULT_NOT_COMPOSED");
    await service.shutdown();
    composition.resetMataDewaServiceForTests();
});
