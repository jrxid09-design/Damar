"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Mechanical structural guards (R23 / R24).
 *
 * These scans are deliberately crude: they assert the ABSENCE of tokens
 * that must never appear in Recovery sources. Recovery is a recovery
 * substrate only — it can never grant authority and never actuate.
 */

const RECOVERY_SRC = path.join(__dirname, "..", "..", "src", "runtime", "recovery");

function recoverySources() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith(".js")) {
                out.push({ file: entry.name, text: fs.readFileSync(full, "utf8") });
            }
        }
    };
    walk(RECOVERY_SRC);
    return out;
}

const ZERO_AUTHORITY_FORBIDDEN = [
    /CapabilityGrant/,
    /grantAuthority/,
    /granted\s*:\s*true/,
    /role\s*:\s*["'`]system["'`]/,
    /[Ss]uperadmin/,
    /ratif(y|ication)\s*\(/,
    /ownerApproval\s*=\s*true/,
    /elevatePrivileges/
];

const ZERO_ACTUATION_FORBIDDEN = [
    /child_process/,
    /\bexec(Sync)?\b/,
    /\bspawn(Sync)?\b/,
    /process\.kill\b/,
    /process\.exit\(/,
    /robotjs|nut-js|@jitsi[^\s]*keyboard/,
    /homeassistant|HomeAssistant/,
    /\badb\s+shell/,
    /os\.shutdown|shutdown\s+-[hr]|Restart-Computer/,
    /puppeteer|playwright|selenium/i,
    /\.click\(|\.type\(|keyTap|mouseTap/
];

test("zero authority guard (real): sources contain no forbidden authority tokens", () => {
    const violations = [];
    for (const { file, text } of recoverySources()) {
        for (const pattern of ZERO_AUTHORITY_FORBIDDEN) {
            if (pattern.test(text)) {
                violations.push(`${file}: ${pattern}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test("zero actuation guard: sources contain no forbidden actuation tokens", () => {
    const violations = [];
    for (const { file, text } of recoverySources()) {
        for (const pattern of ZERO_ACTUATION_FORBIDDEN) {
            if (pattern.test(text)) {
                violations.push(`${file}: ${pattern}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test("guard self-test: the scanner would catch a violation (no false green)", () => {
    const fakeSource = [{ file: "<synthetic>", text: "const x = require('child_process'); process.kill(pid);" }];
    const caught = [];
    for (const { text } of fakeSource) {
        for (const pattern of ZERO_ACTUATION_FORBIDDEN) {
            if (pattern.test(text)) {
                caught.push(pattern);
            }
        }
    }
    assert.ok(caught.length >= 2, "scanner must detect injected violations");
});
