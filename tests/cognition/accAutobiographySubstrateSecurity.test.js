const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

/**
 * ACC AUTOBIOGRAPHY + SUBSTRATE + SECURITY BOUNDARY + OFF-MODE
 * (§36–§42/§54/§94 C0.7–C0.8/§96–§97/§109–§110).
 */

const acc = require("../../src/cognition");
const Authorization = require("../../src/ai/tools/Authorization");
const {
    createMemoryAccStore
} = require("../../src/cognition/persistence/AccStore");

const T0 = 1_000_000;

/* --------------------------- AUTOBIOGRAPHY ------------------------------ */

test("C0.6: pengalaman signifikan terenkode & tersimpan; sepele tidak", async () => {

    const core = new acc.ContinuityCore({
        store: createMemoryAccStore(), clock: acc.manualClock(T0),
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
    await core.initialize();

    const sigHigh = acc.ExperienceEncoder.computeSignificance({
        novelty: 0.9, goalImportance: 0.8, predictionError: 0.7,
        affectMagnitude: 0.4, commitmentImpact: 0.5,
        relationshipImpact: 0, identityImpact: 0.2
    }, core.config);
    assert.ok(sigHigh >= core.config.experience.threshold);

    const sigLow = acc.ExperienceEncoder.computeSignificance({
        novelty: 0.05, goalImportance: 0.05, predictionError: 0.02,
        affectMagnitude: 0.01, commitmentImpact: 0, relationshipImpact: 0,
        identityImpact: 0
    }, core.config);
    assert.ok(sigLow < core.config.experience.threshold,
        "event sepele tidak layak autobiografis");
});

test("C0.6: MEMORY_ACTIVATED hanya dari aktivasi nyata (encoder)", () => {
    assert.throws(
        () => acc.ExperienceEncoder.activationRecord({ reason: "x" }),
        /experienceId/
    );
});

/* ------------------------------ SUBSTRATE -------------------------------- */

test("C0.7: MODEL SWAP — identitas/komitmen/prediksi kekal, epoch berganti (§54)", async () => {

    const clock = acc.manualClock(T0);
    const core = new acc.ContinuityCore({
        store: createMemoryAccStore(), clock,
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
    await core.initialize();

    const identityBefore = core.state.identity.identityId;

    await core.observeSubstrateChange(
        { provider: "ox", modelId: "ox-alpha", substrateEpochId: "sub-A" });

    await core.feed(acc.envelope.makeEnvelope({
        type: "COMMITMENT_ADDED",
        source: "operator", provenance: "SYSTEM_EVENT",
        payload: { commitmentId: "c-swap", statement: "ingat konteks pemilik",
                   source: "USER_EXPLICIT" }, clock
    }));

    await core.observeSubstrateChange(
        { provider: "local", modelId: "qwen-small", local: true,
          substrateEpochId: "sub-B" });

    assert.equal(core.state.identity.identityId, identityBefore,
        "identitas tidak reset karena ganti model");
    assert.equal(core.state.substrate.current.substrateEpochId, "sub-B");
    assert.equal(core.state.commitments.active["c-swap"].statement,
        "ingat konteks pemilik");
    assert.equal(core.state.substrate.epochs.length, 2);
});

test("C0.7: CognitiveRequest — capabilitySet=[] frozen; nol disclosure; eksekusi DENY (§97)", async () => {

    const request = acc.SubstrateRouter.makeCognitiveRequest({
        purpose: "REFLECT",
        Authorization,
        selfStateRef: "state-1",
        at: "t"
    });

    // Bentuk kanonik:
    assert.equal(Object.isFrozen(request.tools), true);
    assert.equal(request.tools.length, 0);
    assert.deepEqual([...request.exec.capabilitySet], []);
    assert.equal(Object.isFrozen(request.exec.capabilitySet), true);

    // Behavioral — INVARIANT M-1 dijalankan ulang pada request kognitif:
    const anyTools = [
        { name: "terminal_run" }, { name: "memory_recall" },
        { name: "damarSkills__wa_send" }
    ];
    const disclosed = Authorization.disclosureFilter(anyTools, request.exec);
    assert.equal(disclosed.length, 0,
        "kognisi internal tidak boleh MELIHAT tool apa pun");

    for (const tool of anyTools) {
        assert.throws(
            () => Authorization.assertExecution(tool, request.exec),
            e => e.code === "PERMISSION_DENIED",
            `${tool.name} wajib DENY untuk identitas kognitif`);
    }
});

test("C0.7: CognitiveProposal = MODEL_HYPOTHESIS, tanpa jalur eksekusi", () => {

    const proposal = acc.SubstrateRouter.makeProposal({
        cognitiveRequestId: "creq-1", substrateId: "sub-A",
        type: "INTERPRET",
        claims: [{ field: "confidence", value: 0.9 }],
        confidence: 0.6, evidenceRefs: ["e1"], generatedAt: "t"
    });

    assert.equal(proposal.epistemicClass, "MODEL_HYPOTHESIS");
    const json = JSON.stringify(proposal);
    assert.ok(!/execute|grant|capabilitySet|role/i.test(
        Object.keys(proposal).join("|")),
        "proposal tidak membawa field otoritas");
    void json;
});

/* ------------------------- SECURITY BOUNDARY ----------------------------- */

test("SEC-SCAN: src/cognition bebas jalur eksekusi/jaringan/proses (§96)", () => {

    const root = path.join(__dirname, "..", "..", "src", "cognition");
    const FORBIDDEN = [
        /child_process/, /\bfetch\s*\(/, /node:http/, /node:https/,
        /\bnet\./, /\bdgram\b/, /ToolRegistry\s*\.\s*execute/,
        /ToolBus\s*\.\s*execute\s*\(/, /\beval\s*\(/, /process\.exit/
    ];

    const offenders = [];

    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".js")) continue;
            const text = fs.readFileSync(full, "utf8");
            for (const pattern of FORBIDDEN) {
                if (pattern.test(text)) {
                    offenders.push(`${path.relative(root, full)} :: ${pattern}`);
                }
            }
        }
    })(root);

    assert.deepEqual(offenders, [],
        `ACC dilarang memiliki jalur eksekusi/jaringan:\n${offenders.join("\n")}`);
});

test("DEP-DIR: foundation TIDAK boleh me-require cognition (§4)", () => {

    const FOUNDATION = [
        "src/ai/tools/Authorization.js",
        "src/ai/runtime/requestIdentity.js",
        "src/ai/executors/RuntimeExecutor.js",
        "src/autonomy/ToolBus.js",
        "src/core/safety/riskPolicy.js",
        "src/core/safety/ssrfGuard.js"
    ];

    const violations = [];
    for (const rel of FOUNDATION) {
        const text = fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
        if (/require\([^)]*cognition/.test(text)) violations.push(rel);
    }

    assert.deepEqual(violations, []);
});

/* ------------------------------- OFF MODE -------------------------------- */

test("OFF-MODE: DAMAR_ACC=off → nol perilaku, nol jejak store (§109)", async () => {

    let calls = 0;
    const countingStore = new Proxy(createMemoryAccStore(), {
        get(target, prop) {
            const original = target[prop];
            if (typeof original === "function") {
                return (...args) => {
                    calls += 1;
                    return original.apply(target, args);
                };
            }
            return original;
        }
    });

    const core = await acc.createAccCore({
        env: { DAMAR_ACC: "off" },
        store: countingStore
    });

    assert.equal(core.mode, "off");
    assert.equal(await core.feedShadow({ eventId: "x" }), null);
    assert.equal(core.diagnosticsSnapshot(), null);
    assert.deepEqual(await core.interoceive(), []);

    // Store tidak pernah disentuh sama sekali:
    assert.equal(calls, 0, `store dipanggil ${calls}x saat mode off`);
});

test("SHADOW-PARITY: akumulasi state ACC tidak mengubah keputusan security (§110)", async () => {

    const core = await acc.createAccCore({
        env: { DAMAR_ACC: "shadow" },
        overrides: {}
    });

    const probe = () => ({
        deny: (() => { try {
            Authorization.assertExecution({ name: "terminal_run" },
                { role: "user", channel: "console" });
            return null;
        } catch (e) { return { code: e.code }; } })(),
        allow: (() => { try {
            Authorization.assertExecution({ name: "memory_recall" },
                { role: "user", channel: "console" });
            return true;
        } catch (e) { return false; } })()
    });

    const before = probe();

    for (let i = 0; i < 20; i++) {
        await core.feedShadow(acc.envelope.makeEnvelope({
            type: i % 2 ? "TOOL_FAILED" : "PROVIDER_DEGRADED",
            source: "t",
            provenance: i % 2 ? "OBSERVATION" : "SYSTEM_EVENT",
            subject: `s${i}`, payload: { tool: `t${i}` },
            clock: { nowMs: () => T0 + i }
        }));
    }

    const after = probe();
    assert.deepEqual(after, before,
        "akumulasi kognitif tidak boleh menyentuh keputusan otorisasi");
});


test("C0.6: autobiography persisted DAN canonical state survive restart", async () => {

    const store = createMemoryAccStore();

    const c1 = await acc.createAccCore({
        env: { DAMAR_ACC: "shadow" },
        store,
        overrides: {}
    });

    const before = JSON.parse(JSON.stringify(c1.continuity.state));
    const after = JSON.parse(JSON.stringify(before));

    // Fixture deterministik dengan signifikansi tinggi.
    after.affect = {
        ...after.affect,
        arousal: 1,
        uncertainty: 1,
        predictionError: 1,
        valence: -1
    };

    const experience = await c1.encodeExperienceIfSignificant({
        at: new Date(T0).toISOString(),
        before,
        after,
        appraisal: {
            eventId: "evt-bio-restart",
            novelty: 1,
            goalRelevance: 1,
            predictionSurprise: 1
        },
        eventType: "CONTINUITY_EPOCH_CREATED"
    });

    assert.ok(experience,
        "fixture wajib menghasilkan pengalaman signifikan");

    // A. Projection/detail episode benar-benar persisted.
    const persisted = await store.listExperiences();

    assert.equal(persisted.length, 1,
        "episode signifikan wajib tersimpan di experience store");

    assert.equal(
        persisted[0].experience_id,
        experience.experienceId,
        "experienceId projection harus cocok"
    );

    const liveAutobiography =
        JSON.parse(JSON.stringify(c1.continuity.state.autobiography));

    assert.equal(liveAutobiography.significantCount, 1);
    assert.equal(liveAutobiography.recent.length, 1);

    // B. Simulasikan restart di atas store yang SAMA.
    const c2 = await acc.createAccCore({
        env: { DAMAR_ACC: "shadow" },
        store,
        overrides: {}
    });

    const restoredAutobiography =
        JSON.parse(JSON.stringify(c2.continuity.state.autobiography));

    assert.deepEqual(
        restoredAutobiography,
        liveAutobiography,
        "autobiography canonical wajib survive restart/replay"
    );
});
