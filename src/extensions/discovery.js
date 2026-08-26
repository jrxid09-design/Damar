"use strict";

/**
 * EXTENSION KERNEL V1 — bounded discovery contract.
 *
 * LAWS:
 *   discovery != execution
 *   Discovery NEVER requires/loads/executes extension code. It reads
 *   declarative manifest bytes only and returns parsed descriptors.
 *
 *   No hidden filesystem scanning: only roots passed explicitly by the
 *   caller are examined, one level deep (root/<dir>/<manifestFileName>).
 *   No network discovery in V1.
 *
 * Isolation: one malformed extension produces a problem record; it never
 * prevents other extensions from being discovered.
 *
 * Determinism: roots processed in given order, directories sorted,
 * results sorted by canonical id; duplicate ids keep the first occurrence
 * (later ones become DUPLICATE_ID problems).
 */

const fs = require("node:fs");
const path = require("node:path");

const { parseExtensionManifest, BOUNDS } = require("./manifest");
const { fail } = require("./errors");

const DEFAULTS = Object.freeze({
    maxResults: 256,
    maxManifestBytes: BOUNDS.MAX_MANIFEST_BYTES,
    manifestFileName: "aether-extension.json"
});

/**
 * @param {object} options
 * @param {string[]} options.roots           explicit configured directories
 * @param {number}  [options.maxResults]
 * @param {string}  [options.manifestFileName]
 * @returns {{extensions: object[], problems: object[]}}
 */
function discoverExtensions({ roots = [], maxResults = DEFAULTS.maxResults, manifestFileName = DEFAULTS.manifestFileName } = {}) {
    if (!Array.isArray(roots)) {
        throw fail("DISCOVERY_CONFIG", "roots must be an array of directory paths");
    }
    const problems = [];
    const found = new Map(); // idValue -> {descriptor, source}
    let scanned = 0;

    for (const root of roots) {
        if (found.size >= maxResults) break;
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            problems.push(problem("ROOT_UNREADABLE", null, String(root)));
            continue;
        }
        // deterministic order regardless of filesystem ordering
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (found.size >= maxResults) break;
            if (!entry.isDirectory()) continue;
            const sourcePath = path.join(String(root), entry.name);
            const result = readManifestAt(path.join(sourcePath, manifestFileName), sourcePath);
            scanned += 1;
            if (result.problem) {
                problems.push(result.problem);
                continue;
            }
            try {
                const descriptor = parseExtensionManifest(result.text, { source: sourcePath });
                const idValue = descriptor.id.value;
                if (found.has(idValue)) {
                    problems.push(problem("DUPLICATE_ID", idValue, sourcePath));
                    continue;
                }
                found.set(idValue, descriptor);
            } catch (err) {
                // malformed manifests are isolated, never fatal to discovery
                problems.push(problem(
                    err && err.reasonCode ? err.reasonCode : "MANIFEST_INVALID",
                    err && err.details && err.details.extensionId ? err.details.extensionId : null,
                    sourcePath,
                    err instanceof Error ? err.message : String(err)
                ));
            }
        }
    }

    const extensions = [...found.values()].sort(
        (a, b) => (a.id.value < b.id.value ? -1 : a.id.value > b.id.value ? 1 : 0));

    return Object.freeze({ extensions: Object.freeze(extensions), problems: Object.freeze(problems), scanned });
}

function readManifestAt(manifestPath, sourceName) {
    let stat;
    try {
        stat = fs.statSync(manifestPath);
    } catch {
        return { problem: problem("NO_MANIFEST", null, sourceName) };
    }
    if (stat.size > DEFAULTS.maxManifestBytes) {
        return { problem: problem("MANIFEST_TOO_LARGE", null, sourceName, `${stat.size} bytes`) };
    }
    try {
        return { text: fs.readFileSync(manifestPath, "utf8") };
    } catch {
        return { problem: problem("MANIFEST_UNREADABLE", null, sourceName) };
    }
}

function problem(kind, extensionId, source, message = "") {
    return Object.freeze({ kind, extensionId, source, message });
}

/** Pure in-memory discovery port (no filesystem): feed raw JSON texts. */
function discoverFromSources(sources, { maxResults = DEFAULTS.maxResults } = {}) {
    if (!Array.isArray(sources)) {
        throw fail("DISCOVERY_CONFIG", "sources must be an array");
    }
    const problems = [];
    const found = new Map();
    for (const item of sources.slice(0, maxResults)) {
        if (!item || typeof item !== "object") {
            problems.push(problem("SOURCE_INVALID", null, "inline"));
            continue;
        }
        try {
            const descriptor = parseExtensionManifest(item.jsonText ?? item.manifest, { source: item.source ?? "inline" });
            const idValue = descriptor.id.value;
            if (found.has(idValue)) {
                problems.push(problem("DUPLICATE_ID", idValue, item.source ?? "inline"));
                continue;
            }
            found.set(idValue, descriptor);
        } catch (err) {
            problems.push(problem(
                err && err.reasonCode ? err.reasonCode : "MANIFEST_INVALID",
                null, item.source ?? "inline",
                err instanceof Error ? err.message : String(err)));
        }
    }
    const extensions = [...found.values()].sort(
        (a, b) => (a.id.value < b.id.value ? -1 : a.id.value > b.id.value ? 1 : 0));
    return Object.freeze({ extensions: Object.freeze(extensions), problems: Object.freeze(problems) });
}

module.exports = { discoverExtensions, discoverFromSources, DEFAULTS };
