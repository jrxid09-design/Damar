/**
 * DELEGATION LAW (§Delegation) — attenuateGrant.
 *
 * Authority(child) = requested ∩ parent ∩ policy
 *
 * Tanpa ratifikasi baru, delegasi HANYA pernah MENGURANGI. Field mana pun
 * yang melebar menghasilkan violasi ber-reasonCode (bukan merge permisif).
 *
 * INHERITANCE (§attenuation-only): field yang TIDAK disebutkan pada
 * request diwarisi dari parent — bukan jatuh ke "unrestricted":
 *   - scope            diwarisi parent
 *   - allowedPurposes  diwarisi parent
 *   - identityBinding  diwarisi parent
 * Eksplicit [] / {} yang lebih longgar dari parent = WIDENING -> DENY.
 */
const {
    canonicalCapabilityId, canonicalTokenList,
    restrictionSubset, deepFreeze
} = require("./canonical");
const { normalizeRestrictionsForBuild } = require("./model");

const IDENTITY_DIMENSIONS = ["channels", "sessionIds", "principals"];

/**
 * ATENUASI IDENTITY BINDING PER-DIMENSI (§attenuation-only).
 *
 * Untuk setiap dimensi (channels/sessionIds/principals):
 *   - parent TIDAK mengikat dimensi  -> anak boleh mem-bind/narrow itu
 *   - parent mengikat dimensi:
 *       anak OMITS      -> warisi item parent
 *       anak kirim []   -> DENY CAP_IDENTITY_MISMATCH (kosong != inherit)
 *       anak subset     -> sah
 *       anak lebih luas -> DENY CAP_IDENTITY_MISMATCH
 *
 * Object parsial di-MERGE per dimensi — TIDAK PERNAH menormalkan
 * {} terkendali-parent menjadi null/unrestricted.
 */
function buildChildIdentityBinding(requestedBinding, parentBinding) {
    const violations = [];

    if (requestedBinding !== undefined && requestedBinding !== null &&
        (typeof requestedBinding !== "object" ||
         Array.isArray(requestedBinding))) {
        violations.push({ field: "identityBinding",
                          reasonCode: "CAP_MALFORMED",
                          value: "harus object" });
        return { binding: null, violations };
    }

    const parentDims = parentBinding ?? {};
    const req = requestedBinding ?? {};
    const merged = {};

    for (const dim of IDENTITY_DIMENSIONS) {
        const parentItems = Array.isArray(parentDims[dim])
            ? parentDims[dim] : [];
        const parentBound = parentItems.length > 0;

        // Omitted (atau undefined/null) -> warisi dimensi parent.
        if (!Object.prototype.hasOwnProperty.call(req, dim) ||
            req[dim] === undefined || req[dim] === null) {
            if (parentBound) merged[dim] = [...parentItems];
            continue;
        }

        const raw = req[dim];
        if (!Array.isArray(raw)) {
            violations.push({ field: `identityBinding.${dim}`,
                              reasonCode: "CAP_MALFORMED",
                              value: "harus array" });
            continue;
        }

        const items = [...new Set(raw.map(
            x => String(x).trim().toLowerCase()).filter(Boolean))];

        if (!items.length) {
            if (parentBound) {
                // [] eksplisit pada dimensi ter-ikat = melebar.
                violations.push({ field: `identityBinding.${dim}`,
                                  reasonCode: "CAP_IDENTITY_MISMATCH",
                                  value: "(kosong)" });
            }
            continue;                    // dimensi bebas: kosong = no-op
        }

        if (parentBound) {
            const wider = items.filter(x => !parentItems.includes(x));
            if (wider.length) {
                violations.push({ field: `identityBinding.${dim}`,
                                  reasonCode: "CAP_IDENTITY_MISMATCH",
                                  value: wider.join(",") });
                continue;
            }
        }
        merged[dim] = items;             // subset, atau parent bebas
    }

    return {
        binding: Object.keys(merged).length ? deepFreeze(merged) : null,
        violations
    };
}

/** Temporal expiry compare (§absolute-time): epoch ms, NaN fail-closed. */
function expiryViolations(parentExpiresAt, childExpiresAt) {
    const violations = [];
    const childMs = childExpiresAt == null ? null : Date.parse(childExpiresAt);
    const parentMs = parentExpiresAt == null ? null : Date.parse(parentExpiresAt);

    // Nilai tidak bisa diparse => fail closed.
    if (childExpiresAt != null && Number.isNaN(childMs)) {
        violations.push({ field: "expiry", reasonCode: "CAP_MALFORMED",
                          value: childExpiresAt });
        return violations;
    }
    if (parentExpiresAt != null && Number.isNaN(parentMs)) {
        violations.push({ field: "expiry", reasonCode: "CAP_MALFORMED",
                          value: parentExpiresAt });
        return violations;
    }
    // Child TIDAK BOLEH kedaluwarsa setelah parent (waktu absolut).
    if (childMs !== null && parentMs !== null && childMs > parentMs) {
        violations.push({ field: "expiry",
                          reasonCode: "CAP_DELEGATION_DENIED",
                          value: childExpiresAt });
    }
    return violations;
}

