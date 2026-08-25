/**
 * SCHEMA MINIMIZER V2 — efisiensi TIDAK BOLEH menghasilkan schema
 * yang berbohong (temuan H9).
 *
 * Perilaku eksplisit per fitur JSON Schema:
 *
 *   SUPPORTED (dipertahankan apa adanya):
 *     type (termasuk union [t1,t2]), description, enum (PENUH —
 *     tidak pernah dipotong; validator menegakkan nilai penuh),
 *     const, format, pattern, default, minimum/maximum,
 *     exclusiveMinimum/Maximum, minLength/maxLength,
 *     minItems/maxItems, additionalProperties (boolean)
 *
 *   MINIMIZED SAFELY:
 *     properties (urutan required-dulu), required (difilter HANYA ke
 *     properti yang tersisa — schema invalid dulu karena required
 *     bisa menunjuk properti yang terbuang), items, nested object
 *
 *   FALLBACK KE SCHEMA PENUH (ditandai `x-aether-full: true`):
 *     $ref / oneOf / anyOf / allOf / not — provider umum tak konsisten;
 *     daripada menyembunyikan constraint eksekusi, kirim utuh.
 *     Kedalaman/jumlah node melampaui batas → fallback utuh juga
 *     (rekursi dibatasi ketat: tidak ada stack overflow).
 */

const DEFAULTS = {
    descChars: 160,
    paramDescChars: 80
};

const MAX_DEPTH = 12;
const MAX_NODES = 400;

/** Perkiraan token: panjang JSON / 4 — SELALU dilabel estimatedTokens. */
function estimateTokens(value) {
    try {
        return Math.ceil(JSON.stringify(value ?? null).length / 4);
    }
    catch {
        return 0;
    }
}

function trim(text, max) {

    const s = String(text ?? "").replace(/\s+/g, " ").trim();

    if (!max || s.length <= max) return s;

    const cut = s.slice(0, max);

    const lastSpace = cut.lastIndexOf(" ");

    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "…";

}

/** Constraint primitif yang disalin UTUH tanpa modifikasi. */
const PASSTHROUGH = [
    "const", "format", "pattern", "default",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "minItems", "maxItems",
    "additionalProperties"
];

/** Fitur yang memicu fallback full-schema untuk subschema tersebut. */
const FALLBACK_KEYS = ["$ref", "oneOf", "anyOf", "allOf", "not"];

function nodeCount(schema, depth = 0, acc = { n: 0 }) {
    if (depth > MAX_DEPTH || !schema || typeof schema !== "object") return acc;
    acc.n++;
    if (acc.n > MAX_NODES) return acc;
    for (const sub of [schema.items, ...(Object.values(schema.properties ?? {})),
        ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
        nodeCount(sub, depth + 1, acc);
        if (acc.n > MAX_NODES) break;
    }
    return acc;
}

/**
 * Minimalkan satu properti.
 * @returns object property baru ATAU subschema asli bertanda fallback.
 */
function minimizeProperty(spec = {}, opts, depth = 0) {

    if (!spec || typeof spec !== "object") return { type: "string" };

    // Fallback penuh: fitur yang tidak didukung minimizer ATAU kedalaman
    // berlebih. Validator tetap bekerja atas schema registry penuh.
    const needsFull =
        depth >= MAX_DEPTH ||
        FALLBACK_KEYS.some(k => k in spec) ||
        nodeCount(spec).n > MAX_NODES;

    if (needsFull) {
        return { ...spec, "x-aether-full": true };
    }

    const out = {};

    out.type = spec.type ?? "string";   // union array ikut utuh

    if (spec.description) {
        out.description = trim(spec.description, opts.paramDescChars);
    }

    // Enum PENUH (H9): memangkas tampilan = membohongi model tentang
    // nilai sah; validator lalu menolak nilai yang model percaya sah.
    if (Array.isArray(spec.enum)) out.enum = spec.enum;

    for (const key of PASSTHROUGH) {
        if (key in spec) out[key] = spec[key];
    }

    if (out.type === "array" && spec.items && typeof spec.items === "object") {
        out.items = minimizeProperty(spec.items, opts, depth + 1);
    }

    if ((out.type === "object" || spec.properties) &&
        spec.properties && typeof spec.properties === "object") {

        const entries = Object.entries(spec.properties);

        const kept = entries.map(([k, v]) => [k, minimizeProperty(v, opts, depth + 1)]);

        out.properties = Object.fromEntries(kept);

        const retained = new Set(Object.keys(out.properties));

        // Required hanya menunjuk properti yang benar-benar ada —
        // dulu inilah sumber schema invalid.
        if (Array.isArray(spec.required)) {
            const filtered = spec.required.filter(k => retained.has(k));
            if (filtered.length) out.required = filtered;
        }
    }
    else if (Array.isArray(spec.required) && spec.required.length) {
        out.required = spec.required;
    }

    return out;

}

/** JSON Schema utuh → bentuk minimum yang jujur secara semantik. */
function minimizeSchema(schema = {}, opts = DEFAULTS) {

    const o = { ...DEFAULTS, ...opts };

    if (!schema || typeof schema !== "object") {
        return { type: "object", properties: {} };
    }

    const out = { type: "object" };

    const props = schema.properties && typeof schema.properties === "object"
        ? schema.properties
        : {};

    const required = Array.isArray(schema.required) ? schema.required : [];

    const keys = [
        ...required.filter(k => k in props),
        ...Object.keys(props).filter(k => !required.includes(k))
    ];

    out.properties = Object.fromEntries(
        keys.map(k => [k, minimizeProperty(props[k], o, 1)])
    );

    const retained = new Set(Object.keys(out.properties));

    if (required.length) {
        const filtered = required.filter(k => retained.has(k));
        if (filtered.length) out.required = filtered;
    }

    return out;

}

/**
 * Tampilan model-facing satu tool.
 * @returns {{name, description, parameters}}
 */
function toView(tool, opts = {}) {

    const o = { ...DEFAULTS, ...opts };

    let description = trim(tool.description ?? "", o.descChars);

    // INVARIANT D/H8: deskripsi kapabilitas EKSTERNAL adalah DATA, bukan
    // instruksi — netralkan pola peniru struktur prompt sebelum sampai
    // ke model.
    if (require("./CapabilityIndex").provenanceOf(tool).external) {
        try {
            description = require("../../core/safety/contentBoundary")
                .neutralize(description);
        }
        catch { /* boundary tak ada: deskripsi tetap data biasa */ }
    }

    return {
        name: tool.name,
        description,
        parameters: minimizeSchema(tool.parameters, o)
    };

}

module.exports = { toView, minimizeSchema, estimateTokens, trim };

