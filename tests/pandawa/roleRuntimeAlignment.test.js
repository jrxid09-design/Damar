"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../../src/services/pandawaIdentity");
const agentHub = require("../../src/services/agentHub");
const agentTools = require("../../src/agent/agentTools");
const orchestrator = require("../../src/services/orchestrator");
const GoalEngine = require("../../src/autonomy/GoalEngine");
const projectEngine = require("../../src/lab/ProjectEngine");

/**
 * RC-03 — executable role semantics must be aligned for ALL five Pandawa
 * across: canonical profile, AgentHub prompt, AgentTools selection, and
 * Orchestrator routing metadata. ROLE != AUTHORITY everywhere.
 */

const AGENTS = ["puntadewa", "werkudara", "janaka", "nakula", "sadewa"];

// Tool specialization MARKERS (ownership-defining) vs shared generic tools.
const MARKERS = {
    puntadewa: { include: ["code_plan", "world_describe", "memory_recall"], exclude: ["code_commit", "opencode_run", "osint_investigate"] },
    werkudara: { include: ["osint_breach", "terminal_run", "code_diagnostics"], exclude: ["code_commit", "opencode_run"] },
    janaka: { include: ["opencode_run", "code_test", "code_commit", "code_definition"], exclude: ["osint_investigate", "osint_email", "browse"] },
    nakula: { include: ["describe_image", "see_camera", "photos_summary"], exclude: ["opencode_run", "code_commit", "code_test"] },
    sadewa: { include: ["osint_investigate", "browse", "memory_documents"], exclude: ["opencode_run", "code_commit", "see_camera"] }
};

// Generic tools shared by everyone are NOT ownership-defining.
const GENERIC = new Set(["readFile", "listDirectory", "system_health", "memory_recall", "memory_related", "memory_documents"]);

test("RC-03: canonical profile exists for all five and carries no authority", () => {
    for (const id of AGENTS) {
        const profile = identity.roleProfile(`pandawa:${id}`);
        assert.ok(profile, `${id} must have a canonical profile`);
        assert.ok(Array.isArray(profile.domains) && profile.domains.length >= 3);
        assert.equal(profile.capabilityGrant, undefined);
        assert.equal(profile.authority, undefined);
    }
});

test("RC-03: AgentHub prompts project the canonical owner for all five", () => {
    for (const id of AGENTS) {
        const agent = agentHub.get(id);
        const profile = identity.roleProfile(`pandawa:${id}`);
        assert.ok(agent, `${id} registered`);
        assert.equal(agent.entityId, `pandawa:${id}`);
        assert.equal(agent.role, profile.mandate, `${id} prompt derived from canonical owner`);
        assert.equal(agent.description, profile.description);
        assert.equal("authority" in agent, false);
        assert.equal(agent.capabilityGrant, undefined);
    }
});

test("RC-03: AgentTools specialization matches canonical domains for all five", () => {
    for (const id of AGENTS) {
        const profile = agentTools.profileFor(id);
        assert.ok(profile.length > 0, `${id} has a tool profile`);
        const { include, exclude } = MARKERS[id];
        for (const tool of include) {
            assert.ok(profile.includes(tool), `${id} profile must include specialization tool ${tool}`);
        }
        for (const tool of exclude) {
            assert.ok(!profile.includes(tool), `${id} profile must NOT include ownership-defining tool ${tool}`);
        }
    }
});

test("RC-03: legacy ownership is absent from AgentTools executable profiles", () => {
    // Janaka is engineering — NOT the legacy research/OSINT owner.
    assert.ok(agentTools.profileFor("janaka").every(t => !/^osint_/.test(t) && t !== "browse"));
    // Nakula is data/analytics — NOT the legacy engineering owner.
    assert.ok(agentTools.profileFor("nakula").every(t => !/^code_/.test(t) && t !== "opencode_run"));
    // Sadewa is research/evidence — NOT the legacy memory-management owner.
    assert.ok(agentTools.profileFor("sadewa").every(t => !["memory_remember", "memory_forget", "build_remember", "build_recall"].includes(t)));
    // Shared generic tools may appear anywhere without defining ownership.
    assert.ok(agentTools.profileFor("sadewa").includes("memory_recall"), "generic memory recall is not ownership-defining");
});

