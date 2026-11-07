/**
 * RE Intelligence V0 — pintu publik tunggal.
 *
 * Pemakaian:
 *   const { createReIntel } = require("./reintel");
 *   const re = createReIntel();
 *   const report = await re.analyzeArtifact({ path: "/tmp/foo.exe" });
 *
 * Modul ini BERDIRI SENDIRI: tanpa model LLM, tanpa Console, tanpa ACC,
 * tanpa Authority, tanpa Sensorium/Semantic Desktop (jembatan ke sana
 * hanya berupa inbox generik pasif). Foundation tidak pernah me-require
 * modul ini secara paksa; konsumen datang ke sini.
 *
 * Batasan V0: analisis STATIS saja. Tidak ada eksekusi artifact,
 * tidak ada intersepsi protokol, tidak ada otoritas operasi.
 */

"use strict";

const { freezeDeep } = require("./model/model");
const { createReIntelConfig } = require("./config/ReIntelConfig");
const { analyzeArtifact } = require("./analysis/pipeline");
const {
    defineAnalyzer, makeAnalysisContext, runAnalyzers, analysisResultOf
} = require("./analysis/analyzer");
const { defaultAnalyzers } = require("./analysis/analyzers");
const { deriveBehavioralClaims } = require("./analysis/behavior");
const {
    HOOK_EVENTS, createDynamicAnalysisRequest,
    createProtocolCaptureInput, createReIntelInbox
} = require("./hooks/futureHooks");

const VERSION = "0.1.0";

async function createReIntel({ env = process.env, overrides = {} } = {}) {
    const config = createReIntelConfig(env, overrides);
    return freezeDeep({
        version: VERSION,
        config,
        analyzeArtifact: (input, options = {}) =>
            analyzeArtifact(input, { ...options, config }),
        analyzers: defaultAnalyzers,
        hooks: {
            events: HOOK_EVENTS,
            createDynamicAnalysisRequest,
            createProtocolCaptureInput,
            createReIntelInbox
        }
    });
}

module.exports = {
    VERSION,
    createReIntel,
    createReIntelConfig,
    analyzeArtifact,

    // sub-modul publik untuk lab/tes tanpa menembus private:
    model: require("./model/model"),
    hashing: require("./core/hashing"),
    identify: require("./core/identify"),
    pe: require("./core/pe"),
    strings: require("./core/strings"),
    scripts: require("./core/scripts"),
    entropy: require("./core/entropy"),
    behavior: deriveBehavioralClaims,
    analyzerKit: { defineAnalyzer, makeAnalysisContext, runAnalyzers, analysisResultOf },
    hooks: { HOOK_EVENTS, createDynamicAnalysisRequest, createProtocolCaptureInput, createReIntelInbox },
    defaultAnalyzers
};
