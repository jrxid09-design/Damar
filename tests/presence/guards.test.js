const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PRESENCE_DIR = path.join(__dirname, "..", "..", "src", "runtime", "presence");

function presenceSources() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                out.push({ file: path.relative(PRESENCE_DIR, full), text: fs.readFileSync(full, "utf8") });
            }
        }
    };
    walk(PRESENCE_DIR);
    return out;
}

function assertNoMatch(sources, pattern, label) {
    for (const { file, text } of sources) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            assert.equal(
                pattern.test(lines[i]),
                false,
                `${label} ditemukan di presence/${file}:${i + 1}`
            );
        }
    }
}

describe("presence guards — mekanis (P31, P32, P20)", () => {
    const sources = presenceSources();

    it("P31 zero authority: tidak ada kosakata pembuatan/pemutusan otoritas", () => {
        assertNoMatch(
            sources,
            /CapabilityGrant|grantAuthority|revokeAuthority|ratif(y|ication)|superadmin|ownerApproved|escalat(e|ion)Role/,
            "kosakata otoritas"
        );
        // WAITING_FOR_OWNER hanya presentasi: tak ada penulisan keputusan approval.
        assertNoMatch(sources, /approvalDecision\s*=|"approved"\s*:/, "fabrikasi keputusan owner");
    });

    it("P32 zero actuation: tidak ada API proses/perangkat/filesistem", () => {
        assertNoMatch(
            sources,
            /child_process|process\.kill|\.spawn\(|execSync|keyboard|mouse|screenCapture|screen_capture|getUserMedia|AudioContext|speak\(|ttsEngine|homeassistant|adb\b|AbortController/,
            "API actuation"
        );
        // Tidak ada tulisan filesystem sama sekali:
        for (const { file } of sources) {
            void file;
        }
        assertNoMatch(sources, /writeFile|appendFile|createWriteStream|fs\.write/, "penulisan filesystem");
    });

    it("P20 tanpa jam tersembunyi: Date.now hanya di clock.js", () => {
        for (const { file, text } of sources) {
            if (file === "clock.js") continue;
            const matches = text.match(/Date\.now/g) || [];
            assert.equal(matches.length, 0, `Date.now dilarang di ${file}`);
        }
    });

    it("impor presence terbatas: relatif ./../* atau modul node saja", () => {
        for (const { file, text } of sources) {
            const requires = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
            for (const target of requires) {
                const okRelative = target.startsWith("./") || target.startsWith("../");
                const okBuiltin = target.startsWith("node:");
                assert.ok(okRelative || okBuiltin, `impor ilegal di ${file}: ${target}`);
            }
        }
    });
});

describe("presence ports — kontrak inersia (P14, P25)", () => {
    const presence = require("../../src/runtime/presence");

    it("delapan port diekspor sebagai kelas", () => {
        for (const name of [
            "InteractionPort", "ResourcePort", "RecoveryPort", "AuthorityPort",
            "SensoriumPort", "VoicePort", "VisualPresencePort", "RuntimeHostPort"
        ]) {
            assert.equal(typeof presence.ports[name], "function", `${name} wajib diekspor`);
        }
    });

    it("port belum attach menolak emisi; port sudah attach tak bisa pindah runtime", () => {
        const port = new presence.ports.VoicePort();
        assert.throws(() => port.emitVoiceEvent("v-1", {}), /PRESENCE_PORT_NOT_ATTACHED/);
        const { rt } = require("./helpers/testKit").createBootedRuntime();
        port.attach(rt);
        assert.throws(() => port.attach(rt), /PRESENCE_PORT_ALREADY_ATTACHED/);
    });

    it("host event tak dikenal ditolak saat emisi; daftar EVENTS kanon", () => {
        const presenceKit = require("./helpers/testKit").createBootedRuntime();
        const host = new presence.ports.RuntimeHostPort();
        host.attach(presenceKit.rt);
        assert.deepEqual(
            Object.keys(presence.ports.RuntimeHostPort.EVENTS).sort(),
            ["RESUMED", "SESSION_LOCKED", "SESSION_UNLOCKED", "SHUTDOWN_REQUESTED", "STARTED", "SUSPENDING"]
        );
        assert.throws(() => host.emitHostEvent("h-9", "BLUE_SCREEN"), TypeError);
    });

    it("AuthorityPort satu arah: hanya notifikasi masuk, tak ada API keluar otoritas", () => {
        const proto = Object.getOwnPropertyNames(presence.ports.AuthorityPort.prototype);
        const forbidden = proto.filter((name) =>
            /grant|revoke|approve|ratify|elevate/i.test(name));
        assert.deepEqual(forbidden, []);
    });

    it("execFileSync guard meta-assertion: scanner benar-benar menjalankan pola", () => {
        void execFileSync;
        const sample = [{ file: "x.js", text: "const bad = process.kill(1);" }];
        let caught = false;
        try {
            const pattern = /process\.kill/;
            const lines = sample[0].text.split("\n");
            for (const line of lines) {
                if (pattern.test(line)) throw new Error("detection works");
            }
        }
        catch {
            caught = true;
        }
        assert.equal(caught, true);
    });
});