test("RC-03: toolsForWorker resolves real registry tools per specialization", () => {
    const registry = [
        { name: "filesystem__readFile" }, { name: "filesystem__listDirectory" }, { name: "filesystem__writeFile" },
        { name: "code__code_test" }, { name: "code__code_commit" }, { name: "code__code_plan" },
        { name: "opencode__opencode_run" }, { name: "osint__osint_investigate" },
        { name: "vision__see_camera" }, { name: "vision__describe_image" },
        { name: "memory__memory_recall" }
    ];
    const janaka = agentTools.toolsForWorker(registry, "janaka").map(t => t.name);
    assert.ok(janaka.includes("code__code_test"));
    assert.ok(janaka.includes("opencode__opencode_run"));
    assert.ok(!janaka.includes("osint__osint_investigate"));
    const nakula = agentTools.toolsForWorker(registry, "nakula").map(t => t.name);
    assert.ok(nakula.includes("vision__describe_image"));
    assert.ok(!nakula.includes("code__code_commit"));
    const sadewa = agentTools.toolsForWorker(registry, "sadewa").map(t => t.name);
    assert.ok(sadewa.includes("osint__osint_investigate"));
});

test("RC-03: Orchestrator routing metadata derives from canonical profiles for all five", () => {
    const line = orchestrator.pandawaRosterLine();
    for (const id of AGENTS) {
        const profile = identity.roleProfile(`pandawa:${id}`);
        assert.ok(line.includes(id), `roster must name ${id}`);
        assert.ok(line.includes(profile.description.replace(/\.$/, "")), `${id} roster entry must project canonical description`);
    }
    // Explicit legacy absence in executable routing metadata.
    const janakaLine = line.split("\n").find(l => l.includes("janaka"));
    const nakulaLine = line.split("\n").find(l => l.includes("nakula"));
    const sadewaLine = line.split("\n").find(l => l.includes("sadewa"));
    assert.doesNotMatch(janakaLine, /riset|intelijen|osint/i, "Janaka != research owner");
    assert.doesNotMatch(nakulaLine, /rekayasa|merekayasa|debugging/i, "Nakula != engineering owner");
    assert.doesNotMatch(sadewaLine, /memori|kontinuitas/i, "Sadewa != memory/continuity owner");
    assert.match(janakaLine, /arsitektur|implementasi|debugging/i);
    assert.match(nakulaLine, /data|statistik|numerik|RF|spasial/i);
    assert.match(sadewaLine, /riset|bukti|verifikasi|provenance/i);
});

test("RC-03: GoalEngine routing follows canonical roles", () => {
    assert.equal(GoalEngine.pickAgent("perbaiki bug di kode"), "janaka");
    assert.equal(GoalEngine.pickAgent("implementasikan fitur ini"), "janaka");
    assert.equal(GoalEngine.pickAgent("riset bukti untuk klaim ini"), "sadewa");
    assert.equal(GoalEngine.pickAgent("cari sumber verifikasi"), "sadewa");
    assert.equal(GoalEngine.pickAgent("analisis data statistik penjualan"), "nakula");
    assert.equal(GoalEngine.pickAgent("kamera depan mencari objek"), "nakula");
    assert.equal(GoalEngine.pickAgent("audit keamanan server"), "werkudara");
    assert.equal(GoalEngine.pickAgent("periksa infrastruktur docker"), "werkudara");
    assert.equal(GoalEngine.pickAgent("ingat preferensi ini"), "damar", "memory is Damar core, not a Pandawa ownership");
});

test("RC-03: ProjectEngine phase affinity follows canonical roles", () => {
    const { agents } = projectEngine.phases();
    assert.equal(agents.RESEARCH[0], "sadewa", "research phase is led by the canonical research role");
    assert.equal(agents.IMPLEMENTATION[0], "janaka", "implementation is led by the canonical engineering role");
    assert.equal(agents.PROTOTYPE[0], "janaka");
    assert.equal(agents.VALIDATION[0], "sadewa");
    assert.equal(agents.MAINTENANCE[0], "werkudara");
    // Explicit legacy absence: no phase is led by a stale owner.
    assert.notEqual(agents.RESEARCH[0], "janaka", "Janaka is not the research owner");
    assert.notEqual(agents.IMPLEMENTATION[0], "nakula", "Nakula is not the engineering owner");
    assert.notEqual(agents.PROTOTYPE[0], "nakula");
    assert.notEqual(agents.RELEASE[0], "nakula");
    // Identifiers remain exactly the canonical five + damar.
    const allowed = new Set(["damar", ...AGENTS]);
    for (const list of Object.values(agents)) {
        for (const agentId of list) assert.ok(allowed.has(agentId), `unknown agent ${agentId} in phase affinity`);
    }
});

test("RC-03: identities and aliases remain stable (ROLE CHANGE != ENTITY CHANGE)", () => {
    assert.equal(identity.resolve("Yudistira").id, "pandawa:puntadewa");
    assert.equal(identity.resolve("Bima").id, "pandawa:werkudara");
    assert.equal(identity.resolve("Arjuna").id, "pandawa:janaka");
    assert.equal(identity.roleProfile("Arjuna").domains.join("/"), identity.roleProfile("pandawa:janaka").domains.join("/"));
    for (const id of AGENTS) assert.equal(identity.resolve(`pandawa:${id}`).agentId, id);
});
