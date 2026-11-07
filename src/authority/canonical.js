/**
 * CANONICAL REPRESENTATION — CapabilityId (L-D2) & RestrictionSet (L-D1).
 *
 * L-D2: tidak ada keputusan otoritas yang bergantung pada formatting
 *       mentah ("Email.Send" vs "email__send" vs "email.send").
 *       Semua pembandingan memakai bentuk kanonik hasil fungsi ini.
 *
 * L-D1: RestrictionSet punya SATU kontrak normalisasi:
 *         undefined/null  -> UNRESTRICTED (eksplisit)
 *         string          -> singleton set (narrowing)
 *         Array<string>   -> set kanonik
 *         Set<string>     -> set kanonik
 *         lainnya         -> THROW AuthorityMalformedError (fail-closed)
 *       Object/Map/number/boolean TIDAK PERNAH ditafsirkan diam-diam
 *       sebagai unrestricted ataupun locked-down.
 *
 * Hasil selalu immutable (frozen).
 */

const crypto = require("node:crypto");

class AuthorityError extends Error {
    constructor(reasonCode, message, details = null) {
        super(message);
        this.name = "AuthorityError";
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

const CAP_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Kanonikalisasi CapabilityId:
 *   - trim + lowercase
 *   - semua varian separator ('__','::','.',spasi) dilipat menjadi '.'
 *   - segmen kosong ditolak, charset dibatasi [a-z0-9._-]
 */
function canonicalCapabilityId(raw) {
    if (typeof raw !== "string") {
        throw new AuthorityError("CAP_MALFORMED",
            `CapabilityId harus string, dapat: ${typeof raw}`,
            { received: String(raw) });
    }

    const source = raw.trim().toLowerCase();

    // Fail closed: whitespace internal dan dot malformed tidak boleh
    // diam-diam "diperbaiki" menjadi CapabilityId yang berbeda.
    if (!source ||
        /\s/.test(source) ||
        source.startsWith(".") ||
        source.endsWith(".") ||
        source.includes("..")) {
        throw new AuthorityError("CAP_MALFORMED",
            `CapabilityId tidak sah: '${String(raw).slice(0, 80)}'`,
            { raw: String(raw).slice(0, 80) });
    }

    // Hanya separator bridge yang memang didukung yang dikanonikalisasi.
    const id = source.replace(/(?:__|::)+/g, ".");

    if (!id ||
        id.startsWith(".") ||
        id.endsWith(".") ||
        id.includes("..") ||
        !CAP_ID_RE.test(id)) {
        throw new AuthorityError("CAP_MALFORMED",
            `CapabilityId tidak sah: '${String(raw).slice(0, 80)}'`,
            { raw: String(raw).slice(0, 80) });
    }

    return id;
}
/** Normalisasi daftar action/scope-token/purpose ke bentuk kanonik. */
function canonicalTokenList(input, field) {
    if (input === undefined || input === null) {
        throw new AuthorityError("CAP_MALFORMED",
            `${field} wajib ada (gunakan array kosong bila memang tanpa batas)`);
    }
    if (!Array.isArray(input)) {
        throw new AuthorityError("CAP_MALFORMED",
            `${field} harus array of string, dapat: ${typeof input}`);
    }
    const out = [];
    for (const item of input) {
        if (typeof item !== "string") {
            throw new AuthorityError("CAP_MALFORMED",
                `${field} berisi non-string: ${typeof item}`);
        }
        const t = item.trim().toLowerCase();
        if (!t) continue;
        out.push(t);
    }
    return Object.freeze([...new Set(out)].sort());
}

// ---- RestrictionSet -------------------------------------------------------

const RESTRICTION_KINDS = Object.freeze({
    UNRESTRICTED: "unrestricted",
    SET: "set",
    LOCKED: "locked"
});

/**
 * Kontrak kanonik L-D1. Selalu mengembalikan objek frozen:
 *   { kind:"unrestricted" }
 *   { kind:"locked", items:[] }
 *   { kind:"set", items:[...] }        // sorted, unique, non-empty
 * Malformed -> AuthorityError("CAP_MALFORMED", ...) FAIL-CLOSED.
 */
function canonicalRestrictionSet(input) {

    if (input === undefined || input === null) {
        return deepFreeze({ kind: RESTRICTION_KINDS.UNRESTRICTED });
    }

    if (typeof input === "string") {
        const one = input.trim();
        return one
            ? deepFreeze({ kind: RESTRICTION_KINDS.SET, items: deepFreeze([one]) })
            : deepFreeze({ kind: RESTRICTION_KINDS.LOCKED, items: deepFreeze([]) });
    }

    if (Array.isArray(input)) {
        return fromStrings(input, "array");
    }

    // Set<string> eksplisit didukung. Map / plain-object / iterable-pasang
    // adalah AMBIGU -> fail closed dengan diagnosa (L-D1).
    if (typeof input === "object") {
        if (input instanceof Set) {
            return fromStrings([...input], "Set");
        }
        throw new AuthorityError("CAP_MALFORMED",
            "RestrictionSet berbentuk object tidak ambigu-diterima; " +
            "gunakan Array<string>, Set<string>, atau string tunggal.",
            { receivedConstructor: input.constructor?.name ?? "object" });
    }

    throw new AuthorityError("CAP_MALFORMED",
        `RestrictionSet tipe tidak didukung: ${typeof input}`,
        { receivedType: typeof input });

    function fromStrings(list, srcName) {
        const items = [];
        for (const item of list) {
            if (typeof item !== "string") {
                throw new AuthorityError("CAP_MALFORMED",
                    `RestrictionSet (${srcName}) berisi non-string: ` +
                    typeof item);
            }
            const t = item.trim();
            if (t) items.push(t);
        }
        const uniq = [...new Set(items)].sort();
        return deepFreeze({
            kind: uniq.length ? RESTRICTION_KINDS.SET
                              : RESTRICTION_KINDS.LOCKED,
            items: deepFreeze(uniq)
        });
    }
}

/**
 * Equal-or-stricter attenuation untuk restriction CONSTRAINTS.
 *
 * Restriction adalah constraint yang MEMBATASI authority:
 * semakin banyak constraint => semakin sempit authority.
 *
 * UNRESTRICTED = tidak ada constraint.
 * LOCKED       = constraint maksimal / authority paling sempit.
 *
 * Maka:
 *   parent UNRESTRICTED -> child apa pun tidak melebar
 *   child UNRESTRICTED  -> melebar bila parent restricted
 *   child LOCKED        -> selalu equal-or-stricter
 *   parent LOCKED       -> hanya child LOCKED yang sah
 *   SET -> SET          -> semua constraint parent wajib dipertahankan child
 */
/**
 * Rehydrate RestrictionSet dari persistence internal.
 *
 * Berbeda dari canonicalRestrictionSet(): fungsi ini HANYA untuk bentuk
 * canonical object yang sudah pernah dipersist. Plain object dari caller
 * eksternal tetap ditolak oleh canonicalRestrictionSet() sesuai L-D1.
 */
function restoreCanonicalRestrictionSet(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AuthorityError("CAP_MALFORMED",
            "Stored RestrictionSet bukan canonical object");
    }

    if (value.kind === RESTRICTION_KINDS.UNRESTRICTED) {
        return canonicalRestrictionSet(null);
    }

    if (value.kind === RESTRICTION_KINDS.LOCKED) {
        if (!Array.isArray(value.items) || value.items.length !== 0) {
            throw new AuthorityError("CAP_MALFORMED",
                "Stored LOCKED RestrictionSet tidak sah");
        }
        return canonicalRestrictionSet("");
    }

    if (value.kind === RESTRICTION_KINDS.SET) {
        if (!Array.isArray(value.items) ||
            value.items.length === 0 ||
            value.items.some(x => typeof x !== "string" || !x.trim())) {
            throw new AuthorityError("CAP_MALFORMED",
                "Stored SET RestrictionSet tidak sah");
        }
        return canonicalRestrictionSet(value.items);
    }

    throw new AuthorityError("CAP_MALFORMED",
        `Stored RestrictionSet kind tidak sah: ${String(value.kind)}`);
}
function restrictionSubset(child, parent) {
    if (parent.kind === RESTRICTION_KINDS.UNRESTRICTED) return true;

    if (child.kind === RESTRICTION_KINDS.UNRESTRICTED) return false;

    if (child.kind === RESTRICTION_KINDS.LOCKED) return true;

    if (parent.kind === RESTRICTION_KINDS.LOCKED) return false;

    // Constraint semantics:
    // parent.items subset-of child.items.
    return parent.items.every(item => child.items.includes(item));
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    return "{" + Object.keys(value).sort().map(k =>
        JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function sha256(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

module.exports = {
    AuthorityError,
    canonicalCapabilityId,
    canonicalTokenList,
    canonicalRestrictionSet,
    restoreCanonicalRestrictionSet,
    restrictionSubset,
    RESTRICTION_KINDS,
    canonicalJson,
    sha256,
    deepFreeze
};
