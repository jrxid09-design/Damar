/**
 * STABLE JSON — serialisasi deterministik (kunci terurut, tanpa siklus).
 *
 * Dipakai untuk: digest observasi (dedupe/konflik), validasi ukuran
 * atribut, dan hash identitas snapshot. Melempar bila value memuat
 * siklus atau berisi non-JSON — pemanggil wajib memperlakukan
 * kegagalan ini sebagai penolakan, bukan data.
 */

function stableStringify(value) {
    const seen = new Set();
    const encode = (v) => {

        if (v === null || typeof v === "number" || typeof v === "boolean") {
            return JSON.stringify(v ?? null);
        }

        if (typeof v === "string") return JSON.stringify(v);

        if (typeof v === "bigint") return JSON.stringify(String(v));

        if (Array.isArray(v)) {
            if (seen.has(v)) throw new Error("circular array");
            seen.add(v);
            const out = `[${v.map((x) => {
                const e = encode(x);
                return e === undefined ? "null" : e;
            }).join(",")}]`;
            seen.delete(v);
            return out;
        }

        if (typeof v === "object") {
            if (seen.has(v)) throw new Error("circular object");
            seen.add(v);
            const keys = Object.keys(v).sort();
            const parts = [];
            for (const k of keys) {
                const e = encode(v[k]);
                if (e === undefined) continue;   // fungsi/undefined dibuang
                parts.push(`${JSON.stringify(k)}:${e}`);
            }
            seen.delete(v);
            return `{${parts.join(",")}}`;
        }

        // function / symbol / undefined
        return undefined;
    };

    const out = encode(value);
    return out === undefined ? "null" : out;

}

/** Panjang byte UTF-8 dari bentuk stabil. */
function stableByteLength(value) {
    return Buffer.byteLength(stableStringify(value), "utf8");
}

module.exports = { stableStringify, stableByteLength };
