"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");

test("NAS, usage, and backup notifications converge on notifyService", () => {
    const sources = [
        fs.readFileSync(path.join(ROOT, "src/services/nasMonitorService.js"), "utf8"),
        fs.readFileSync(path.join(ROOT, "src/services/usageService.js"), "utf8"),
        fs.readFileSync(path.join(ROOT, "src/services/backupService.js"), "utf8")
    ];
    for (const source of sources) {
        assert.match(source, /notifyService|notify\.send/);
        assert.doesNotMatch(source, /whatsappService\.broadcast|\.broadcast\(/);
    }
});

test("notifyService cannot grant authority and has no direct WhatsApp transport import", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/services/notifyService.js"), "utf8");
    assert.doesNotMatch(source, /require\(["']\.\/whatsappService["']\)/);
    assert.match(source, /submitGovernedService/);
    assert.match(source, /messaging\.whatsapp/);
    assert.match(source, /expectedPostcondition/);
});

test("missing autonomous notification authority produces no external send", async () => {
    const whatsapp = require("../../src/services/whatsappService");
    const original = whatsapp.broadcastWithEvidence;
    let invoked = 0;
    whatsapp.broadcastWithEvidence = async () => { invoked++; return { recipients: 1, messageIds: ["unexpected"], errors: [] }; };
    try {
        const result = await require("../../src/services/notifyService").send("backup failed");
        assert.equal(result.sent, 0);
        assert.notEqual(result.outcome, "COMPLETED");
        assert.equal(invoked, 0);
    }
    finally {
        whatsapp.broadcastWithEvidence = original;
    }
});

test("canonical notification capability is registered with a bounded scope and verifier", () => {
    const wiring = require("../../src/action/capabilities/embodimentWiring");
    assert.equal(wiring.NOTIFICATION, "messaging.whatsapp");
    assert.deepEqual(wiring.NOTIFICATION_OPS, ["broadcast"]);
    assert.ok(wiring.DESCRIPTORS.some(d => d.id === wiring.NOTIFICATION));
    const { createCanonicalActionFacade } = require("../../src/action/bootstrap");
    const intent = createCanonicalActionFacade().admit(JSON.stringify({
        schemaVersion: 1,
        capabilityId: "messaging.whatsapp",
        operation: "broadcast",
        arguments: { text: "NAS warning" }
    }));
    assert.deepEqual(intent.scope.slice(0, 1), ["channel:whatsapp"]);
    assert.match(intent.scope[1], /^text-sha256:/);
});

test("valid standing canonical authority permits autonomous send without interactive approval", async () => {
    const { CanonicalCapabilityExecution, OUTCOME } = require("../../src/manager/internal/canonicalCapabilityExecution");
    const { loadAndEvaluateAuthority } = require("../../src/authority/evaluate");
    const calls = [];
    const audit = [];
    const capabilityId = "messaging.whatsapp";
    const store = {
        getCapability: async id => id === capabilityId ? {
            status: "ACTIVE", generation: 0,
            payload: { subject: "owner", capabilityId, kind: "root", actions: ["execute"], scope: [], restrictions: { kind: "unrestricted" }, maxExecutions: null, identityBinding: null, notBefore: null, expiresAt: null, issuedAt: new Date().toISOString() }
        } : null,
        getGeneration: async () => 0,
        countConsumption: async () => 0
    };
    const evaluation = await loadAndEvaluateAuthority(store, { capabilityId, action: "execute", identity: { principal: "owner" } });
    const bridge = new CanonicalCapabilityExecution({ replayStore: require("../helpers/rollbackSubstrate").createRollbackResistantLedger() });
    bridge.registerCapability({ capabilityId, operation: "broadcast", driver: async ({ parameters }) => { calls.push(parameters); return { channel: "whatsapp", messageIds: ["m1"], errors: [], recipients: 1 }; } });
    bridge.registerVerifier(capabilityId, async () => ({ checks: [{ name: "message id", passed: true }] }));
    bridge.installAuditAcknowledger(entry => { audit.push({ phase: "audit", verificationState: entry.verificationState }); return { ok: true, receipt: "ack-1" }; });
    const result = await bridge.execute({ capabilityId, operation: "broadcast", parameters: { text: "backup failed" }, evaluation });
    assert.equal(result.outcome, OUTCOME.EXECUTED_VERIFIED);
    assert.equal(calls.length, 1);
    assert.deepEqual(audit, [{ phase: "audit", verificationState: "verified" }]);
});

test("notification verification failure cannot become verified success", async () => {
    const { CanonicalCapabilityExecution, OUTCOME } = require("../../src/manager/internal/canonicalCapabilityExecution");
    const { loadAndEvaluateAuthority } = require("../../src/authority/evaluate");
    const capabilityId = "messaging.whatsapp";
    const store = { getCapability: async id => id === capabilityId ? { status: "ACTIVE", generation: 0, payload: { subject: "owner", capabilityId, kind: "root", actions: ["execute"], scope: [], restrictions: { kind: "unrestricted" }, maxExecutions: null, identityBinding: null, notBefore: null, expiresAt: null, issuedAt: new Date().toISOString() } } : null, getGeneration: async () => 0, countConsumption: async () => 0 };
    const evaluation = await loadAndEvaluateAuthority(store, { capabilityId, action: "execute", identity: { principal: "owner" } });
    const bridge = new CanonicalCapabilityExecution({ replayStore: require("../helpers/rollbackSubstrate").createRollbackResistantLedger() });
    bridge.registerCapability({ capabilityId, operation: "broadcast", driver: async () => ({ channel: "whatsapp", messageIds: [], errors: ["transport unavailable"], recipients: 1 }) });
    bridge.registerVerifier(capabilityId, async () => ({ checks: [{ name: "message id", passed: false }] }));
    bridge.installAuditAcknowledger(() => ({ ok: true, receipt: "ack-2" }));
    const result = await bridge.execute({ capabilityId, operation: "broadcast", parameters: { text: "x" }, evaluation });
    assert.equal(result.outcome, OUTCOME.UNVERIFIED);
    assert.notEqual(result.outcome, OUTCOME.EXECUTED_VERIFIED);
});

test("WhatsApp transport evidence is explicit and remains below authority", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/services/whatsappService.js"), "utf8");
    assert.match(source, /broadcastWithEvidence/);
    assert.match(source, /messageIds/);
    assert.doesNotMatch(source, /authority|authorize|grant/i);
});
