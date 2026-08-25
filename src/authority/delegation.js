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
    restrictionSubset
} = require("./canonical");
const { normalizeIdentityBinding,
        normalizeRestrictionsForBuild } = require("./model");

const IDENTITY_DIMENSIONS = ["channels", "sessionIds", "principals"];

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

/**
 * Identity binding anak harus equal-or-narrower PER DIMENSI.
 * Dimensi yang tidak disebut anak mewarisi parent.
 * Parent tanpa binding = unbound; anak boleh menambahkan binding
 * (itu pempersempit). Kebalikannya tidak.
 */
function identityBindingViolations(childBinding, parentBinding) {
    const violations = [];
    if (parentBinding === null || parentBinding === undefined) {
        return violations;
    }
    if (childBinding === null || childBinding === undefined) {
        return violations;
    }
    for (const dim of IDENTITY_DIMENSIONS) {
        const parentItems = Array.isArray(parentBinding[dim])
            ? parentBinding[dim] : [];
        const childItems = Array.isArray(childBinding[dim])
            ? childBinding[dim] : [];
        if (!parentItems.length) continue;          // dimensi bebas -> boleh
        const wider = childItems.filter(x => !parentItems.includes(x));
        if (wider.length) {
            violations.push({
                field: `identityBinding.${dim}`,
                reasonCode: "CAP_IDENTITY_MISMATCH",
                value: wider.join(",")
            });
        }
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
        identityBinding: requested.identityBinding !== undefined &&
                         requested.identityBinding !== null
            ? normalizeIdentityBinding(requested.identityBinding)
            : parent.identityBinding,
        ratificationId: null
    };

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

    // Identity binding: equal-or-narrower per dimensi.
    violations.push(...identityBindingViolations(
        child.identityBinding, parent.identityBinding));

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
                   identityBindingViolations };
