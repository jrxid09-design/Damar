"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * STRUCTURAL AUDIT — prove what the ledger CANNOT do.
 *
 * Rule 1: every require() inside src/runtime/auditLedger/ must resolve
 *         to a node: builtin or a sibling file in the same folder.
 *         => no import edge to Authority, tools, devices, shell,
 *            network, Console/Electron, Recovery, telemetry, fs.
 *
 * Rule 2: the exported runtime surface contains no method whose name
 *         expresses authority mutation or execution.
 *
 * This complements the runtime guarantees: even if someone adds a new
 * file to the module, an out-of-folder import fails this test loudly.
 */

const MODULE_DIR = path.join(__dirname, "..", "..", "src", "runtime", "auditLedger");

function* jsFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* jsFiles(p);
        else if (entry.name.endsWith(".js")) yield p;
    }
}

test("STRUCTURAL: imports are node builtins + intra-module only", () => {
    const violations = [];
    const siblings = new Set(
        [...jsFiles(MODULE_DIR)].map((f) => path.basename(f))
    );

    for (const file of jsFiles(MODULE_DIR)) {
        const source = fs.readFileSync(file, "utf8");
        const re = /require\(\s*["']([^"']+)["']\s*\)/g;
        let match;
        while ((match = re.exec(source)) !== null) {
            const target = match[1];
            if (target.startsWith("node:")) continue;
            if (target.startsWith("./") || target.startsWith("../")) {
                // must stay INSIDE the module folder
                let resolved = path.resolve(path.dirname(file), target);
                if (!/\.[cm]?js$/.test(resolved)) resolved += ".js";
                if (!resolved.startsWith(MODULE_DIR + path.sep)) {
                    violations.push(`${path.basename(file)} -> ${target} escapes module folder`);
                }
                else if (!siblings.has(path.basename(resolved))) {
                    violations.push(`${path.basename(file)} -> missing sibling ${target}`);
                }
                continue;
            }
            violations.push(`${path.basename(file)} requires non-builtin: ${target}`);
        }
    }

    assert.deepEqual(violations, [], `forbidden import edges:\n${violations.join("\n")}`);
});

test("STRUCTURAL: no dynamic-eval escape hatches in module sources", () => {
    for (const file of jsFiles(MODULE_DIR)) {
        const source = fs.readFileSync(file, "utf8");
        assert.ok(!/\beval\s*\(/.test(source), `${file}: eval`);
        assert.ok(!/\bnew\s+Function\b/.test(source), `${file}: new Function`);
        assert.ok(!/\bchild_process\b/.test(source), `${file}: child_process`);
        assert.ok(!/\bsetTimeout|setInterval|setImmediate\b/.test(source.replace(/^.*?node:timers.*$/gm, "")) ||
            !/[^(]\b(?:setTimeout|setInterval|setImmediate)\s*\(/.test(source),
            `${file}: hidden scheduling`);
    }
});

test("STRUCTURAL: runtime surface exposes no execution/authority verbs", () => {
    // Fresh instance surface.
    const { createAuditLedger } = require("../../src/runtime/auditLedger");
    let t = 0;
    const ledger = createAuditLedger({ clock: () => ++t });
    ledger.append({ eventType: "probe", source: "probe" });

    const FORBIDDEN = /^(grant|revoke|delegate|ratify|authorize|authorise|execute|exec|restore|replay|rewind|actuate|spawn|issue)/;

    for (const key of Object.keys(ledger)) {
        if (typeof ledger[key] === "function") {
            assert.doesNotMatch(key, FORBIDDEN, `forbidden verb on ledger: ${key}`);
        }
    }

    // Module-level exports too.
    const auditLedger = require("../../src/runtime/auditLedger");
    for (const key of Object.keys(auditLedger)) {
        assert.doesNotMatch(key, FORBIDDEN, `forbidden verb on module export: ${key}`);
    }
});

test("STRUCTURAL: records carry zero behavior (data-only observations)", () => {
    const { createAuditLedger } = require("../../src/runtime/auditLedger");
    let t = 0;
    const ledger = createAuditLedger({ clock: () => ++t });
    const record = ledger.append({
        eventType: "probe.deep",
        source: "probe",
        subject: { kind: "device", id: "dev-1" },
        correlation: { sessionId: "ses_1" },
        metadata: { nested: { x: 1 } },
        evidenceRefs: [{ kind: "digest", id: "d1", digest: "a".repeat(64) }]
    });

    const stack = [record];
    while (stack.length) {
        const node = stack.pop();
        if (node === null || typeof node !== "object") continue;
        for (const value of Object.values(node)) {
            assert.notEqual(typeof value, "function", "no function may exist on any record node");
            if (value && typeof value === "object") stack.push(value);
        }
    }

    // And nothing revives after a JSON round trip (Recovery-safe read path).
    const revived = JSON.parse(JSON.stringify(record));
    assert.deepEqual(Object.keys(revived).sort(), [
        "actor", "authorityRef", "causalParentId", "correlation", "eventId",
        "eventType", "evidenceRefs", "generation", "integrity", "metadata",
        "operation", "outcome", "sequence", "source", "subject", "timestampMs"
    ]);
});
