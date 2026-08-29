const riskCatalog = require("../../core/safety/riskCatalog");

/**
 * CAPABILITY INDEX — metadata kapabilitas untuk setiap tool.
 *
 * Registry lama hanya tahu {name, description, parameters}. Seleksi
 * pun jadi tebak-tebakan leksikal atas nama/deskripsi saja. Index ini
 * menormalkan SETIAP tool menjadi rekam kapabilitas:
 *
 *   capabilities / keywords / domain / risk / sideEffects / readOnly /
 *   channels / roles / cost / latency / source / provider
 *
 * Metadata eksplisit (AITool.meta) selalu MENANG; sisanya diturunkan:
 *   - "mcp__server__tool"   → source=mcp, provider=server (eksternal)
 *   - "pluginId__toolName"  → source=plugin, provider=pluginId
 *   - selainnya             → source=native
 * Risiko diturunkan dari riskCatalog (destruktif atau tidak), dengan
 * id yang di-debridge ("filesystem__readFile" → "filesystem.readFile").
 */

/** Ruas terakhir nama: "system.time.currentTime" / "system__time__currentTime" → "currentTime". */
function tail(name) {
    return String(name ?? "").split(/__|\./).pop();
}

/**
 * Uraikan nama terbridging menjadi {source, provider, id}.
 * Id bentuk registry inti untuk pencocokan riskCatalog.
 */
function parseName(name) {

    const raw = String(name ?? "");
    const parts = raw.split("__");

    if (parts.length >= 3 && parts[0] === "mcp") {
        return {
            source: "mcp",
            provider: parts[1],
            id: `mcp.${parts[1]}.${parts.slice(2).join(".")}`
        };
    }

    if (parts.length >= 2) {
        return {
            source: "plugin",
            provider: parts.slice(0, -1).join("."),
            id: `${parts.slice(0, -1).join(".")}.${parts[parts.length - 1]}`
        };
    }

    return { source: "native", provider: null, id: raw };

}

const STOPWORDS = new Set([
    "the", "and", "for", "with", "this", "that", "from", "into", "yang",
    "dengan", "untuk", "pada", "adalah", "tool", "tools", "damar"
]);

/** Kata signifikan (≥4 huruf), sadar camelCase, plus bentuk dasar jamak. */
function tokenize(text) {

    // camelCase dipisah SEBELUM huruf kecil: "readFile" → read + file.
    const raw = String(text ?? "")
        .split(/[^a-zA-Z0-9]+/)
        .flatMap(part => part.split(/(?=[A-Z])/))
        .map(w => w.toLowerCase())
        .filter(w => w.length >= 4 && !STOPWORDS.has(w));

    // Bentuk dasar sederhana: references→reference, photos→photo,
    // entities→entity. Pencocokan dua arah tanpa stemming penuh.
    const stems = raw
        .filter(w => w.length > 4)
        .map(w => w.endsWith("ies") ? w.slice(0, -3) + "y"
            : (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) ? w.slice(0, -1)
            : null)
        .filter(Boolean);

    return [...new Set([...raw, ...stems])];

}

/**
 * Rekam kapabilitas ternormalisasi untuk satu tool.
 * Metadata eksplisit (meta.*) menimpa hasil penurunan.
 */
function describe(tool) {

    const parsed = parseName(tool?.name);

    const meta = tool?.meta ?? {};

    const destructive =
        meta.risk ? meta.risk === "high" : Boolean(riskCatalog.riskOf(parsed.id, tool));

    const description = String(tool?.description ?? "");

    const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];

    const capabilities = Array.isArray(meta.capabilities) ? meta.capabilities : [];

    const nameTokens = tokenize(tool?.name);

    // Kata dari nama selalu jadi sinyal; kata kunci eksplisit dan
    // istilah kapabilitas menyusul. Deskripsi dipisah — bobotnya
    // lebih kecil di retriever karena penuh kata umum.
    const tokens = new Set([
        ...nameTokens.flatMap(t => [t, ...t.split(/(?=[A-Z])/).map(s => s.toLowerCase())]),
        ...keywords.flatMap(k => tokenize(k)),
        ...capabilities.flatMap(c => tokenize(c))
    ]);

    return {
        name: tool?.name,
        raw: tool,
        tail: tail(tool?.name),
        description,
        descTokens: [...new Set(tokenize(description))],
        tokens: [...tokens],
        capabilities,
        keywords,
        domain: meta.domain ?? parsed.provider ?? parsed.source,
        destructive,
        risk: destructive ? "high"
            : ((meta.source ?? parsed.source) === "mcp") ? "external"
            : "low",
        // INVARIANT D: metadata eksternal tak menentukan trust. MCP
        // unknown BUKAN readOnly — semantik tak dikenal diasumsikan
        // berefek sampai diklasifikasi internal secara eksplisit.
        sideEffects: (meta.source ?? parsed.source) === "mcp"
            ? true
            : (meta.sideEffects !== undefined
                ? Boolean(meta.sideEffects)
                : destructive),
        readOnly: (meta.source ?? parsed.source) === "mcp"
            ? false
            : (meta.readOnly !== undefined
                ? Boolean(meta.readOnly)
                : !destructive && !meta.sideEffects),
        channels: Array.isArray(meta.channels) ? meta.channels : null,
        roles: Array.isArray(meta.roles) ? meta.roles : null,
        cost: Number.isFinite(meta.cost) ? meta.cost : null,
        latency: Number.isFinite(meta.latency) ? meta.latency : null,
        source: meta.source ?? parsed.source,
        provider: meta.provider ?? parsed.provider,
        external: (meta.source ?? parsed.source) === "mcp"
    };

}

/** Bangun index dari daftar tool terdaftar. */
function build(tools = []) {

    return (Array.isArray(tools) ? tools : []).map(describe);

}

/**
 * H10 Round-2 — PROVENANCE KANONIK (satu definisi "external").
 *
 * Semua subsistem (Authorization, SchemaMinimizer, Retriever, Ranker,
 * ToolSelector legacy) WAJIB memakai fungsi ini; pola `startsWith("mcp__")`
 * tersebar tidak lagi diizinkan sebagai definisi independen.
 *
 * @returns {{origin:"native"|"plugin"|"mcp", trustClass:"internal"|"installed"|"external-untrusted", external:boolean}}
 */
function provenanceOf(tool) {

    const parsed = parseName(tool?.name);

    const declaredSource = tool?.meta?.source ?? parsed.source;

    if (declaredSource === "mcp" || parsed.source === "mcp") {
        return { origin: "mcp",
                 trustClass: "external-untrusted",
                 external: true };
    }

    if (parsed.source === "plugin") {
        return { origin: "plugin",
                 trustClass: "installed",
                 external: false };
    }

    return { origin: "native", trustClass: "internal", external: false };

}

module.exports = { describe, build, parseName, tail, tokenize, provenanceOf };

