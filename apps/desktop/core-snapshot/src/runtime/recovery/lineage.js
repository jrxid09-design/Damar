"use strict";

const { coerceRecoveryCapsuleId } = require("./ids");
const { DiagnosticCollector } = require("./diagnostics");

/**
 * Lineage analysis (R15).
 *
 * Given a candidate set of capsules, detect: missing parent, cycles,
 * same-epoch conflicts, forks (one parent, multiple children), and
 * excessive depth. Forks and cycles NEVER resolve silently — the caller
 * must make an explicit choice or refuse.
 */
function analyzeLineage(capsules, config) {
    const diags = new DiagnosticCollector(config.maxDiagnostics);
    const byId = new Map();
    for (const cap of capsules) {
        const id = coerceRecoveryCapsuleId(cap.manifest.capsuleId);
        if (byId.has(id)) {
            diags.add("MALFORMED_ID", { capsuleId: id, message: "duplicate capsule id in candidate set" });
            continue;
        }
        byId.set(id, cap);
    }

    const childrenOfParent = new Map();
    const epochOwners = new Map();

    for (const cap of capsules) {
        const m = cap.manifest;
        const id = m.capsuleId;

        const owner = epochOwners.get(m.epochId);
        if (owner && owner !== id) {
            diags.add("LINEAGE_CONFLICTING_EPOCH", {
                capsuleId: id,
                message: `epoch shared with ${owner}`
            });
        } else if (!owner) {
            epochOwners.set(m.epochId, id);
        }

        if (m.parentCapsuleId === null) {
            continue;
        }
        if (!byId.has(m.parentCapsuleId)) {
            diags.add("LINEAGE_MISSING_PARENT", { capsuleId: id });
            continue;
        }
        if (!childrenOfParent.has(m.parentCapsuleId)) {
            childrenOfParent.set(m.parentCapsuleId, []);
        }
        childrenOfParent.get(m.parentCapsuleId).push(id);
    }

    for (const [parent, children] of childrenOfParent) {
        const unique = [...new Set(children)].sort();
        if (unique.length > 1) {
            diags.add("LINEAGE_FORK", { capsuleId: parent, message: `forked into ${unique.join(",")}` });
        }
    }

    for (const startId of byId.keys()) {
        const seen = new Set();
        let cur = startId;
        let depth = 0;
        while (cur) {
            if (seen.has(cur)) {
                diags.add("LINEAGE_CYCLE", { capsuleId: startId, message: `cycle through ${cur}` });
                break;
            }
            seen.add(cur);
            depth += 1;
            if (depth > config.maxLineageDepth) {
                diags.add("LINEAGE_TOO_DEEP", { capsuleId: startId });
                break;
            }
            const node = byId.get(cur);
            cur = node && node.manifest.parentCapsuleId !== null ? node.manifest.parentCapsuleId : null;
        }
    }

    return Object.freeze({
        ok: diags.items.length === 0,
        diagnostics: diags.snapshot(),
        hasFork: diags.items.some((d) => d.code === "LINEAGE_FORK"),
        hasCycle: diags.items.some((d) => d.code === "LINEAGE_CYCLE")
    });
}

module.exports = Object.freeze({ analyzeLineage });
