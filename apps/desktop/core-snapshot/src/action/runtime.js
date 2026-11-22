"use strict";

/**
 * ACTION AUTHORITY GATE V1 — runtime vocabulary + PURE validation predicate
 * (SEVENTH targeted repair, Wave 4 Lane 2: privileged composition removed
 * entirely from this module).
 *
 * CORE LAWS (preserved across repairs 5–7):
 *
 *   caller-selectable verifier != authenticated identity authority
 *   FIRST-BINDER-WINS TRUST IS NOT TRUST
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS (seventh repair)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * runtime.js is now a NON-PRIVILEGED module. It contains ONLY inert vocabulary
 * and a PURE non-authorizing predicate:
 *
 *   - DECISION / GATE_REASONS / ALLOW_REASON — inert frozen value vocabularies
 *     (re-exported from gate.js)
 *   - validateAuthorityEvaluation — PURE predicate: verifies a positive
 *     AuthorityEvaluation exactly matches the request the gate sent. It never
 *     authorizes, brands, or mints anything.
 *
 * There is NO factory, NO composition function, NO binder, NO token, NO host
 * capability, NO first-call-wins registry on this module or its exports.
 *
 * Privileged construction (the action authority runtime composition) lives
 * ONLY inside the trusted bootstrap layer's private closure
 * (src/action/bootstrap.js), as a private function defined in that module.
 * A downstream caller has NO importable surface through which privileged
 * construction can be obtained — first-importer, last-importer, or otherwise.
 *
 * Equivalent-binder names are likewise absent: no bindHost / acquireHost /
 * registerHost / installHost / claimComposition / bootstrapBind / hostToken /
 * getFactory / getComposer exists on any action module export.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PROCESS / MODULE ISOLATION LIMITATION (documented honestly)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This is a same-process CommonJS trust domain, NOT OS isolation. Node/CommonJS
 * path hiding is NOT hard sandboxing against code that already has arbitrary
 * same-process filesystem/require execution. What Lane 2 enforces is that the
 * ordinary/downstream Action API exposes NO authority-composition primitive at
 * all: canonical bootstrap owns composition (as a private function in its own
 * closure), downstream receives least-privilege facades only. The eventual
 * enforcement against untrusted executable extensions is module loader
 * allowlisting, sandboxing, workers/process isolation, or equivalent.
 *
 *   VALID SHAPE != TRUSTED ORIGIN
 *   VALID ORIGIN IN DOMAIN A != TRUSTED IN DOMAIN B
 */

const { DECISION, GATE_REASONS, ALLOW_REASON, validateAuthorityEvaluation } = require("./gate");

module.exports = {
    // Inert frozen value vocabularies + PURE non-authorizing predicate ONLY.
    // No factory, no composition function, no binder, no token.
    DECISION,
    GATE_REASONS,
    ALLOW_REASON,
    validateAuthorityEvaluation
};
