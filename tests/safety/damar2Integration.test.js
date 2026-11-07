const test = require("node:test");
const assert = require("node:assert");

const svc = require("../../src/services/aiRuntimeService");
const { selectTools } = require("../../src/ai/tools/ToolSelector");

/**
 * Integrasi Damar 2.0 (kelemahan #4).
 *
 * Bukan unit lagi: menguji rantai NYATA yang dipakai runtime —
 * (1) tool empat kemampuan baru benar-benar terdaftar di nativeTools,
 * (2) ToolSelector memilihnya untuk pesan yang relevan,
 * (3) withSystemPrompt menyuntik doktrin yang cocok (kelemahan #2),
 * dan obrolan biasa tidak terbebani.
 */

const nama = svc.nativeTools().map(t => t.name);

test("tool empat kemampuan senior terdaftar di nativeTools", () => {
    for (const t of [
        "code_diff", "code_review",
        "sec_secret_scan", "sec_code_audit", "sec_dep_audit",
        "kali_run", "kali_tools", "ml_env", "ml_run"
    ]) {
        assert.ok(nama.includes(t), `tool ${t} harus terdaftar`);
    }
});

test("ToolSelector memilih tool baru untuk pesan yang relevan", () => {

    const tools = svc.nativeTools();
    // Budget cukup besar agar seluruh profil muat (inti + tambahan),
    // bukan hanya beberapa tool teratasnya.
    const namaDari = (text) => selectTools(tools, text, 40).map(t => t.name);

    assert.ok(namaDari("tolong perbaiki bug lalu commit").includes("code_review"));
    assert.ok(namaDari("audit keamanan repo, ada kerentanan?").includes("sec_secret_scan"));
    assert.ok(namaDari("jalankan nmap ke localhost").includes("kali_run"));
    assert.ok(namaDari("latih model klasifikasi dataset").some(n => n === "ml_env" || n === "ml_run"));

});

test("withSystemPrompt menyuntik doktrin sesuai topik, obrolan biasa polos", () => {

    const build = (text) => {
        const msgs = svc.withSystemPrompt([{ role: "user", content: text }]);
        return msgs.find(m => m.role === "system").content;
    };

    const koding = build("tolong perbaiki bug di fungsi login");
    assert.match(koding, /INSINYUR SENIOR/, "pesan koding harus dapat doktrin rekayasa");

    const kali = build("jalankan sqlmap ke target lab");
    assert.match(kali, /MENGUASAI ARSENALNYA/);

    const sapaan = build("hai, selamat pagi apa kabar");
    assert.doesNotMatch(sapaan, /INSINYUR SENIOR|MENGUASAI ARSENALNYA|INSINYUR KEAMANAN|PENELITI & INSINYUR ML/,
        "sapaan tidak boleh terbebani doktrin peran");

    // Base prompt tetap ada di semua kasus (identitas Damar).
    assert.match(sapaan, /Kamu adalah Damar/);

});

test("base system prompt TIDAK lagi memuat blok doktrin (anti-kembung)", () => {
    // Doktrin panjang harus hidup di prompts/doctrines.js, dimuat kondisional.
    assert.doesNotMatch(svc.systemPrompt, /INSINYUR SENIOR/);
    assert.doesNotMatch(svc.systemPrompt, /MENGUASAI ARSENALNYA/);
    assert.doesNotMatch(svc.systemPrompt, /PENELITI & INSINYUR ML SENIOR/);
});
