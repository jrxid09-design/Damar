/**
 * ARGUMENT VALIDATOR V2 — satu validator otoritatif, rekursif berbatas.
 *
 * V1 hanya memeriksa level atas (temuan H10). V2 memvalidasi terhadap
 * schema PENUH dari registry (bukan schema prompt yang diminimalkan):
 *
 *   nested required / object / array, enum, const, union type
 *   ([type1,type2]), number/string/array bounds, pattern,
 *   additionalProperties:false
 *
 * Setiap kegagalan machine-readable:
 *   { code, path, expected, receivedType, constraint }  — TANPA nilai
 *   mentah (nilai bisa berisi rahasia; yang dilaporkan hanya tipenya).
 */

const CODES = {
    VALIDATION_ERROR: "VALIDATION_ERROR",
    PERMISSION_DENIED: "PERMISSION_DENIED",
    POLICY_DENIED: "POLICY_DENIED",
    TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
    EXECUTION_ERROR: "EXECUTION_ERROR",
    TIMEOUT: "TIMEOUT",
    CANCELLED: "CANCELLED"
};

const MAX_DEPTH = 16;

/** Buat error terstruktur; .code dipakai executor untuk klasifikasi. */
const NON_RETRYABLE = new Set([
    CODES.VALIDATION_ERROR,
    CODES.PERMISSION_DENIED,
    CODES.POLICY_DENIED,
    CODES.TOOL_NOT_FOUND,
    CODES.CANCELLED
]);

function make(code, message, details = null) {

    const error = new Error(message);

    error.code = code;

    error.toolError = true;

    // Kegagalan permanen tidak layak dicoba ulang oleh RetryExecutor.
    error.retryable = !NON_RETRYABLE.has(code);

    if (details) error.details = details;

    return error;

}

function isFilled(value) {
    return value !== undefined && value !== null && value !== "";
}

function receivedType(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

/** Normalisasi ringkas sesuai tipe skema — tanpa mengarang nilai. */
function coerce(value, type) {

    const types = Array.isArray(type) ? type : [type];

    for (const t of types) {
        if (t === "number" || t === "integer") {
            if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
                const n = Number(value.trim());
                return type === "integer" ? Math.trunc(n) : n;
            }
        }
        if (t === "boolean") {
            if (value === "true") return true;
            if (value === "false") return false;
        }
        if (t === "string" && typeof value === "number") {
            return String(value);
        }
    }

    return value;

}

function checkType(value, type) {

    if (type === undefined || type === null) return true;

    const types = Array.isArray(type) ? type : [type];

    return types.some(t => {
        switch (t) {
            case "string": return typeof value === "string";
            case "number": return typeof value === "number" && Number.isFinite(value);
            case "integer": return typeof value === "number" && Number.isInteger(value);
            case "boolean": return typeof value === "boolean";
            case "array": return Array.isArray(value);
            case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
            case "null": return value === null;
            default: return true;   // tipe tak dikenal: jangan menolak
        }
    });

}

/**
 * Validasi + normalisasi SATU panggilan terhadap schema penuh.
 * @returns {{ok:true,args}|{ok:false,error}}
 */
function validate(tool, args = {}) {

    if (args === null || args === undefined) args = {};

    if (typeof args === "string") {
        try { args = JSON.parse(args); }
        catch {
            return fail([], "Argumen berupa string yang bukan JSON valid.",
                { expected: "object" });
        }
    }

    if (typeof args !== "object" || Array.isArray(args)) {
        return fail([], `Argumen harus objek, diterima ${receivedType(args)}.`,
            { expected: "object", receivedType: receivedType(args) });
    }

    const schema = tool?.parameters;

    if (!schema || typeof schema !== "object") {
        return { ok: true, args };
    }

    const out = { ...args };

    const err = walk(out, schema, "", 0);

    if (err) return err;

    // Buang null eksplisit — banyak model mengirim null untuk opsional.
    for (const key of Object.keys(out)) {
        if (out[key] === null && !(schema.properties?.[key]?.type?.includes?.("null"))) {
            delete out[key];
        }
    }

    // F: kembalikan SALINAN TERNORMALISASI. Dulu `args` mentah yang
    // dikembalikan — hasil coerce() di walk() dibuang diam-diam, sehingga
    // {limit:"5"} tetap string sampai ke tool.
    return { ok: true, args: out };

}

/** Kembalikan kegagalan VALIDATION_ERROR terstruktur pada path tertentu. */
function fail(path, message, extra = {}) {
    return {
        ok: false,
        error: make(CODES.VALIDATION_ERROR, `${path ? `Parameter '${path}'`: "Argumen"}: ${message}`,
            { path: path || undefined, ...extra })
    };
}

