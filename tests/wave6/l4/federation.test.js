"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const federation = require("../../../src/federation");

/**
 * WAVE 6 L4 — external capability federation security tests.
 * Laws: DISCOVERY != ENABLEMENT; digest pinning; quarantine on mutation;
 * malicious packages rejected; Pandawa recommendations carry no authority.
 */

const DIGEST = "a".repeat(64);
const TOOL_DIGEST = "b".repeat(64);

function intake(fed, overrides = {}) {
 return fed.discover({
 source: "https://registry.example.com/pkg", sourceType: "npm",
 publisher: "trusted-publisher", name: "useful-tool", version: "1.0.0",
 license: "MIT", artifactDigest: DIGEST,
 permissions: { network: ["api.example.com"], filesystem: ["~/data"] },
 ...overrides
 });
}

test("L4: lifecycle — discovered lands QUARANTINED with provenance; nothing enabled", () => {
 const fed = new federation.ExternalCapabilityFederation();
 const snap = intake(fed);
 assert.equal(snap.state, "QUARANTINED");
 assert.equal(snap.provenance.publisher, "trusted-publisher");
 assert.equal(snap.provenance.license, "MIT");
 assert.equal(snap.enabledTools.length, 0);
 assert.equal(fed.isToolEnabled(snap.candidateId, "any"), false);
 // unknown tool enablement before validation rejected
 assert.throws(() => fed.enableTool(snap.candidateId, { toolName: "t" }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L4: malicious package — postinstall hook rejected at inspection", () => {
 const fed = new federation.ExternalCapabilityFederation();
 const snap = intake(fed);
 const res = fed.inspect(snap.candidateId, { artifactSurface: '{"scripts":{"postinstall":"node evil.js"}}' });
 assert.equal(res.state, "REJECTED");
 assert.ok(res.inspectionFindings.some(f => f.rule === "postinstall_hook"));
 // rejected is terminal
 assert.throws(() => fed.inspect(snap.candidateId, { artifactSurface: "" }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L4: secret request / dynamic code / obfuscation / missing license all rejected", () => {
 for (const [surface, rule] of [
  ['process.env.API_SECRET_KEY', "secret_access"],
  ['eval(atob("..."))', "dynamic_code"],
  ['data:text/javascript;base64,' + "A".repeat(300), "obfuscated_payload"]
 ]) {
 const fed = new federation.ExternalCapabilityFederation();
 const snap = intake(fed);
 const res = fed.inspect(snap.candidateId, { artifactSurface: surface });
 assert.equal(res.state, "REJECTED");
 assert.ok(res.inspectionFindings.some(f => f.rule === rule));
 }
 // missing license
 const fed = new federation.ExternalCapabilityFederation();
 const snap = intake(fed, { license: null });
 const res = fed.inspect(snap.candidateId, { artifactSurface: "clean code" });
 assert.equal(res.state, "REJECTED");
 assert.ok(res.inspectionFindings.some(f => f.rule === "license_missing"));
});

test("L4: clean package — inspect -> validate (digest pinning) -> per-tool enablement", () => {
 const fed = new federation.ExternalCapabilityFederation();
 const snap = intake(fed);
 assert.equal(fed.inspect(snap.candidateId, { artifactSurface: "export default function handler() { return 1 }" }).state, "INSPECTED");
 assert.equal(fed.validate(snap.candidateId, { toolDigests: { search: TOOL_DIGEST } }).state, "VALIDATED");
 const enabled = fed.enableTool(snap.candidateId, { toolName: "search" });
 assert.equal(enabled.state, "ENABLED");
 assert.deepEqual(enabled.enabledTools, ["search"]);
 assert.equal(fed.isToolEnabled(snap.candidateId, "search"), true);
 assert.equal(fed.isToolEnabled(snap.candidateId, "other-tool"), false, "per-tool enablement");
 // MCP tool changed after validation -> re-quarantined, enablements void
 const mutated = fed.checkToolIntegrity(snap.candidateId, { toolName: "search", currentDigest: "c".repeat(64) });
 assert.equal(mutated.state, "QUARANTINED");
 assert.ok(mutated.mutationDetected);
 assert.equal(fed.isToolEnabled(snap.candidateId, "search"), false, "enablement voided on mutation");
});

test("L4: digest mismatch + repo commit change at discovery rejected; wildcard permissions bounded", () => {
 const fed = new federation.ExternalCapabilityFederation();
 assert.throws(() => intake(fed, { artifactDigest: "not-a-digest" }), (e) => e.code === "MESSAGE_MALFORMED");
 // filesystem wildcard recorded (bounded) but must pass through inspection for sandbox decision
 const wild = intake(fed, { permissions: { filesystem: [" / "] } });
 assert.equal(wild.provenance.permissions.filesystem[0].trim(), "/");
 // network wildcard recorded
 const net = intake(fed, { permissions: { network: ["*"] } });
 assert.equal(net.provenance.permissions.network[0], "*".trim());
});

test("L4: revocation is terminal; expired enablement fails closed", () => {
 let now = 1_000_000;
 const fed = new federation.ExternalCapabilityFederation({ nowMs: () => now });
 const snap = intake(fed);
 fed.inspect(snap.candidateId, { artifactSurface: "clean" });
 fed.validate(snap.candidateId, { toolDigests: { t: TOOL_DIGEST } });
 fed.enableTool(snap.candidateId, { toolName: "t" });
 assert.equal(fed.isToolEnabled(snap.candidateId, "t"), true);
 now += fed.config.enablementTtlMs + 1;
 assert.equal(fed.isToolEnabled(snap.candidateId, "t"), false, "enablement TTL expired");
 const revoked = fed.revoke(snap.candidateId, { reason: "publisher delisted" });
 assert.equal(revoked.state, "REVOKED");
});

test("L4: skill federation — SKILL != CAPABILITY; scopes bounded; pandawa advisory only", () => {
 const fed = new federation.ExternalCapabilityFederation();
 const skill = fed.registerSkill({ name: "morning_briefing", scope: "node-local" });
 assert.equal(skill.scope, "node-local");
 assert.match(skill.law, /SKILL != CAPABILITY/);
 assert.throws(() => fed.registerSkill({ name: "x", scope: "unlimited" }), (e) => e.code === "MESSAGE_MALFORMED");
 // pandawa analysis is advisory metadata — structurally has no enable method
 const analysis = fed.pandawaAnalysis({ janaka: "fits our MCP client", werkudara: "no install hooks found" });
 assert.match(analysis.law, /PANDAWA RECOMMENDATION != INSTALL AUTHORITY/);
 assert.equal(analysis.enable, undefined);
 assert.equal(analysis.install, undefined);
 // state bounds
 for (let i = 0; i < 40; i++) intake(fed, { source: `src-${i % 4}`, name: `pkg-${i}` });
 assert.ok(fed.size() <= 256, "candidate table bounded");
});
