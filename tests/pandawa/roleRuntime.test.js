"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../../src/services/pandawaIdentity");
const agentHub = require("../../src/services/agentHub");

/**
 * F-05 tests: executable runtime role semantics match the canonical
 * Lane 6 role profile for all five Pandawa. Identity (IDs/aliases)
 * is unchanged — ROLE CHANGE != ENTITY CHANGE.
 */

const CANONICAL_DOMAINS = {
    "pandawa:puntadewa": { include: /strategi|sintesis|arbitrase|perencanaan/i, legacy: /tata kelola|penilaian keputusan/i },
    "pandawa:werkudara": { include: /keamanan|infrastruktur|resiliensi|adversarial/i, legacy: /pertahanan/i },
    "pandawa:janaka": { include: /rekayasa|koding|arsitektur|implementasi|debugging/i, legacy: /riset|intelijen|osint/i },
    "pandawa:nakula": { include: /data|statistik|numerik|RF|spasial/i, legacy: /rekayasa|merekayasa|debugging|refactor/i },
    "pandawa:sadewa": { include: /riset|bukti|verifikasi|provenance/i, legacy: /memori|kontinuitas/i }
};

test("F-05: canonical role profile is the single source of truth in pandawaIdentity", () => {
    for (const record of identity.records()) {
        const profile = identity.roleProfile(record.id);
        assert.ok(profile, `${record.id} must expose a canonical role profile`);
        assert.ok(Array.isArray(profile.domains) && profile.domains.length >= 3);
        assert.equal(profile.capabilityGrant, undefined, "role metadata must never be authority-bearing");
        assert.equal(profile.authority, undefined, "role metadata must never be authority-bearing");
    }
    assert.deepEqual(identity.roleProfile("Arjuna").domains, identity.roleProfile("pandawa:janaka").domains, "aliases resolve to the same canonical profile");
    assert.equal(identity.roleProfile("damar"), null);
    assert.equal(identity.roleProfile("pandawa:fake"), null);
});

test("F-05: AgentHub executable roles match canonical profile and contain no legacy ownership", () => {
    for (const record of identity.records()) {
        const agent = agentHub.get(record.agentId);
        assert.ok(agent, `${record.agentId} must be registered`);
        assert.equal(agent.entityId, record.id, "entity id unchanged by role migration");
        const text = `${agent.label} ${agent.description} ${agent.role} ${agent.skills.join(" ")}`;
        assert.match(text, CANONICAL_DOMAINS[record.id].include, `${record.agentId} must carry canonical role semantics`);
        assert.doesNotMatch(text, CANONICAL_DOMAINS[record.id].legacy, `${record.agentId} must not retain legacy role ownership`);
        // Executable prompt projects the canonical mandate, not a second copy.
        assert.equal(agent.role, identity.roleProfile(record.id).mandate, `${record.agentId} prompt must be projected from the canonical owner`);
        // Roles remain non-authoritative.
        assert.equal("authority" in agent, false);
        assert.equal(agent.capabilityGrant, undefined);
    }
});

test("F-05: specific legacy residues are gone", () => {
    const janaka = agentHub.get("janaka");
    const nakula = agentHub.get("nakula");
    const sadewa = agentHub.get("sadewa");
    // Janaka is engineering, NOT the legacy research/intelligence owner.
    assert.match(`${janaka.label} ${janaka.description} ${janaka.role}`, /rekayasa|koding|arsitektur/i);
    assert.doesNotMatch(janaka.role, /riset & intelijen|OSINT/i);
    // Nakula is analytics, NOT the legacy engineering owner.
    assert.match(`${nakula.label} ${nakula.description} ${nakula.role}`, /data|statistik|RF|spasial/i);
    assert.doesNotMatch(nakula.role, /rekayasa & operasi|Bangun, ubah, debug/i);
    // Sadewa is research/evidence/provenance, NOT the legacy memory-root owner.
    assert.match(`${sadewa.label} ${sadewa.description} ${sadewa.role}`, /riset|bukti|verifikasi|provenance/i);
    assert.doesNotMatch(sadewa.role, /memori, analisis, dan kontinuitas/i);
});

test("F-05: identities and aliases remain exactly the canonical five", () => {
    const workers = agentHub.agents().filter(a => a.kind === "worker");
    assert.equal(workers.length, 5);
    assert.deepEqual(workers.map(w => w.entityId).sort(), [
        "pandawa:janaka", "pandawa:nakula", "pandawa:puntadewa", "pandawa:sadewa", "pandawa:werkudara"
    ]);
    assert.equal(identity.resolve("Yudistira").id, "pandawa:puntadewa");
    assert.equal(identity.resolve("Bima").id, "pandawa:werkudara");
    assert.equal(identity.resolve("Arjuna").id, "pandawa:janaka");
    assert.equal(agentHub.identityOf("Yudistira").id, "pandawa:puntadewa");
    assert.equal(agentHub.get("arjuna").id, "janaka");
    assert.equal(agentHub.get("bima").id, "werkudara");
});

test("F-05: Puntadewa and Werkudara carry their canonical engineering-adjacent scopes", () => {
    const puntadewa = agentHub.get("puntadewa");
    const werkudara = agentHub.get("werkudara");
    assert.match(`${puntadewa.label} ${puntadewa.description} ${puntadewa.role}`, /strategi|sintesis|arbitrase|perencanaan/i);
    assert.match(`${werkudara.label} ${werkudara.description} ${werkudara.role}`, /infrastruktur|resiliensi|adversarial/i);
    // Authority laws stay attached to the executable prompts.
    assert.match(puntadewa.role, /BUKAN OTORITAS/i);
    assert.match(werkudara.role, /BUKAN JALAN PINTAS/i);
    assert.match(agentHub.get("janaka").role, /BUKAN IZIN EKSEKUSI/i);
    assert.match(agentHub.get("nakula").role, /BUKAN IZIN EKSEKUSI/i);
    assert.match(sadewaText(), /BUKAN KEBENARAN FINAL/i);
});

function sadewaText() { return agentHub.get("sadewa").role; }
