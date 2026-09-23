"use strict";

/* Media is a Manager action adapter. Process ownership lives in the
 * canonical Lane 3 actuator registered by src/action/bootstrap.js. */

const os = require("node:os");
const path = require("node:path");
const { executeCanonicalAction } = require("./canonicalActionClient");

const CACHE_DIR = path.join(os.tmpdir(), "damar-media");

function validVideoId(value) {
    const id = String(value ?? "").trim();
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function resolveStream(videoId, context = null) {
    const id = validVideoId(videoId);
    if (!id) return null;
    const result = await executeCanonicalAction({
        context, capabilityId: "damar.media", operation: "resolve", arguments: { videoId: id },
        expectedPostcondition: { expect: { url: { op: "type", value: "string" } } }
    });
    return result.outcome === "COMPLETED"
        ? result.evidenceSummary?.observedEvidence?.url ?? null
        : null;
}

async function downloadMedia(videoId, context = null) {
    const id = validVideoId(videoId);
    if (!id) return null;
    const result = await executeCanonicalAction({
        context, capabilityId: "damar.media", operation: "download", arguments: { videoId: id },
        expectedPostcondition: { expect: { exists: { op: "eq", value: true }, bytes: { op: "gt", value: 0 } } }
    });
    if (result.outcome !== "COMPLETED") return null;
    return path.join(CACHE_DIR, `${id}.mp4`);
}

module.exports = Object.freeze({ resolveStream, downloadMedia, CACHE_DIR });
