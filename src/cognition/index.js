/**
 * ACC C0 — pintu publik tunggal (§90).
 *
 * Pemakaian:
 *   const { createAccCore } = require("../cognition");
 *   const acc = await createAccCore();            // mode dari AETHER_ACC
 *   if (acc.mode === "shadow") { ... }
 *
 * Foundation TIDAK PERNAH me-require modul ini (arah dependensi §4):
 * integrasi dilakukan dari luar via integration/FoundationEventAdapter.
 */

const { createACCConfig } = require("./config/ACCConfig");
const { realClock, manualClock } = require("./core/clock");
const { CognitiveCore } = require("./CognitiveCore");
const { createSqliteAccStore, createMemoryAccStore } = require("./persistence/AccStore");

async function createAccCore({
    env = process.env,
    overrides = {},
    store = null,
    clock = null
} = {}) {

    const config = createACCConfig(env, overrides);

    const core = new CognitiveCore({
        config,
        clock: clock ?? realClock(),
        store: store ?? (config.mode === "shadow"
            ? createMemoryAccStore()      // default shadow ringan; sqlite via opsi
            : createMemoryAccStore())
    });

    await core.initialize();

    // Adapter interosepsi bawaan hanya di shadow.
    if (core.mode === "shadow") {
        for (const [name, fn] of require("./interoception/InteroceptiveBus")
                .defaultProcessAdapters()) {
            core.interoception.registerAdapter(name, fn);
        }
    }

    return core;

}

module.exports = {
    createACCConfig, realClock, manualClock,
    CognitiveCore, createAccCore,
    createSqliteAccStore, createMemoryAccStore,

    // Sub-modul publik untuk lab/tes tanpa menembus private.
    envelope: require("./core/envelope"),
    ContinuityCore: require("./continuity/ContinuityCore").ContinuityCore,
    reducers: require("./continuity/reducers"),
    epistemics: require("./self/epistemics"),
    affect: require("./affect/engine"),
    Appraisal: require("./affect/AppraisalEngine"),
    Workspace: require("./workspace/GlobalWorkspace"),
    Witness: require("./witness/WitnessModel"),
    Predictions: require("./prediction/Predictions"),
    ExperienceEncoder: require("./autobiography/ExperienceEncoder"),
    SubstrateRouter: require("./substrate/SubstrateRouter"),
    InteroceptiveBus: require("./interoception/InteroceptiveBus"),
    FoundationAdapter: require("./integration/FoundationEventAdapter")
};