function attenuateGrant(parent, requested) {

    const violations = [];

    // ---- inheritance dulu: omitted = warisi parent ----------------------
    const inheritedScope = requested.scope === undefined ||
                           requested.scope === null;
    const inheritedPurposes = requested.allowedPurposes === undefined ||
                              requested.allowedPurposes === null;

    const childScopeSource = inheritedScope
        ? parent.scope
        : requested.scope;
    const childPurposesSource = inheritedPurposes
        ? parent.allowedPurposes
        : requested.allowedPurposes;

    const child = {
        capabilityId: canonicalCapabilityId(requested.capabilityId),
        kind: "delegated",
        subject: requested.subject ?? parent.subject,
        issuer: "delegation:" + parent.capabilityId,
        actions: canonicalTokenList(requested.actions ?? [], "actions"),
        scope: canonicalTokenList(childScopeSource ?? [], "scope"),
        allowedPurposes:
            canonicalTokenList(childPurposesSource ?? [], "allowedPurposes"),
        restrictions: requested.restrictions !== undefined
            ? normalizeRestrictionsForBuild(requested.restrictions)
            : parent.restrictions,
        maxExecutions: requested.maxExecutions ?? null,
        expiresAt: requested.expiresAt ?? parent.expiresAt ?? null,
        generation: parent.generation,
        delegationDepth: parent.delegationDepth + 1,
        remainingDelegationDepth: Math.max(0,
            parent.remainingDelegationDepth - 1),
        parentCapabilityId: parent.capabilityId,
        rootCapabilityId: parent.rootCapabilityId,
        purpose: requested.purpose ?? null,
        identityBinding: parent.identityBinding,
        ratificationId: null
    };

    // Identity attenuation PER-DIMENSI: merge + subset law.
    const ident = buildChildIdentityBinding(
        requested.identityBinding, parent.identityBinding);
    child.identityBinding = ident.binding;
    violations.push(...ident.violations);

    // ---- LAW: subset enforcement ---------------------------------------
    for (const action of child.actions) {
        if (!parent.actions.includes(action)) {
            violations.push({ field: "actions", reasonCode: "CAP_ACTION_DENIED",
                              value: action });
        }
    }
    for (const token of child.scope) {
        if (parent.scope.length && !parent.scope.includes(token)) {
            violations.push({ field: "scope", reasonCode: "CAP_SCOPE_MISMATCH",
                              value: token });
        }
    }
    // Scope kosong eksplisit ATAU hasil inherit kosong tidak boleh lebih
    // longgar dari parent ber-scope ([] = unrestricted saat authorize).
    if (parent.scope.length && !child.scope.length) {
        violations.push({ field: "scope", reasonCode: "CAP_SCOPE_MISMATCH",
                          value: "(kosong)" });
    }
    for (const p of child.allowedPurposes) {
        if (parent.allowedPurposes.length &&
            !parent.allowedPurposes.includes(p)) {
            violations.push({ field: "purpose",
                              reasonCode: "CAP_PURPOSE_MISMATCH", value: p });
        }
    }
    if (parent.allowedPurposes.length && !child.allowedPurposes.length) {
        violations.push({ field: "purpose",
                          reasonCode: "CAP_PURPOSE_MISMATCH",
                          value: "(kosong)" });
    }

    violations.push(...expiryViolations(parent.expiresAt, child.expiresAt));

    if (parent.remainingDelegationDepth <= 0) {
        violations.push({ field: "remainingDelegationDepth",
                          reasonCode: "CAP_DELEGATION_DENIED", value: 0 });
    }

    if (!restrictionSubset(child.restrictions, parent.restrictions)) {
        violations.push({ field: "restrictions",
                          reasonCode: "CAP_RESTRICTION_FAILED" });
    }

    // Budget: delegated wajib finite & <= parent sisa kuota efektif.
    if (typeof child.maxExecutions !== "number") {
        if (typeof parent.maxExecutions === "number") {
            child.maxExecutions = parent.maxExecutions;   // auto-narrow ke parent
        } else {
            violations.push({ field: "maxExecutions",
                              reasonCode: "CAP_DELEGATION_DENIED",
                              value: "unlimited-delegated" });
        }
    } else if (typeof parent.maxExecutions === "number" &&
               child.maxExecutions > parent.maxExecutions) {
        violations.push({ field: "maxExecutions",
                          reasonCode: "CAP_DELEGATION_DENIED",
                          value: child.maxExecutions });
    }

    if (violations.length) {
        return { ok: false, violations };
    }

    // ---- intersect semantics: child = requested ∩ parent ----------------
    if (!parent.actions.length) child.actions = child.actions;   // parent all
    else child.actions = child.actions.filter(a => parent.actions.includes(a));

    if (parent.allowedPurposes.length) {
        child.allowedPurposes = child.allowedPurposes.filter(
            p => parent.allowedPurposes.includes(p));
    }

    return { ok: true, grant: child };
}

module.exports = { attenuateGrant, expiryViolations,
                   buildChildIdentityBinding };