/** Penelusuran rekursif berbatas kedalaman — tanpa stack overflow. */
function walk(node, schema, path, depth) {

    if (depth > MAX_DEPTH) {
        // Terlalu dalam untuk divalidasi → konservatif: terima apa adanya
        // (ToolGuard & tool sendiri tetap penjaga akhir), jangan crash.
        return null;
    }

    const props = schema?.properties ?? {};

    const required = Array.isArray(schema?.required) ? schema.required : [];

    // 1. Wajib ada & tidak kosong — KECUALI tipenya membolehkan null
    //    (union [..,"null"]): null sah, bukan "kosong".
    const allowsNull = (key) => {
        const t = props?.[key]?.type;
        return Array.isArray(t) ? t.includes("null") : false;
    };

    const missing = required.filter(key =>
        !isFilled(node?.[key]) && !(node?.[key] === null && allowsNull(key)));

    if (missing.length) {
        return fail(path, `Parameter wajib kosong: ${missing.join(", ")}.`,
            { missing, expected: Object.keys(props) });
    }

    // 2. additionalProperties:false → tolak properti asing.
    if (schema?.additionalProperties === false && props) {
        const stranger = Object.keys(node ?? {}).find(k => !(k in props));
        if (stranger !== undefined) {
            return fail(path ? `${path}.${stranger}` : stranger,
                `Properti '${stranger}' tidak diizinkan skema.`,
                { constraint: "additionalProperties=false", expected: Object.keys(props) });
        }
    }

    // 3. Periksa tiap properti yang dikenal.
    for (const [key, spec] of Object.entries(props)) {

        const childPath = path ? `${path}.${key}` : key;

        if (!(key in node) || !isFilled(node[key])) continue;

        let value = coerce(node[key], spec?.type);

        if (!checkType(value, spec?.type)) {
            return fail(childPath,
                `harus ${JSON.stringify(spec?.type)}, diterima ${receivedType(value)}.`,
                { expected: spec?.type, receivedType: receivedType(value),
                  constraint: "type" });
        }

        // Enum / const — nilai penuh, bukan versi pangkas.
        if (Array.isArray(spec?.enum) && spec.enum.length && !spec.enum.includes(value)) {
            return fail(childPath,
                `harus salah satu dari ${spec.enum.slice(0, 10).map(String).join(", ")}${spec.enum.length > 10 ? " …" : ""}.`,
                { allowed: spec.enum, constraint: "enum" });
        }

        if (spec?.const !== undefined && value !== spec.const) {
            return fail(childPath, `harus persis ${JSON.stringify(spec.const)}.`,
                { expected: spec.const, constraint: "const" });
        }

        // Batas angka.
        if (typeof value === "number") {
            for (const [constraint, cmp] of [
                ["minimum", (v, b) => v < b],
                ["maximum", (v, b) => v > b],
                ["exclusiveMinimum", (v, b) => v <= b],
                ["exclusiveMaximum", (v, b) => v >= b]
            ]) {
                if (Number.isFinite(spec?.[constraint]) && cmp(value, spec[constraint])) {
                    return fail(childPath, `melanggar ${constraint}=${spec[constraint]}.`,
                        { receivedType: "number", constraint });
                }
            }
        }

        // Batas string.
        if (typeof value === "string") {
            if (Number.isFinite(spec?.minLength) && value.length < spec.minLength) {
                return fail(childPath, `panjang < minLength=${spec.minLength}.`,
                    { constraint: "minLength" });
            }
            if (Number.isFinite(spec?.maxLength) && value.length > spec.maxLength) {
                return fail(childPath, `panjang > maxLength=${spec.maxLength}.`,
                    { constraint: "maxLength" });
            }
            if (spec?.pattern) {
                try {
                    if (!new RegExp(spec.pattern).test(value)) {
                        return fail(childPath, `tidak cocok pattern.`,
                            { constraint: `pattern:${String(spec.pattern).slice(0, 60)}` });
                    }
                }
                catch { /* pattern rusak: abaikan, jangan crash */ }
            }
        }

        // Batas array + item.
        if (Array.isArray(value)) {
            if (Number.isFinite(spec?.minItems) && value.length < spec.minItems) {
                return fail(childPath, `jumlah item < minItems=${spec.minItems}.`,
                    { constraint: "minItems" });
            }
            if (Number.isFinite(spec?.maxItems) && value.length > spec.maxItems) {
                return fail(childPath, `jumlah item > maxItems=${spec.maxItems}.`,
                    { constraint: "maxItems" });
            }
        }

        // Rekursi: objek bertingkat & array of objects.
        if (spec && typeof spec === "object") {

            if (spec.type === "object" && spec.properties &&
                typeof value === "object" && !Array.isArray(value)) {
                const sub = walk(value, spec, childPath, depth + 1);
                if (sub) return sub;
            }

            if (spec.type === "array" && spec.items &&
                typeof spec.items === "object" && Array.isArray(value)) {

                for (const [i, item] of value.entries()) {

                    if (spec.items.type === "object" && spec.items.properties &&
                        typeof item === "object" && !Array.isArray(item)) {
                        const sub = walk(item, spec.items, `${childPath}[${i}]`, depth + 1);
                        if (sub) return sub;
                        continue;
                    }

                    // Item primitif: tipe & enum tingkat item.
                    if (!checkType(item, spec.items.type)) {
                        return fail(`${childPath}[${i}]`,
                            `item harus ${JSON.stringify(spec.items.type)}, diterima ${receivedType(item)}.`,
                            { expected: spec.items.type, receivedType: receivedType(item), constraint: "type" });
                    }

                    if (Array.isArray(spec.items.enum) &&
                        spec.items.enum.length && !spec.items.enum.includes(item)) {
                        return fail(`${childPath}[${i}]`, `item di luar enum.`,
                            { allowed: spec.items.enum, constraint: "enum" });
                    }

                }

            }

        }

        node[key] = value;

    }

    return null;

}

module.exports = { validate, make, CODES };

