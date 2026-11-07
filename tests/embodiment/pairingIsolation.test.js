const test = require("node:test");
const assert = require("node:assert");

/**
 * STRUCTURAL AUDIT (I§8) — this file must require the identity module
 * FIRST, in its own test process. Any load of src/authority, channels,
 * database, cognition, toolbus/interactionBus, or transport during that
 * require() is a structural violation.
 */

const FORBIDDEN = [
    "/src/authority/", "\\src\\authority\\",
    "/src/channels/", "/src/database/",
    "/src/cognition/", "/src/tools", "/src/toolBus",
    "/src/interactionBus", "/src/skills",
    "homeAssistant", "node-pty"
];

const BEFORE = new Set(Object.keys(require.cache));
const emb = require("../../src/embodiment");
const AFTER = Object.keys(require.cache)
    .filter(k => !BEFORE.has(k));

test("A-1: requiring embodiment identity loads NO authority/control modules", () => {
    const loaded = AFTER.map(k => k.replaceAll("\\", "/"));
    const violations = loaded.filter(k =>
        FORBIDDEN.some(f => k.includes(f)));
    assert.deepEqual(violations, [],
        `identity layer pulled in forbidden modules: ${violations.join(", ")}`);
});

test("A-2: embodiment source never requires authority / actuation paths", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const roots = [
        path.join(__dirname, "..", "..", "src", "embodiment")
    ];
    const files = [];
    for (const root of roots) {
        (function walk(dir) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith(".js")) files.push(p);
            }
        })(root);
    }
    assert.ok(files.length >= 10, "sanity: embodiment files found");

    const forbiddenRequire = /(require\s*\(\s*["'])((?!node:|\.\.?\/)[^"']+)(["'])/g;
    const violations = [];
    for (const f of files) {
        // strip block + line comments: docblocks legitimately contain
        // usage examples like require(".../embodiment")
        const src = fs.readFileSync(f, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        let m;
        while ((m = forbiddenRequire.exec(src)) !== null) {
            const spec = m[2];
            if (!spec.startsWith("./") && !spec.startsWith("../")) {
                violations.push(`${path.basename(f)}: '${spec}'`);
            }
        }
        if (/require\([^)]*authority|from\s+["'][^"']*authority/i.test(src.replace(/\/\/[^\n]*/g, ""))) {
            violations.push(`${path.basename(f)}: authority reference`);
        }
    }
    assert.deepEqual(violations, [], violations.join("; "));
});

test("A-3: pairing lifecycle performs ZERO Authority mutation (observable)", () => {
    // The strongest available proof in-process: the module graph above
    // contains no authority code, therefore no authority object exists
    // to mutate. Additionally, no public API returns anything shaped
    // like a grant/capability token.
    const clock = emb.manualClock(1);
    const svc = emb.createIdentityService({ clock });
    const { deviceId } = svc.registerIdentity({ namespace: "a", stableKey: "z" });
    const p = svc.beginPairing(deviceId);
    svc.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId,
        secret: p.challenge.secret
    });
    const confirmed = svc.ownerConfirm(p.pairingId);

    const returned = JSON.stringify(confirmed);
    for (const banned of ["grant", "ratify", "authorize", "capabilityToken",
        "permission", "allowedTools"]) {
        assert.ok(!returned.toLowerCase().includes(banned.toLowerCase()),
            `confirm result must not carry authority-shaped field: ${banned}`);
    }

    // public surface has no execution verbs
    const api = Object.getOwnPropertyNames(Object.getPrototypeOf(svc))
        .filter(n => n[0] !== "_");
    for (const bannedVerb of ["execute", "actuate", "capture", "startCapture",
        "readCamera", "pressKey", "moveMouse", "sendCommand"]) {
        assert.ok(!api.some(a => a.toLowerCase().includes(bannedVerb.toLowerCase())),
            `forbidden verb on identity API: ${bannedVerb}`);
    }
});
