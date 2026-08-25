/**
 * DELEGATION LAW (§Delegation) — attenuateGrant.
 *
 * Authority(child) = requested ∩ parent ∩ policy
 *
 * Tanpa ratifikasi baru, delegasi HANYA pernah MENGURANGI. Field mana pun
 * yang melebar menghasilkan violasi ber-reasonCode (bukan merge permisif).
 */
const {
    canonicalCapabilityId, canonicalTokenList,
    canonicalRestrictionSet, restrictionSubset
} = require("./canonical");

function attenuateGrant(parent, requested) {

    const violations = [];

    const child = {
        capabilityId: canonicalCapabilityId(requested.capabilityId),
        kind: "delegated",
        subject: requested.subject ?? parent.subject,
        issuer: "delegation:" + parent.capabilityId,
        actions: canonicalTokenList(requested.actions ?? [], "actions"),
        scope: canonicalTokenList(requested.scope ?? [], "scope"),
        allowedPurposes:
            canonicalTokenList(requested.allowedPurposes ?? [], "allowedPurposes"),
        restrictions: requested.restrictions !== undefined
            ? canonicalRestrictionSet(requested.restrictions)
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
        identityBinding: requested.identityBinding ?? parent.identityBinding,
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
    for (const p of child.allowedPurposes) {
        if (parent.allowedPurposes.length &&
            !parent.allowedPurposes.includes(p)) {
            violations.push({ field: "purpose",
                              reasonCode: "CAP_PURPOSE_MISMATCH", value: p });
        }
    }

    if (child.expiresAt && parent.expiresAt &&
        String(child.expiresAt) > String(parent.expiresAt)) {
        violations.push({ field: "expiry",
                          reasonCode: "CAP_DELEGATION_DENIED",
                          value: child.expiresAt });
    }

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

module.exports = { attenuateGrant };
