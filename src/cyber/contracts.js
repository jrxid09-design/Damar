"use strict";
/**
 * DCD PREP — contracts, enums and structural evaluators for the
 * DAMAR CYBER OPERATIONS PLATFORM.
 *
 * NON-PRODUCTION. Lives outside every production source tree on purpose
 * (same rule as the Wave 7–10 prep package). ZERO production file is
 * modified by this track.
 *
 * Vocabulary imported, not invented:
 *   - tiers T0..T12 and epistemic classes  <- DAMAR_TRUTH_LATTICE.md
 *   - law constants object shape           <- DAMAR_FINAL_INVARIANTS.md
 *   - closed-key / authority-shaped-key rejection <- Wave 10 prep contracts.js
 *
 * DCD owns NO truth tier of its own. Cyber records may only be written at
 * T4/T5/T7/T10 (see ALLOWED_TIERS). T1 comes from Verification and T3 from
 * Authority; DCD is a consumer of both. T11 PLAN is the Mission owner's tier:
 * DCD stages a cyber plan, it never writes the tier (audit 4, P2-8).
 */

/* ------------------------------------------------------------------ planes */

const PLANES = Object.freeze([
    "SENSOR",        // telemetry, discovery, observations — no execution authority
    "CYBER_STATE",   // cyber world model, security knowledge graph, evidence fabric
    "INTELLIGENCE",  // detection, correlation, hypothesis, path reasoning, triage
    "MISSION",       // objective, scope, authorization envelope, budgets
    "ACTION",        // scanners, drivers, tooling — never bypasses the envelope
    "ASSURANCE"      // verification, evidence, audit, cleanup, rollback, retest
]);

/** Mission modes. NOT separate runtime architectures (all share one substrate). */
const OPERATION_MODES = Object.freeze([
    "DCD_DEFENSE", "DCD_OFFSEC", "DCD_PURPLE", "DCD_LAB", "DCD_HUNT", "DCD_FORENSICS"
]);

/* --------------------------------------------------------------- offsec depth */

const OFFSEC_DEPTHS = Object.freeze([
    "LEVEL_0",  // passive observation
    "LEVEL_1",  // safe enumeration
    "LEVEL_2",  // non-destructive validation
    "LEVEL_3",  // controlled exploit validation
    "LEVEL_4",  // privilege / pivot validation
    "LEVEL_5"   // destructive / persistence / exfiltration simulation
]);

const depthRank = (d) => OFFSEC_DEPTHS.indexOf(d);

/** Fail-closed default: L4/L5 are disabled unless the mission grants them explicitly. */
const DEFAULT_OFFSEC_DEPTH = "LEVEL_2";
const DEPTH_REQUIRES_EXPLICIT_OPT_IN = Object.freeze(["LEVEL_4", "LEVEL_5"]);

/* --------------------------------------------------------------- risk / response */

const RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const riskRank = (r) => {
    const i = RISK_LEVELS.indexOf(r);
    if (i < 0) throw new Error(`dcd: unknown risk level '${r}'`);
    return i;
};

/**
 * A frozen lookup table with NO prototype. `Object.freeze({...})` still inherits
 * from `Object.prototype`, so `TABLE[callerSuppliedKey]` for the keys
 * `constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__` or
 * `isPrototypeOf` returns a FUNCTION rather than `undefined` — and every
 * "is this key known?" check of the form `if (!TABLE[key]) return UNKNOWN`
 * passes, then throws a raw TypeError on the next line. That is the DC-119 class
 * (`the decision function is total on both sides`): a throw is not a decision, and
 * these functions document a reason code. Four tables are read this way —
 * PROFILE_RANK, VERIFICATION_REQUIREMENTS, SOURCE_TIER_BINDINGS and
 * INCIDENT_TRANSITIONS — and each had a different symptom (a TypeError four
 * different ways, plus `verificationProfileRank` returning the `Object`
 * constructor). Fixing the PROTOTYPE fixes every read site at once; adding
 * `Object.hasOwn` at each site would recreate the "guard present at some sites"
 * shape this corpus has spent four audits closing (audit 11, DC-187).
 */
const frozenLookup = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

/** Risk-adaptive response tiers. Higher consequence => stronger authority + verification. */
const RESPONSE_TIERS = frozenLookup({
    LOW: Object.freeze(["telemetry", "snapshot", "safe_inspection"]),
    MEDIUM: Object.freeze(["bounded_process_action", "bounded_session_action"]),
    HIGH: Object.freeze(["host_isolation", "credential_revocation", "firewall_change"]),
    CRITICAL: Object.freeze(["mass_isolation", "mass_credential_rotation", "destructive_remediation"])
});

const VERIFICATION_PROFILES = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * Capabilities whose completion ALWAYS carries the credential-rotation
 * requirement, whatever profile the envelope declares.
 *
 * `CREDENTIAL_ROTATION` is a requirement SET, not a severity rung, so it is
 * deliberately not a legal `verification_policy` (an envelope names a severity;
 * an action names its own extra evidence). But DC-67's prose — "a rotation
 * without the dependent-services check is refused" — was true only for a caller
 * that chose to pass that profile by name: a HIGH-policy envelope permitting
 * `credential_revocation` completed on three generic postconditions, and no
 * envelope could demand the rotation set at all (audit 5, P2-4). The requirement
 * is now ADDITIVE: it follows the action, not the caller's diligence.
 */
const ROTATION_CAPABILITIES = Object.freeze(["credential_revocation", "mass_credential_rotation"]);

/**
 * The published action-tier vocabulary: every capability with a tier, which is
 * exactly the `RESPONSE_TIERS` value set. ME-13 derives the verification floor
 * from this list, so a capability that is NOT here contributes no floor.
 *
 * That is deliberate rather than an oversight: a *probe* capability
 * (`http-probe`, `tls-scan`) is an action class with no consequential tier, and
 * it must be listable without asserting a tier it does not have. What the code
 * must not do is treat an unranked capability as *harmless*, so
 * `unrankedCapabilities` reports them and a test asserts every tier name
 * resolves to its own tier. Two consequences are stated in the docs and not
 * enforced in code, and are recorded as residuals: a producer can spell a
 * consequential capability outside this list and get no floor from it, and
 * `allowed_methods` is NOT tier-bearing (a method is a protocol verb such as
 * `GET`, not an action class) — audit 5, P2-3.
 */
const CAPABILITY_VOCABULARY = Object.freeze(
    Object.values(RESPONSE_TIERS).flat()
);

/**
 * A token list, or an empty one. A capability/scope list read out of a
 * caller-supplied envelope may be any type, and `for (const x of (v ?? []))`
 * throws `is not iterable` for `42`/`true`/`{}` while `(v ?? []).filter` throws
 * `is not a function`. A throw is not a decision (audit 4/10/11, P1-1), so every
 * reader normalises through this and the VALIDATOR reports the bad type.
 */
const asArray = (v) => (Array.isArray(v) ? v : []);

/** The capabilities in an envelope that contribute no tier floor. */
function unrankedCapabilities(envelope) {
    return asArray(envelope?.allowed_capabilities).filter((c) => tierForAction(c) === null);
}

/**
 * Every profile KEY, ranked, so the envelope floor is total over keys rather
 * than only over `VERIFICATION_PROFILES` (audit 3, P1-6). `CREDENTIAL_ROTATION`
 * is a first-class profile with its own requirement set but is not on the
 * severity scale; it is ranked HIGH, and a CRITICAL-policy envelope therefore
 * refuses it. Fail-closed: an unrankable profile can never satisfy a floor.
 */
const PROFILE_RANK = frozenLookup({
    LOW: 0, MEDIUM: 1, HIGH: 2, CREDENTIAL_ROTATION: 2, CRITICAL: 3
});

const verificationProfileRank = (p) => {
    const i = PROFILE_RANK[p];
    if (i === undefined) throw new Error(`dcd: unknown verification profile '${p}'`);
    return i;
};

/**
 * VR-3 / DC-62: the verification profile is DERIVED FROM THE ACTION TIER, never
 * chosen freely and never from an agent's confidence. The tier of an action is
 * its `RESPONSE_TIERS` class, and the minimum verification profile for a tier is
 * the tier itself — a `CRITICAL` action cannot be verified at `LOW`.
 *
 * `requiredPolicyFor` computes the floor an envelope's own permissions demand,
 * so an envelope that permits `destructive_remediation` (a `CRITICAL` action)
 * cannot declare `verification_policy: "LOW"` at construction. Without this the
 * field was a free input with no derivation, which is exactly what the invariant
 * claimed it was not (independent audit 3, P1-9 / DC-62).
 */
const tierForAction = (action) => {
    for (const [tier, actions] of Object.entries(RESPONSE_TIERS)) {
        if (actions.includes(action)) return tier;
    }
    return null;
};

const requiredPolicyFor = (env = {}) => {
    // `null` is not covered by a destructuring `= {}` default, so
    // `requiredPolicyFor(null)` threw `Cannot destructure property ... of null`
    // (audit 11, P2-4). An unreadable envelope contributes no floor, which is the
    // restrictive answer; the validator reports the shape.
    const { destructive_actions_allowed, persistence_allowed,
        exfiltration_policy, offsec_depth, allowed_capabilities } = isPlainObject(env) ? env : {};
    let floor = "LOW";
    // Total: an unknown depth is not a LOW depth, it is an unusable one, so it
    // raises the floor rather than throwing out of a decision path.
    if (offsec_depth !== undefined && offsec_depth !== null) {
        if (!OFFSEC_DEPTHS.includes(offsec_depth)) return "CRITICAL";
        if (depthRank(offsec_depth) >= depthRank("LEVEL_4")) floor = "HIGH";
    }
    if (persistence_allowed || (exfiltration_policy && exfiltration_policy !== "NONE")) floor = "HIGH";
    if (destructive_actions_allowed) floor = "CRITICAL";
    // DC-62 is "the profile comes from the ACTION TIER". The action tier is named
    // by the capabilities the envelope PERMITS, so permitting a CRITICAL-tier
    // capability (`mass_isolation`, `mass_credential_rotation`,
    // `destructive_remediation`) sets the floor just as a destructive flag does.
    // Without this, `allowed_capabilities: ["mass_isolation"]` with
    // `verification_policy: "LOW"` constructed, fast-pathed and completed on one
    // postcondition check (audit 4, P1-3).
    for (const capability of asArray(allowed_capabilities)) {
        const tier = tierForAction(capability);
        if (tier && verificationProfileRank(tier) > verificationProfileRank(floor)) floor = tier;
    }
    return floor;
};

/**
 * What each verification profile MUST observe before completion may be trusted.
 * NO_TRUSTED_COMPLETION_WITHOUT_REQUIRED_VERIFICATION.
 */
const VERIFICATION_REQUIREMENTS = frozenLookup({
    LOW: Object.freeze(["post_state"]),
    MEDIUM: Object.freeze(["post_state", "process_state"]),
    HIGH: Object.freeze(["post_state", "dependent_health", "rollback_available"]),
    CRITICAL: Object.freeze([
        "post_state", "dependent_health", "rollback_available",
        "blast_radius_within_budget", "rollback_executed_or_waived"
    ]),
    CREDENTIAL_ROTATION: Object.freeze([
        "old_credential_rejected", "new_credential_works", "dependent_services_healthy"
    ])
});

/* --------------------------------------------------------------- workload / caching */

const WORKLOAD_CLASSES = Object.freeze(["REAL_TIME", "NEAR_REAL_TIME", "BACKGROUND"]);

/**
 * Cacheable kinds. `PERMISSION_EVALUATION` is deliberately NOT a member: a
 * cached permission outcome is exactly the forbidden "local may-I cache", and
 * the rule is expressed structurally (the kind does not exist) rather than as a
 * markdown warning. `NO_CACHED_PERMISSION_OUTCOME` (DC-59).
 */
const CACHE_KINDS = Object.freeze([
    "DNS", "SERVICE_FINGERPRINT", "ASSET_METADATA", "CVE_MAPPING", "THREAT_INTEL",
    "PROVIDER_RESULT", "GRAPH_QUERY"
]);

/** Named so the refusal is diagnosable rather than merely "unknown kind". */
const NEVER_CACHEABLE_KINDS = Object.freeze([
    "PERMISSION_EVALUATION", "AUTHORITY_DECISION", "GRANT", "LEASE", "ENVELOPE_VALIDITY"
]);

/** Every security cache entry carries these or it is not admissible as a cache. */
const CACHE_REQUIRED_FIELDS = Object.freeze([
    "cacheKind", "scope", "provenance", "observedAt", "ttlMs", "invalidation"
]);

/* --------------------------------------------------------------- boundary changes */

/**
 * The ONLY reasons a valid mission envelope stops being sufficient.
 * Anything not in this set is NOT a boundary change and must not trigger a
 * global authorization round-trip (BOUNDARY PERMISSION != BOUNDARY EVERY STEP).
 */
const BOUNDARY_CHANGE_KINDS = Object.freeze([
    "NEW_TARGET", "NEW_SCOPE", "NEW_PRIVILEGE_LEVEL", "NEW_CREDENTIAL_CLASS",
    "DESTRUCTIVE_EFFECT", "PERSISTENCE", "NEW_DATA_ACCESS_CLASS",
    "HIGHER_RISK", "LARGER_BLAST_RADIUS", "NEW_PIVOT", "MISSION_EXPIRY", "MISSION_NOT_YET_OPEN",
    // Crossing an exploit-depth rung is its own boundary change, distinct from a
    // privilege change or persistence (audit 5, ADVISORY-1).
    "DEEPER_EXPLOIT",
    // Data leaving the estate is its own boundary change, with its own envelope
    // field. Omitting it made `exfiltration_policy` a declared control that
    // controlled nothing (audit 2, P1-N2).
    "EXFILTRATION"
]);

/** Ordered so that "exceeds the budget" is a rank comparison, not a guess. */
const NETWORK_SCOPES = Object.freeze(["NONE", "SINGLE_HOST", "SUBNET", "SITE", "WHOLE_ESTATE"]);
const DATA_SCOPES = Object.freeze([
    "NONE", "METADATA_ONLY", "PROOF_OF_ACCESS_ONLY", "CONTENT", "FULL"
]);
const EXFILTRATION_POLICIES = Object.freeze([
    "NONE", "PROOF_OF_ACCESS_ONLY", "AUTHORIZED_DATA"
]);

/**
 * The CLOSED key sets of the mission envelope and its four nested budgets.
 *
 * The envelope is the one DCD shape that was never scanned for forbidden or
 * secret-bearing keys, and the reason is instructive: nearly every field name in
 * it is authority-shaped BY DESIGN (`authorized_scope`, `allowed_capabilities`,
 * `authority_reference`, `credential_policy`), so a scan without an allowlist
 * refuses the whole legitimate shape and the tempting move is no scan at all.
 *
 * A closed key set is the correct answer, not a wider pattern: it says exactly
 * which names this shape may carry, and everything else — `password` under
 * `credential_policy`, `apiKey` under `rate_budget`, `grant` under
 * `time_window` — is then an unknown key rather than an excused one. The four
 * nested budgets each get their own set, so a legitimate name in one is not
 * silently accepted in another (audit 7, P1-1).
 */
const MISSION_ENVELOPE_KEYS = Object.freeze([
    "mission_id", "principal", "objective", "authorized_scope", "asset_scope",
    "allowed_capabilities", "allowed_methods", "prohibited_methods", "max_risk_level",
    "rate_budget", "time_window", "max_concurrency", "data_access_limit",
    "credential_policy", "allowed_pivot_depth", "offsec_depth", "depth_explicit_grants",
    "persistence_allowed", "destructive_actions_allowed", "exfiltration_policy",
    "blast_radius_budget", "cleanup_required", "verification_policy",
    "authority_reference", "operation_mode"
]);
const RATE_BUDGET_KEYS = Object.freeze(["requestsPerMinute"]);
const TIME_WINDOW_KEYS = Object.freeze(["start", "end"]);
const CREDENTIAL_POLICY_KEYS = Object.freeze(["leaseOnly", "maxLeaseMs"]);
const BLAST_RADIUS_BUDGET_KEYS = Object.freeze([
    "max_hosts", "max_accounts", "max_processes",
    "max_network_scope", "max_duration_ms", "max_data_scope"
]);

/** The nested-budget key sets, as one table so the rules iterate rather than repeat. */
const ENVELOPE_NESTED_KEY_SETS = Object.freeze({
    rate_budget: RATE_BUDGET_KEYS,
    time_window: TIME_WINDOW_KEYS,
    credential_policy: CREDENTIAL_POLICY_KEYS,
    blast_radius_budget: BLAST_RADIUS_BUDGET_KEYS
});

const rankIn = (list, value, label) => {
    const i = list.indexOf(value);
    if (i < 0) throw new Error(`dcd: unknown ${label} '${value}'`);
    return i;
};
const networkScopeRank = (v) => rankIn(NETWORK_SCOPES, v, "network scope");
const dataScopeRank = (v) => rankIn(DATA_SCOPES, v, "data scope");
const exfiltrationRank = (v) => rankIn(EXFILTRATION_POLICIES, v, "exfiltration policy");

/**
 * The closed key set of a proposed attempt. An attempt is classified against
 * this vocabulary and nothing else: an unknown key is refused rather than
 * silently ignored, because a silently-ignored `risk_level` is an attempt that
 * never escalates (audit 2, P1-N3 / P2-N10).
 */
const ATTEMPT_KEYS = Object.freeze([
    "at", "capability", "method", "targets", "scopeTokens", "privilegeLevel",
    "credentialClass", "dataAccessClass", "riskLevel", "pivotDepth", "exploitDepth",
    "persistence", "destructive", "exfiltration", "blastRadius", "usage",
    "retryAfterMs", "note"
]);

/**
 * Source kinds that may ONLY ever appear at certain tiers / epistemic classes,
 * so the lab-vs-estate separation is declarative rather than incidental
 * (audit 2 P2-N8/P2-N12; audit 3 P1-8).
 *
 * This table is **total over `EVIDENCE_SOURCE_KINDS`**: every source kind is
 * either bound to its permitted tiers, or explicitly declared `null` to mean
 * "any DCD-writable tier". A test asserts the two sets are equal, so adding a
 * source kind forces a decision here rather than defaulting to unconstrained —
 * the previous partial table listed `sandbox_result`, which is not a source kind
 * at all, and left 16 of 18 kinds unbound, so external `threat_intel` could be
 * written as a local `T4 OBSERVED` fact (contradicting PC-4).
 */
const SOURCE_TIER_BINDINGS = frozenLookup({
    // local first-party sensors — any DCD-writable tier
    host: null, network: null, identity: null, application: null, cloud: null,
    container: null, dns: null, http: null, authentication: null, process: null,
    filesystem: null,
    // local derived analysis — an observation OF a tool's output, or the tool's
    // own derivation; never a belief about the target at observation strength
    security_tooling: Object.freeze({ tiers: Object.freeze(["T4", "T7"]), epistemicClasses: Object.freeze(["OBSERVED", "DERIVED"]) }),
    malware_analysis: Object.freeze({ tiers: Object.freeze(["T4", "T7"]), epistemicClasses: Object.freeze(["OBSERVED", "DERIVED"]) }),
    deception: Object.freeze({ tiers: Object.freeze(["T4"]), epistemicClasses: Object.freeze(["OBSERVED"]) }),
    // external claims — never a local observation
    threat_intel: Object.freeze({ tiers: Object.freeze(["T5"]), epistemicClasses: Object.freeze(["ASSERTED"]) }),
    credential_discovery: Object.freeze({ tiers: Object.freeze(["T5"]), epistemicClasses: Object.freeze(["ASSERTED"]) }),
    teacher: Object.freeze({ tiers: Object.freeze(["T5"]), epistemicClasses: Object.freeze(["ASSERTED"]) }),
    // isolated environments — never an estate observation
    cyber_range: Object.freeze({ tiers: Object.freeze(["T10"]), epistemicClasses: Object.freeze(["SIMULATED"]) })
});

/** `sandbox_result` was in this table but is not a source kind; it is gone, not renamed. */
const REMOVED_SOURCE_BINDINGS = Object.freeze(["sandbox_result"]);

/** Outcome of a local envelope decision. Exactly one. */
const LOCAL_DECISIONS = Object.freeze([
    "FAST_PATH",     // execute now, local verification only
    "BUDGET_HOLD",   // envelope still valid, budget/time not available — wait, no re-auth
    "ESCALATE",      // a boundary changed — Mission Orchestrator + Authority Gate
    "DENY"           // prohibited by the envelope or by law; escalation cannot fix this
]);

/* --------------------------------------------------------------- cyber graph */

const GRAPH_ENTITIES = Object.freeze([
    "Host", "Device", "Service", "Identity", "Account", "Session", "Token", "Role",
    "Permission", "Application", "API", "CloudResource", "Container", "Cluster",
    "Vulnerability", "Weakness", "Finding", "Evidence", "Incident", "Malware",
    "Control", "CredentialRef", "AttackPath", "Mission"
]);

const GRAPH_RELATIONS = Object.freeze([
    "runs", "connects_to", "trusts", "authenticates_to", "accessible_from", "controls",
    "depends_on", "contains", "has_permission", "can_assume", "vulnerable_to",
    "observed_on", "supports", "contradicts", "blocks", "validated_by"
]);

/**
 * Attack-path edge states. Ordered by evidentiary strength; the ordering is
 * deliberately NOT an authority ordering.
 * THEORETICAL PATH != VALIDATED PATH != AUTHORIZED PATH.
 */
const EDGE_STATES = Object.freeze([
    "OBSERVED", "INFERRED", "VALIDATED", "EXPLOITABLE", "BLOCKED", "AUTHORIZED_TO_TEST"
]);

const edgeRank = (s) => {
    const i = EDGE_STATES.indexOf(s);
    if (i < 0) throw new Error(`dcd: unknown edge state '${s}'`);
    return i;
};

/** Bounded attack-path query. Unbounded traversal is a lane-freeze blocker. */
const ATTACK_PATH_QUERY_BOUNDS = Object.freeze({
    DEFAULT_MAX_DEPTH: 6, MAX_MAX_DEPTH: 12,
    DEFAULT_TOP_K: 20, MAX_TOP_K: 200,
    DEFAULT_TIME_BUDGET_MS: 250, MAX_TIME_BUDGET_MS: 2000,
    MAX_ASSET_SCOPE: 1000,
    REQUIRE_ASSET_SCOPE: true
});

/* --------------------------------------------------------------- incident */

const INCIDENT_STATES = Object.freeze([
    "OBSERVED", "SUSPICIOUS", "HYPOTHESIS_OPEN", "CORROBORATING",
    "INCIDENT_CONFIRMED", "INCIDENT_REJECTED",
    "CONTAINMENT_PROPOSED", "AUTHORIZED", "CONTAINING", "VERIFYING",
    "CONTAINED", "RECOVERING", "RECOVERED", "POST_INCIDENT"
]);

/**
 * Allowed transitions. CONFIRMED and AUTHORIZED are deliberately NOT collapsed:
 * no state may reach CONTAINING from INCIDENT_CONFIRMED without passing
 * CONTAINMENT_PROPOSED -> AUTHORIZED.
 */
const INCIDENT_TRANSITIONS = frozenLookup({
    OBSERVED: Object.freeze(["SUSPICIOUS", "INCIDENT_REJECTED"]),
    SUSPICIOUS: Object.freeze(["HYPOTHESIS_OPEN", "INCIDENT_REJECTED"]),
    HYPOTHESIS_OPEN: Object.freeze(["CORROBORATING", "INCIDENT_REJECTED"]),
    CORROBORATING: Object.freeze(["INCIDENT_CONFIRMED", "INCIDENT_REJECTED"]),
    INCIDENT_CONFIRMED: Object.freeze(["CONTAINMENT_PROPOSED", "POST_INCIDENT"]),
    INCIDENT_REJECTED: Object.freeze(["POST_INCIDENT"]),
    CONTAINMENT_PROPOSED: Object.freeze(["AUTHORIZED", "INCIDENT_REJECTED"]),
    AUTHORIZED: Object.freeze(["CONTAINING"]),
    CONTAINING: Object.freeze(["VERIFYING"]),
    VERIFYING: Object.freeze(["CONTAINED", "CONTAINING"]),
    CONTAINED: Object.freeze(["RECOVERING"]),
    RECOVERING: Object.freeze(["RECOVERED"]),
    RECOVERED: Object.freeze(["POST_INCIDENT"]),
    POST_INCIDENT: Object.freeze([])
});

/* --------------------------------------------------------------- evidence */

const EVIDENCE_SOURCE_KINDS = Object.freeze([
    "host", "network", "identity", "application", "cloud", "container", "dns", "http",
    "authentication", "process", "filesystem", "security_tooling", "threat_intel",
    "deception", "malware_analysis", "credential_discovery", "teacher", "cyber_range"
]);

/* --------------------------------------------------------------- teacher */

const TEACHER_KINDS = Object.freeze([
    "DAYBREAK_BLUE", "OTHER_MODEL", "STRONGER_SELF_CHECKPOINT",
    "DETERMINISTIC_TOOL", "SANDBOX_RESULT", "INDEPENDENT_VERIFIER", "HUMAN_OWNER"
]);

const TEACHER_OUTPUT_CLASSES = Object.freeze([
    "OBSERVATIONS", "HYPOTHESES", "SUPPORTING_EVIDENCE", "CONTRADICTING_EVIDENCE",
    "UNCERTAINTIES", "NEXT_TEST", "EXPECTED_RESULT", "STOP_CONDITION",
    "VERIFICATION", "REMEDIATION"
]);

const VERIFIER_RESULTS = Object.freeze([
    "VERIFIED", "REFUTED", "INSUFFICIENT_EVIDENCE", "CONTRADICTED"
]);

/**
 * Where a sample's evidence came from. Load-bearing: a `LAB` or `SYNTHETIC`
 * exploit claim must never be recorded or presented as an `ESTATE` result
 * (KD §7.1, threat model AB-23).
 */
const SCOPE_TYPES = Object.freeze(["LAB", "ESTATE", "SYNTHETIC"]);

const DISTILL_DATA_FAMILIES = Object.freeze([
    "DCD-DISTILL-RECON", "DCD-DISTILL-WEB", "DCD-DISTILL-API", "DCD-DISTILL-NETWORK",
    "DCD-DISTILL-IDENTITY", "DCD-DISTILL-CLOUD", "DCD-DISTILL-K8S", "DCD-DISTILL-CODE",
    "DCD-DISTILL-MALWARE", "DCD-DISTILL-FORENSICS", "DCD-DISTILL-INCIDENT",
    "DCD-DISTILL-ATTACK-GRAPH", "DCD-DISTILL-REMEDIATION", "DCD-DISTILL-VERIFICATION"
]);

const TEACHER_ESCALATION_TRIGGERS = Object.freeze([
    "BASELINE_UNCERTAINTY_HIGH", "SCENARIO_DIFFICULTY_HIGH", "STUDENT_FAILED_VERIFIER",
    "TEACHER_DISAGREEMENT_HIGH", "NOVEL_ATTACK_PATH", "NEW_TECHNOLOGY", "HIGH_VALUE_HARD_EXAMPLE"
]);

/* --------------------------------------------------------------- tiers */

/** Tiers a DCD-owned record may carry. T1 = Verification, T3 = Authority. */
const ALLOWED_TIERS = Object.freeze(["T4", "T5", "T7", "T10"]);
const DCD_FORBIDDEN_TIERS = Object.freeze(["T0", "T1", "T2", "T3", "T6", "T8", "T9", "T11", "T12"]);

const EPISTEMIC_CLASSES = Object.freeze([
    "OBSERVED", "DERIVED", "DECLARED", "VERIFIED", "CACHED", "STALE", "SIMULATED", "ASSERTED"
]);

/**
 * Authority-shaped keys. Presence is a security event, not a schema error.
 * Mirrors the Wave 10 prep contract (F-12) and the ActionIntent token filter.
 */
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
    "allow", "authoriz", "permission", "grant", "approve", "authority",
    "capabilit", "execute", "dispatch", "policy", "privilege", "bypass", "permit"
]);

/**
 * Raw secret material may never appear in a DCD record. Refs only.
 *
 * NOTE: bare "hash" is deliberately NOT a secret pattern. Integrity hashes and
 * the evidence digest are required by the truth lattice (§4 E-3, I-63); only
 * password-adjacent hash names are secret-bearing. `password_hash` is caught by
 * the "password" pattern.
 *
 * This is a SUBSTRING list and cannot be complete by construction. It is backed
 * by two further layers, because the first two audits both found names it missed:
 *   - KEY_SEGMENT_PATTERN  catches any bare `key`/`keys` word segment that is not
 *     a ref (`sshKey`, `signing_key`, `encryption_key`, `sessionKey`);
 *   - SECRET_WORD_SEGMENTS catches other named secret shapes (`jwt`, `pin`,
 *     `otp`, `mnemonic`, `seed`, `passcode`).
 */
const SECRET_KEY_PATTERNS = Object.freeze([
    "password", "passwd", "secret", "apikey", "api_key", "privatekey", "private_key",
    "token", "credential", "cookie", "bearer", "ntlm", "nthash", "passphrase",
    "client_secret", "connection_string", "samaccount", "unattend",
    "sshkey", "ssh_key", "signingkey", "signing_key", "encryption_key", "encryptionkey",
    "sessionid", "session_id", "authcode", "auth_code", "authorization_code",
    "mnemonic", "seedphrase", "seed_phrase", "jwt", "passcode", "pincode",
    "totp", "keystore", "keychain", "recovery_code", "refresh_token", "sym_key",
    "wrapped_key", "master_key", "root_key",
    // Bare `credential` above subsumes these camelCase forms, which the old
    // snake_case-only entry missed: `credentialValue` does not contain
    // `credential_value` (audit 4, P1-1).
    "tokenvalue", "secretvalue", "keyvalue", "authvalue", "secretkey"
]);

/** Word segments that name secret material when they stand as their own segment. */
/**
 * Bare word segments that name secret material.
 *
 * `keys` (plural) is deliberately NOT here: as a whole segment it is ambiguous
 * and rejects `keyboard_keys` / `sortKeys`, which are estate vocabulary, not
 * secrets. The singular `key` covers the real cases (`sshKey`, `signing_key`).
 * A field literally named `keys` is caught by its content shape at the point of
 * use, not by a name rule that costs more than it catches (audit 2, P2-N1).
 */
const SECRET_WORD_SEGMENTS = Object.freeze([
    "key", "pin", "otp", "seed", "privkey", "certkey"
]);

/**
 * Names that END in a ref suffix are references, not values — a ref is the
 * required, safe form (`credentialRef`, `keyRef`, `publicKeyRef`).
 */
const REF_SUFFIX = /(?:^|[_.\-])(ref|refs)$|(?:Ref|Refs)$/;

/**
 * Segment-aware word matcher, same shape as the house `riskCatalog.word()` rule.
 *
 * Both branches are case-sensitive and both require a real segment boundary, so
 * `monkey`/`donkey`/`turkey`/`keyboard`/`keyStore`/`bodyCount` are not matched at
 * all. Case-insensitive matching comes only from the short, deliberate substring
 * lists (`password`, `sshkey`, `payload`, …).
 *
 * Requiring a boundary on BOTH sides is what keeps the rule honest: a bare `key`
 * inside a longer word is not a key (audit 2, P2-N1). Names that must still be
 * refused despite not being segment-clean (`keystore`, `keychain`) are in the
 * substring list for exactly that reason.
 */
const segmentPattern = (w) => new RegExp(
    `(?:^|[_.\\-])${w}(?![a-zA-Z])` +
    `|(?<=[a-z0-9])${w[0].toUpperCase()}${w.slice(1)}(?![a-zA-Z])`
);
const KEY_SEGMENT_PATTERNS = Object.freeze(SECRET_WORD_SEGMENTS.map(segmentPattern));

/**
 * An explicitly NON-secret key vocabulary — *identifiers*, not containers.
 * `publicKey` is a public artefact; `sortKey`/`primaryKey`/`cacheKey` are names.
 * Refusing these would push callers toward `...Ref` names, which is strictly
 * worse (audit 2, P2-N1).
 *
 * BUT the allowlist is paired with a VALUE-SHAPE test (audit 3, P1-7): a
 * credential stored under an allowlisted name is still a credential. The
 * allowlist exempts the *name*; it never exempts PEM material, a known provider
 * key id, or a high-entropy bearer-shaped string.
 */
const NON_SECRET_KEY_NAMES = Object.freeze([
    "publickey", "public_key", "sortkey", "sort_key", "primarykey", "primary_key",
    "foreignkey", "foreign_key", "partitionkey", "partition_key", "groupkey", "group_key",
    "cachekey", "cache_key", "lookupkey", "lookup_key", "pipelinekey", "pipeline_key",
    "keyid", "key_id", "keyname", "key_name", "keytype", "key_type", "keysize", "key_size",
    "keylength", "key_length", "keyspace", "keyexample", "keyframe", "keynote", "hotkey", "hotkeys"
]);

/** Any key-ish field name (allowlisted or not), for the value-shape check. */
const KEYISH_NAME = /(?:^|[_.-])keys?(?![a-z])|(?:^|[a-z0-9])Keys?(?![a-zA-Z])/;

/**
 * Value shapes that are a SECRET regardless of the field name carrying them.
 *
 * Two rules govern what belongs here, and the second is why this list is short:
 *
 *   1. Each entry must be a credential artefact with NO legitimate role in a
 *      bounded DCD record — a PEM header, a token with a provider prefix, an
 *      auth scheme prefix, a signed-URL parameter.
 *   2. Shape must separate it from data the corpus REQUIRES or permits. This is
 *      what excludes bare hex, bare base64, and provider *identifiers*:
 *        - a 64-character hex private key and a SHA-256 digest are **the same
 *          shape**, and the truth lattice requires integrity digests on records
 *          (E-3, I-63), so a raw key in a bare-hex field is not distinguishable
 *          at this layer;
 *        - an AWS access key id (`AKIA…`) is an identifier, unusable without the
 *          paired secret, and a *discovered* key id is ordinary threat-intel
 *          evidence whose value must be recordable.
 *      Both are recorded as residual risks rather than guessed at (audit 5,
 *      P1-4, P2-8).
 *
 * Applied to **every string value**, not only to key-ish names (audit 4, P1-1):
 * a name rule can always be spelled around (`credentialValue` matched neither
 * the snake_case entry nor the keyish regex), and the value is the thing that
 * must never enter a record. The same reasoning as the `...Ref` rule: judge the
 * content, because the name is producer-chosen.
 *
 * The long-base64url pattern was dropped: it matched legitimate zero-filled
 * buffers and IVs (audit 4, ADVISORY-2).
 */
const SECRET_VALUE_SHAPES = Object.freeze([
    /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|OPENSSH PRIVATE KEY)[A-Z ]*-----/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,  // GitHub token
    /\bsk-[A-Za-z0-9]{20,}\b/,                        // OpenAI-style secret key
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,              // Slack token
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,  // JWT
    /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/,           // an auth scheme prefix + token
    /[?&]?X-Amz-(?:Signature|Credential|Security-Token)=/ // a signed-URL credential parameter
]);

/** Is this value carrying secret material, whatever its field is named? */
function isSecretValue(value) {
    if (typeof value !== "string" || value.length < 16) return false;
    return SECRET_VALUE_SHAPES.some((re) => re.test(value));
}


/**
 * Is this field name secret-shaped? Single decision point so every validator
 * agrees (`assertCyberRecord`, `scoreFinding`, `assertTeacherArtifact`,
 * `assertDistillSample`, `makeCacheEntry`).
 *
 * Two rules, in this order:
 *   1. a name ending in `Ref`/`Refs` is a REFERENCE — exempt (a ref is the
 *      required, safe form: `credentialRef`, `publicKeyRef`);
 *   2. an explicit non-secret vocabulary is exempt (`publicKey`, `sortKey`, …);
 *   3. otherwise the substring list and the segment matcher decide.
 *
 * The segment matcher is CASE-SENSITIVE on the camelCase branch on purpose: with
 * the `i` flag it degenerates into a substring matcher and rejects `monkey`,
 * `donkey`, `turkey`, `keyboard`. Case-insensitive matching is provided only by
 * the explicit substring list, which is short and deliberate.
 */
function isSecretShaped(key) {
    const name = String(key);
    if (REF_SUFFIX.test(name)) return false;
    const lower = name.toLowerCase();
    if (NON_SECRET_KEY_NAMES.includes(lower)) return false;
    if (containsAny(name, SECRET_KEY_PATTERNS)) return true;
    return KEY_SEGMENT_PATTERNS.some((re) => re.test(name));
}

/** A ref-named field must actually hold a reference, not a value (P2-N3). */
const REF_VALUE_SCHEME = /^(vault|ref|raw|lease|evidence|audit|graph|mission|asset|cred|ioc):\/\//;

/**
 * An opaque id shape. `REC-6`/`ME-4` already require this of every id field, and
 * a reference held as a plain id (`missionRef: "m-1"`, `evidenceRef: "ev-1"`) is
 * the documented edge and timeline form, so it is a valid reference and not a
 * value in disguise (audit 3, P2-4).
 */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Plural `...Refs` names hold a LIST of references, not a single one. */
const REFS_NAME = /(?:^|[_.-])refs$|Refs$/;

/**
 * Is this a reference? A scheme-qualified ref or an opaque id, and never a
 * credential value that merely looks token-shaped. The value-shape test is what
 * keeps `sshKeyRef: "<a key>"` and `credentialRef: {value:"hunter2"}` out.
 */
function isReference(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    if (isSecretValue(value)) return false;
    return REF_VALUE_SCHEME.test(value) || OPAQUE_ID.test(value);
}

/**
 * Raw-payload-shaped keys. A DCD record may carry a pointer, never inline
 * content. Segment-matched, not substring-matched, so `somebody`/`dumpster`/
 * `htmlContent` are not collateral damage; ref-named pointers are exempt.
 */
const RAW_PAYLOAD_KEYS = Object.freeze([
    "payload", "rawpayload", "raw_payload", "body", "rawbody", "raw_body", "rawbytes",
    "raw_bytes", "html", "packet", "pcap", "dump", "blob", "base64", "b64",
    "screenshot", "content_bytes", "memory_dump", "heap"
]);
const RAW_PAYLOAD_SEGMENT_PATTERNS = Object.freeze(RAW_PAYLOAD_KEYS.map(segmentPattern));

/* --------------------------------------------------------------- laws */

/**
 * The DCD invariant set. Machine-checkable, greppable, one owner.
 * Same shape as every certified Wave 5/6 owner.
 */
const laws = Object.freeze({
    DCD_PREP_ONLY: true,
    DCD_IS_NOT_A_SEPARATE_SUPERUSER: true,

    ALERT_NOT_FACT: true,
    ANOMALY_NOT_ATTACK: true,
    THREAT_SCORE_NOT_AUTHORITY: true,
    DETECTION_NOT_PERMISSION_TO_ACT: true,
    TARGET_DISCOVERED_NOT_AUTHORIZED_TARGET: true,
    VULNERABILITY_SUSPECTED_NOT_EXPLOIT_PERMISSION: true,
    EXPLOIT_AVAILABLE_NOT_PERMISSION_TO_EXECUTE: true,
    CREDENTIAL_FOUND_NOT_PERMISSION_TO_USE: true,
    ACCESS_OBTAINED_NOT_PERMISSION_TO_PIVOT: true,
    PENTEST_MODE_NOT_UNLIMITED_AUTHORITY: true,
    TOOL_RESULT_NOT_VERIFIED_EFFECT: true,
    MODEL_OUTPUT_NOT_CYBER_AUTHORITY: true,
    TEACHER_OUTPUT_NOT_TRUTH: true,
    JEV_CYBER_SCORE_NOT_INCIDENT_FACT: true,
    JEV_RECOMMENDATION_NOT_RESPONSE_AUTHORITY: true,

    NO_GLOBAL_ROUND_TRIP_WITHOUT_BOUNDARY_CHANGE: true,
    NO_MODEL_CALL_FOR_DETERMINISTIC_WORK: true,
    NO_FULL_GRAPH_REBUILD_FOR_LOCAL_CHANGE: true,
    NO_RAW_TELEMETRY_IN_COGNITIVE_CONTEXT: true,
    NO_AUTHORITY_RECHECK_WHEN_ENVELOPE_VALID: true,
    NO_HIGH_COST_VERIFICATION_FOR_LOW_RISK_READ_ONLY: true,
    NO_BACKGROUND_WORK_ON_CRITICAL_RESPONSE_PATH: true,
    BOUNDARY_PERMISSION_NOT_BOUNDARY_EVERY_STEP: true,

    THEORETICAL_PATH_NOT_VALIDATED_PATH: true,
    VALIDATED_PATH_NOT_AUTHORIZED_PATH: true,
    DETECTION_PROPOSAL_NOT_DETECTION: true,
    INCIDENT_CONFIRMED_NOT_AUTHORIZED: true,
    MALWARE_ANALYSIS_OUTPUT_IS_EVIDENCE_NOT_TRUTH: true,
    IOC_HIT_NOT_INCIDENT_TRUTH: true,
    HONEYTOKEN_TOUCH_NOT_CONTAINMENT_AUTHORITY: true,
    TEACHER_CONFIDENCE_NOT_CORRECTNESS: true,
    TEACHER_PLAN_NOT_AUTHORITY: true,
    TEACHER_EXPLOIT_CLAIM_NOT_VERIFIED_EXPLOITABILITY: true,
    LEASE_IS_NOT_AUTHORITY: true,
    DCD_OWNS_NO_T1: true,
    DCD_OWNS_NO_T3: true,
    NO_TRUSTED_COMPLETION_WITHOUT_REQUIRED_VERIFICATION: true,
    NO_SECOND_AUDIT_LEDGER: true,
    NO_SECOND_REPLAY_SYSTEM: true,
    NO_DIRECT_EXPLOIT_TO_EXECUTION: true,

    // --- closed during the DCD PREP self-audit (gaps where docs promised what code
    //     did not yet enforce) ---
    NO_WILDCARD_SCOPE: true,
    TEACHER_MUST_SOLICIT_DISCONFIRMATION: true,
    ABSENCE_MUST_BE_RECORDED: true,
    CORPUS_ADMISSION_REQUIRES_FULL_PROVENANCE: true,
    NO_HIDDEN_CONFIDENCE_FIELD: true
});

/* --------------------------------------------------------------- helpers */

/**
 * Canonical envelope keys (DAMAR_TRUTH_LATTICE.md §4 + DCD extensions).
 * These are vocabulary, not grants: `authorityRef` must not be mistaken for an
 * authority-shaped field. Only exact matches of this closed list are exempt.
 */
const ENVELOPE_KEYS = Object.freeze([
    "schemaVersion", "id", "kind", "tier", "epistemicClass", "subject", "source",
    "provenanceChain", "observedAt", "recordedAt", "validUntil", "confidence",
    "evidence", "contradicts", "supersededBy", "incarnationId", "persistenceClass",
    "replicationClass", "authorityRef", "sourceKind", "missionRef", "incidentRefs",
    "evidenceRefs", "verificationState", "freshness", "cyberPlane", "operatorApprovalRef"
]);

/**
 * `authorityRef` on these two shapes is a NEGATIVE assertion — it states "this
 * object is not an authorization". Both are named shapes, so the exemption stays
 * scoped to the object that actually declares it, never global.
 */
const SCORE_PROJECTION_KEYS = Object.freeze([
    "score", "band", "factors", "deterministic", "rankingOnly", "authorityRef", "note"
]);
const TEACHER_ARTIFACT_KEYS = Object.freeze([
    "teacherKind", "teacherVersion", "scenarioId", "outputClass", "authorityRef",
    "OBSERVATIONS", "HYPOTHESES", "SUPPORTING_EVIDENCE", "CONTRADICTING_EVIDENCE",
    "UNCERTAINTIES", "NEXT_TEST", "EXPECTED_RESULT", "STOP_CONDITION", "RULED_OUT",
    "VERIFICATION", "REMEDIATION", "teacherConfidence", "toolTrace",
    "inputHash", "outputHash", "verificationResult", "criticResult",
    "difficulty", "capabilityTags", "accepted", "scopeType"
]);

/**
 * NOTE (independent audit 2, ADVISORY-5): a teacher artifact has exactly ONE
 * shape — the camelCase structured-reasoning format of `dcd-kd-teacher-pipeline.md`
 * §4, validated by `assertTeacherArtifact`. Corpus rows have their own snake_case
 * shape (`DISTILL_SAMPLE_KEYS`), validated by `assertDistillSample`. The two
 * allowlists used to admit each other's spellings while neither validator read
 * them, so a snake_case artifact passed the scan and then failed for a missing
 * camelCase field. One shape per artefact is the fix.
 */

/**
 * Distillation corpus row. `capability_tags` is a taxonomy label here, not a
 * grant — the exemption is scoped to a row that declares a data family.
 */
const DISTILL_SAMPLE_KEYS = Object.freeze([
    "family", "teacher", "teacher_kind", "teacher_version", "scenario_id", "scope_type",
    "input_hash", "output_hash", "tool_trace", "verification_result", "critic_result",
    "difficulty", "capability_tags", "accepted_or_rejected", "rejection_reason",
    "authorityRef", "parentScenarioId"
]);

const containsAny = (key, patterns) => {
    const lower = String(key).toLowerCase();
    return patterns.some((p) => lower.includes(p));
};

/**
 * A PLAIN object: one whose prototype is `Object.prototype` or `null`.
 *
 * `typeof v === "object" && !Array.isArray(v)` also accepted a `Map`, `Set`,
 * `Date`, `RegExp` and every other exotic object. That mattered in two places:
 * `Object.keys`/`Object.entries` see nothing in a `Map`, so the clock reached
 * `consumeBudget` as `new Map([["hosts", 1e9]])`, matched the closed key set
 * vacuously, debited zero and returned `allowed: true` (audit 11, P2-5); and the
 * forbidden-field scan recursed into such a value, found no entries and reported
 * it clean, so `{detail: new Map([["password", "hunter2"]])}` was accepted (the
 * long-standing scan-totality residual, now CLOSED rather than documented —
 * audit 11, ADV-4). Freshly-built objects with no prototype are still plain, so
 * `Object.create(null)` tables and `{...spread}` copies are unaffected.
 */
const isPlainObject = (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
};

/**
 * A value that is an object but not a plain one, and not an array: a `Map`, a
 * `Set`, a `Date`, a function, a class instance. Such a value is invisible to
 * `Object.entries`, so the scan cannot see inside it; refusing it is what makes
 * the scan TOTAL over values rather than merely bounded (audit 11, ADV-4).
 */
const isExoticObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !isPlainObject(v);
const exoticKind = (v) =>
    (typeof v === "function" ? "function" : Object.prototype.toString.call(v).slice(8, -1));

/**
 * Structural rejection of authority-shaped, secret-bearing or raw-payload-shaped
 * fields anywhere in a candidate record. Total; never throws. Reports the
 * deepest violating path it found, and refuses a record nested deeper than it is
 * willing to scan rather than silently not scanning it (audit 2, P2-N5).
 *
 * Exemption is SCOPED, not global:
 *   - an object that is envelope-shaped (carries `tier` + `sourceKind`) exempts
 *     the canonical envelope key names for THAT object only;
 *   - an object that is score-shaped (carries `score` + `rankingOnly`) exempts
 *     the score-projection key names for THAT object only;
 *   - an object that is teacher-artifact-shaped (carries `teacherKind`) exempts
 *     the artifact key names for THAT object only.
 * A nested record therefore never weakens the scan for its siblings, and
 * `extraAllow` is the caller's own closed vocabulary, never a wildcard.
 * @returns {string[]} human-readable violations (empty => clean)
 */
const RECORD_MAX_DEPTH = 8;

function scanForbiddenFields(value, path = "$", depth = 0, errors = [], extraAllow = []) {
    if (depth > RECORD_MAX_DEPTH) {
        errors.push(`${path}: nesting exceeds the ${RECORD_MAX_DEPTH}-level scan depth (bound the record shape)`);
        return errors;
    }
    if (Array.isArray(value)) {
        // A caller's allowlist is not inherited into the elements either — and an
        // element is a VALUE position, so the value test must run HERE. Recursion
        // alone never reaches it: a primitive returns at the `isPlainObject` guard
        // below. Property values are tested in the loop; array elements had no
        // equivalent, so a PEM inside any of the envelope's four string lists, or
        // inside a record's array field, escaped all six scan sites (audit 8,
        // P1-1). The value is the thing that must never enter a record, and an
        // array element is a value.
        value.forEach((v, i) => {
            const p = `${path}[${i}]`;
            if (typeof v === "string" && isSecretValue(v) && !REF_VALUE_SCHEME.test(v)) {
                errors.push(`${p}: field carries a secret value (use a ref)`);
            }
            scanForbiddenFields(v, p, depth + 1, errors, null);
        });
        return errors;
    }
    if (isExoticObject(value)) {
        // A `Map`/`Set`/`Date`/class instance has no enumerable own entries as far
        // as `Object.entries` is concerned, so recursing into it would find nothing
        // and report it clean. Refusing it is what makes the scan total (ADV-4).
        errors.push(`${path}: ${exoticKind(value)} is not an admissible value `
            + "(only plain objects, arrays and primitives may carry a record field)");
        return errors;
    }
    if (!isPlainObject(value)) return errors;

    // `extraAllow` is the CALLER's allowlist for the object it was passed with
    // (RISK_FACTOR_KEYS for a finding, CACHE_ENTRY_KEYS for a cache entry). It is
    // a statement about ONE shape and is never inherited: each nested object is
    // exempted only by the shape detectors below, which read the object itself.
    // The comment here said this before the code did — `extraAllow` was still
    // passed into both recursion sites, so a nested `{privilegeGain: …}` or
    // `{cacheKey: …}` was exempt under every emitter (audit 5, P1-2).
    let allow = extraAllow ?? [];
    if (typeof value.tier === "string" && typeof value.sourceKind === "string") {
        allow = [...allow, ...ENVELOPE_KEYS];
    }
    if (value.rankingOnly === true && "score" in value) {
        allow = [...allow, ...SCORE_PROJECTION_KEYS];
    }
    if (typeof value.teacherKind === "string") {
        allow = [...allow, ...TEACHER_ARTIFACT_KEYS];
    }
    if (typeof value.family === "string" && "accepted_or_rejected" in value) {
        allow = [...allow, ...DISTILL_SAMPLE_KEYS];
    }

    for (const [k, v] of Object.entries(value)) {
        const p = `${path}.${k}`;
        if (!allow.includes(k)) {
            if (containsAny(k, FORBIDDEN_KEY_PATTERNS)) {
                errors.push(`${p}: authority-shaped key`);
            } else if (isSecretShaped(k)) {
                errors.push(`${p}: secret-bearing key (use a ref)`);
            } else if (RAW_PAYLOAD_SEGMENT_PATTERNS.some((re) => re.test(k))) {
                errors.push(`${p}: raw-payload-shaped key (use a rawRef pointer)`);
            }
        }

        // Ref-shaped fields are checked REGARDLESS of the allowlist. An exempt
        // key name is exempt from the *authority* rule, never from the
        // *reference* rule: `evidenceRefs` is a canonical envelope key, and an
        // allowlist that skipped it would let a PEM ride an exempt field name
        // (audit 3, P1-7/P2-4). `null` is the documented "no reference" value.
        if (v !== null && v !== undefined) {
            if (REFS_NAME.test(k)) {
                if (!(Array.isArray(v) && v.every(isReference))) {
                    errors.push(`${p}: refs field must be an array of references`);
                }
            } else if (REF_SUFFIX.test(k) || k === "ref") {
                if (!isReference(v)) {
                    errors.push(`${p}: ref-named field must hold a reference (scheme-qualified or an opaque id), not a value`);
                }
            }
        }

        // The value is checked on EVERY string, not only under a key-ish name.
        // A name rule can always be spelled around (`credentialValue` matched
        // neither the snake_case entry nor the keyish regex); the value is the
        // thing that must never enter a record (audit 4, P1-1).
        if (isSecretValue(v) && !REF_VALUE_SCHEME.test(v)) {
            errors.push(`${p}: field carries a secret value (use a ref)`);
        }
        // An exempt KEY's subtree is part of the shape the emitter described, so
        // the exempt vocabulary follows that key and nothing else — except for the
        // containers in `NESTED_VOCABULARY_CONTAINERS`, whose children are a
        // different vocabulary. A sibling the emitter never named inherits
        // nothing: a record's `detail:{privilegeGain:…}` is NOT covered by
        // `scoreFinding`'s list (audit 5, P1-2, ADVISORY-5).
        const inherited = !allow.includes(k) ? null
            : (NESTED_VOCABULARY_CONTAINERS[k] ?? allow);
        scanForbiddenFields(v, p, depth + 1, errors, inherited);
    }
    return errors;
}

/** A bounded record may not exceed this serialized size; carry a rawRef instead. */
const RECORD_MAX_BYTES = 65536;

/**
 * Validate a DCD-owned cyber record.
 * @returns {{ok:boolean, code:null|string, errors:string[]}}
 */
function assertCyberRecord(record) {
    const errors = [];
    if (!isPlainObject(record)) return { ok: false, code: "DCD-01", errors: ["not an object"] };

    // NO_RAW_TELEMETRY_IN_COGNITIVE_CONTEXT: a record is a bounded observation,
    // not a payload carrier. An oversized record is refused structurally rather
    // than being a convention the fixture happens to follow. The bound is in
    // BYTES, not UTF-16 units, so a multi-byte payload cannot overshoot it by 3x
    // (audit 2, P2-N4).
    let size = 0;
    try {
        size = Buffer.byteLength(JSON.stringify(record) ?? "", "utf8");
    } catch {
        return { ok: false, code: "DCD-01", errors: ["record is not serializable"] };
    }
    if (size > RECORD_MAX_BYTES) {
        errors.push(`record is ${size} bytes, over the ${RECORD_MAX_BYTES}-byte bound (carry a rawRef, not content)`);
    }

    // REC-1: DCD owns NO truth tier. `T11 PLAN` is the Mission owner's tier, so
    // DCD stages a plan and never writes the tier — a claim the module header
    // made while `ALLOWED_TIERS` admitted T11 (audit 4, P2-8).
    if (!ALLOWED_TIERS.includes(record.tier)) {
        errors.push(`tier '${record.tier}' is not DCD-writable (DCD writes ${ALLOWED_TIERS.join("/")} only; T11 PLAN is the Mission owner's)`);
    }
    if (!EPISTEMIC_CLASSES.includes(record.epistemicClass)) {
        errors.push(`unknown epistemicClass '${record.epistemicClass}'`);
    }
    if (!EVIDENCE_SOURCE_KINDS.includes(record.sourceKind)) {
        errors.push(`unknown sourceKind '${record.sourceKind}'`);
    }
    if (record.tier === "T10" && record.epistemicClass !== "SIMULATED") {
        errors.push("a T10 record must be SIMULATED");
    }
    // NO_HIDDEN_CONFIDENCE_FIELD / "only Verification mints a verified claim":
    // `VERIFIED` is a claim ABOUT a verifier's result, so it must cite one. The
    // class was previously free-form, so `{tier:"T4", epistemicClass:"VERIFIED"}`
    // passed and a producer could mint verification strength by spelling a class
    // (audit 4, P2-6 / DC-94).
    //
    // Three successive fixes here, each still one step short of the subject:
    //   - any spelling passed (audit 4);
    //   - then any ENUM member passed, so a record could present as VERIFIED while
    //     its own declared verifier outcome was `REFUTED` (audit 5);
    //   - so the declared outcome must now SUPPORT the class. A claim is verified
    //     by a verifier result that asserts the claim, not one that denies it.
    if (record.verificationState !== undefined &&
        !VERIFIER_RESULTS.includes(record.verificationState)) {
        errors.push(`unknown verificationState '${record.verificationState}'`);
    }
    if (record.epistemicClass === "VERIFIED") {
        // A REF is required, not a self-description. Four separate places in the
        // docs said "requires a verifierRef" while the code accepted a bare
        // `verificationState: "VERIFIED"` instead — which is just spelling the
        // word, the thing DC-94 exists to prevent. A `verificationState` is what
        // the emitter says happened; a `verifierRef` is the citation. Neither is
        // authenticated at this layer, and that residual is recorded, but the
        // citation is the one the invariant is about (audit 7, P2-2).
        if (typeof record.verifierRef !== "string" || !record.verifierRef.trim()) {
            errors.push(
                "epistemicClass VERIFIED requires a verifierRef (only Verification mints a verified claim)"
            );
        }
        // A declared outcome that does not assert the claim cannot accompany one.
        if (record.verificationState !== undefined && record.verificationState !== "VERIFIED") {
            errors.push(
                `epistemicClass VERIFIED cannot rest on verificationState '${record.verificationState}' ` +
                "(a verifier result that does not assert the claim cannot mint it)"
            );
        }
    }
    // Declarative source-to-tier binding. A range or teacher result can otherwise
    // present as an estate observation, which is the lab-vs-estate separation
    // failing at the record layer (audit 2, P2-N8 / P2-N12).
    const binding = SOURCE_TIER_BINDINGS[record.sourceKind];
    if (binding) {
        if (!binding.tiers.includes(record.tier)) {
            errors.push(`sourceKind '${record.sourceKind}' may only be written at ${binding.tiers.join("/")}`);
        }
        if (!binding.epistemicClasses.includes(record.epistemicClass)) {
            errors.push(`sourceKind '${record.sourceKind}' may only be ${binding.epistemicClasses.join("/")}`);
        }
    }
    // E-1: authorityRef is a string id or null. Embedding an evaluation object
    // (token, grant, brand, serialized decision) is FORBIDDEN.
    if (record.authorityRef !== null && record.authorityRef !== undefined) {
        if (typeof record.authorityRef !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.authorityRef)) {
            errors.push("authorityRef must be an opaque id string or null, never an object");
        }
    }
    if (record.tier === "T4" && (record.validUntil === undefined || record.validUntil === null) &&
        record.epistemicClass !== "DECLARED") {
        errors.push("an OBSERVED record without validUntil is a lane-freeze blocker (truth lattice §7)");
    }
    if (record.sourceKind === "teacher" && record.epistemicClass !== "ASSERTED") {
        errors.push("teacher-derived records are ASSERTED (T5) until independently verified");
    }
    // No caller allowlist: `RISK_FACTOR_KEYS` are severity inputs to
    // `scoreFinding`, not a record vocabulary, and passing them here exempted a
    // top-level `privilegeGain`/`blastRadius` name in every cyber record
    // (audit 5, ADVISORY-5). A record has its own shape detectors inside the scan.
    const forbidden = scanForbiddenFields(record, "$", 0, [], []);
    if (forbidden.length) {
        return { ok: false, code: "DCD-AUTHORITY-SHAPED", errors: [...errors, ...forbidden] };
    }
    return { ok: errors.length === 0, code: errors.length ? "DCD-01" : null, errors };
}

/** Assemble the mission envelope. Frozen, validated, fail-closed on depth. */
function makeMissionEnvelope(fields = {}) {
    // Unknown top-level keys are REFUSED, not silently dropped. The factory builds
    // the envelope from named fields, so an unknown key never reaches it — which
    // made `{destructive_action_allowed: true}` (a typo) build an envelope with
    // `destructive_actions_allowed: false` and no error at all. A silently
    // discarded field is how a caller believes it granted something it did not
    // (audit 7, P1-1: the same "typo disables the check" class the closed key sets
    // close everywhere else).
    if (isPlainObject(fields)) {
        for (const k of Object.keys(fields)) {
            if (!MISSION_ENVELOPE_KEYS.includes(k)) {
                throw new Error(`dcd: unknown envelope field '${k}' (the envelope's field set is closed)`);
            }
        }
    }
    const required = ["mission_id", "principal", "objective", "authority_reference"];
    for (const k of required) {
        if (!fields[k]) throw new Error(`dcd: mission envelope missing '${k}'`);
    }

    const requestedDepth = fields.offsec_depth ?? DEFAULT_OFFSEC_DEPTH;
    if (!OFFSEC_DEPTHS.includes(requestedDepth)) {
        throw new Error(`dcd: unknown offsec_depth '${requestedDepth}'`);
    }
    const explicitGrants = Array.isArray(fields.depth_explicit_grants) ? fields.depth_explicit_grants : [];
    let depth = requestedDepth;
    if (DEPTH_REQUIRES_EXPLICIT_OPT_IN.includes(requestedDepth) && !explicitGrants.includes(requestedDepth)) {
        depth = DEFAULT_OFFSEC_DEPTH;   // fail-closed: silently NOT granted, never silently granted
    }

    // A wildcard scope token makes every asset "in scope", which is the same as
    // having no scope at all (threat model AB-2). Refused, not flagged.
    //
    // COUPLING NOTE: this checks the literal `*` only, which is sufficient while
    // scope matching is exact-string `Array.includes` and no other glob metachar
    // has meaning. If a future matcher adopts glob/regex semantics, this refusal
    // must be revisited in the same change or `?`/`[...]` tokens will sail past it.
    for (const [field, tokens] of [
        ["authorized_scope", fields.authorized_scope ?? []],
        ["asset_scope", fields.asset_scope ?? []],
        // ADV-2: `allowed_capabilities: ["*"]` is inert today because every
        // comparison is exact `Array.includes`, but the field most likely to be
        // misread as "all capabilities" is the one the wildcard rule must reach.
        ["allowed_capabilities", fields.allowed_capabilities ?? []],
        ["allowed_methods", fields.allowed_methods ?? []],
        // `prohibited_methods` and `depth_explicit_grants` are guarded for the
        // SAME reason, and the omission was fail-OPEN on intent: the prohibited
        // check is exact `Array.includes`, so a caller writing
        // `prohibited_methods: ["*"]` intending "block every method" got an
        // envelope that prohibits nothing and then allows the attempt. Guarding
        // four of the six lists is the "present at some sites, absent at others"
        // shape, and a guard must not depend on which list it is (audit 9,
        // ADVISORY-1 promoted — a silent weakening, like DC-161).
        ["prohibited_methods", fields.prohibited_methods ?? []],
        ["depth_explicit_grants", fields.depth_explicit_grants ?? []]
    ]) {
        if (!Array.isArray(tokens)) throw new Error(`dcd: ${field} must be an array of scope tokens`);
        for (const t of tokens) {
            if (typeof t !== "string" || !t.trim()) {
                throw new Error(`dcd: ${field} entries must be non-empty strings`);
            }
            if (t.includes("*")) {
                throw new Error(`dcd: wildcard scope token '${t}' in ${field} is refused (no wildcard scope)`);
            }
        }
    }

    // ME-4: the authority reference is an opaque id, exactly as at the record
    // layer (REC-6). Embedding an evaluation object in the envelope is the one
    // place a "serialized security object" would be most damaging, because the
    // whole chain leans on this field (audit 2, P2-N9).
    const authorityRef = fields.authority_reference;
    if (typeof authorityRef !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(authorityRef)) {
        throw new Error("dcd: authority_reference must be an opaque id string (ME-4), never an object");
    }

    // ME-1 / ME-5 / OC-1 / threat-model "a widened envelope IS the bypass":
    // the envelope is deep-frozen, so a caller cannot retain a live handle to a
    // nested budget and widen the mission in place (audit 2, P1-N6). Nested
    // objects are rebuilt, not aliased, exactly as blast_radius_budget already was.
    const rateBudget = Object.freeze({ requestsPerMinute: 0, ...(fields.rate_budget ?? {}) });
    const timeWindow = Object.freeze({ start: null, end: null, ...(fields.time_window ?? {}) });
    const credentialPolicy = Object.freeze({
        leaseOnly: true, maxLeaseMs: 600000, ...(fields.credential_policy ?? {})
    });
    const blastBudgetIn = fields.blast_radius_budget ?? {};
    const blastRadiusBudget = Object.freeze({
        max_hosts: 0, max_accounts: 0, max_processes: 0,
        max_network_scope: "NONE", max_duration_ms: 0, max_data_scope: "NONE",
        ...blastBudgetIn
    });

    const envelope = {
        mission_id: fields.mission_id,
        principal: fields.principal,
        objective: fields.objective,
        authorized_scope: Object.freeze([...(fields.authorized_scope ?? [])]),
        asset_scope: Object.freeze([...(fields.asset_scope ?? [])]),
        allowed_capabilities: Object.freeze([...(fields.allowed_capabilities ?? [])]),
        allowed_methods: Object.freeze([...(fields.allowed_methods ?? [])]),
        prohibited_methods: Object.freeze([...(fields.prohibited_methods ?? [])]),
        max_risk_level: fields.max_risk_level ?? "LOW",
        rate_budget: rateBudget,
        time_window: timeWindow,
        max_concurrency: fields.max_concurrency ?? 1,
        data_access_limit: fields.data_access_limit ?? "NONE",
        credential_policy: credentialPolicy,
        allowed_pivot_depth: fields.allowed_pivot_depth ?? 0,
        offsec_depth: depth,
        depth_explicit_grants: Object.freeze([...explicitGrants]),
        persistence_allowed: fields.persistence_allowed === true,
        destructive_actions_allowed: fields.destructive_actions_allowed === true,
        exfiltration_policy: fields.exfiltration_policy ?? "NONE",
        blast_radius_budget: blastRadiusBudget,
        cleanup_required: fields.cleanup_required !== false,
        verification_policy: fields.verification_policy ?? "MEDIUM",
        authority_reference: authorityRef,
        operation_mode: fields.operation_mode ?? "DCD_DEFENSE"
    };

    if (!RISK_LEVELS.includes(envelope.max_risk_level)) {
        throw new Error(`dcd: unknown max_risk_level '${envelope.max_risk_level}'`);
    }
    if (!OPERATION_MODES.includes(envelope.operation_mode)) {
        throw new Error(`dcd: unknown operation_mode '${envelope.operation_mode}'`);
    }
    if (!VERIFICATION_PROFILES.includes(envelope.verification_policy)) {
        throw new Error(`dcd: unknown verification_policy '${envelope.verification_policy}'`);
    }
    if (!DATA_SCOPES.includes(envelope.data_access_limit)) {
        throw new Error(`dcd: unknown data_access_limit '${envelope.data_access_limit}'`);
    }
    // Each blast-radius limit is validated at construction or the check in
    // localEnvelopeDecision can never fire on it (audit 2, P1-N1).
    if (!NETWORK_SCOPES.includes(envelope.blast_radius_budget.max_network_scope)) {
        throw new Error(`dcd: unknown max_network_scope '${envelope.blast_radius_budget.max_network_scope}'`);
    }
    if (!DATA_SCOPES.includes(envelope.blast_radius_budget.max_data_scope)) {
        throw new Error(`dcd: unknown max_data_scope '${envelope.blast_radius_budget.max_data_scope}'`);
    }
    for (const k of ["max_hosts", "max_accounts", "max_processes", "max_duration_ms"]) {
        const v = envelope.blast_radius_budget[k];
        if (!Number.isFinite(v) || v < 0) {
            throw new Error(`dcd: blast_radius_budget.${k} must be a finite non-negative number`);
        }
    }
    if (!EXFILTRATION_POLICIES.includes(envelope.exfiltration_policy)) {
        throw new Error(`dcd: unknown exfiltration_policy '${envelope.exfiltration_policy}'`);
    }
    // ME-5 / P2-5 / P1-5: every scalar budget is validated at construction, not
    // only the blast-radius one. An untyped window makes MISSION_EXPIRY
    // unreachable (`number > "2026-12-31"` is always false), and a string
    // concurrency or a negative rate silently disables or never fires its check.
    for (const [k, v] of [["max_concurrency", envelope.max_concurrency],
        ["allowed_pivot_depth", envelope.allowed_pivot_depth]]) {
        if (!Number.isInteger(v) || v < 0) {
            throw new Error(`dcd: ${k} must be a non-negative integer`);
        }
    }
    if (!Number.isFinite(rateBudget.requestsPerMinute) || rateBudget.requestsPerMinute < 0) {
        throw new Error("dcd: rate_budget.requestsPerMinute must be a finite non-negative number");
    }
    if (typeof credentialPolicy.leaseOnly !== "boolean") {
        throw new Error("dcd: credential_policy.leaseOnly must be a boolean");
    }
    if (!Number.isFinite(credentialPolicy.maxLeaseMs) || credentialPolicy.maxLeaseMs <= 0) {
        throw new Error("dcd: credential_policy.maxLeaseMs must be a finite positive number");
    }
    for (const [k, v] of [["start", timeWindow.start], ["end", timeWindow.end]]) {
        if (v !== null && v !== undefined && !Number.isFinite(v)) {
            throw new Error(
                `dcd: time_window.${k} must be epoch-ms or null — a non-numeric window makes MISSION_EXPIRY unreachable`
            );
        }
    }
    if (Number.isFinite(timeWindow.start) && Number.isFinite(timeWindow.end) &&
        timeWindow.end <= timeWindow.start) {
        throw new Error("dcd: time_window.end must be after time_window.start");
    }
    // VR-3 / DC-62: the profile is derived from the action tier the envelope
    // permits. An envelope that allows a CRITICAL action cannot declare LOW
    // verification, and a destructive envelope is CRITICAL by definition.
    const requiredProfile = requiredPolicyFor(envelope);
    if (verificationProfileRank(envelope.verification_policy) < verificationProfileRank(requiredProfile)) {
        throw new Error(
            `dcd: verification_policy '${envelope.verification_policy}' is below the '${requiredProfile}' ` +
            "required by the action tier this envelope permits (VR-3/DC-62)"
        );
    }
    // A destructive-capable envelope with no blast-radius ceiling is invalid, not merely unwise.
    if (envelope.destructive_actions_allowed && envelope.blast_radius_budget.max_hosts === 0) {
        throw new Error("dcd: destructive envelope requires a non-zero blast_radius_budget.max_hosts");
    }
    // BR-3: a destructive or exfiltrating envelope that declares no duration
    // ceiling has no auto-revert deadline. `max_duration_ms: 0` means "no lasting
    // effect", so treating it as unbounded inverts its meaning (audit 2, P1-N1).
    if ((envelope.destructive_actions_allowed || envelope.exfiltration_policy !== "NONE") &&
        envelope.blast_radius_budget.max_duration_ms === 0) {
        throw new Error("dcd: destructive/exfiltrating envelope requires a non-zero blast_radius_budget.max_duration_ms");
    }
    // One rule list, two paths. The explicit throws above keep their precise
    // messages, and this final check guarantees construction and the decision
    // path agree: a rule added to `envelopeShapeErrors` can never be missing
    // here, and vice versa (audit 4, P1-4).
    const sharedErrors = envelopeShapeErrors(envelope);
    if (sharedErrors.length) throw new Error(`dcd: ${sharedErrors[0]}`);
    return Object.freeze(envelope);
}

/** Blast-radius keys an attempt may declare, matching the envelope's budget. */
const ATTEMPT_BLAST_KEYS = Object.freeze([
    "hosts", "accounts", "processes", "durationMs", "networkScope", "dataScope"
]);

/** Usage keys an attempt may declare. Closed, so a typo cannot skip the rate check. */
const USAGE_KEYS = Object.freeze(["concurrent", "recentRequestsPerMinute"]);

/**
 * The CLOSED key set of the mission's consumed-budget ledger. An absent dimension
 * is a zero; a misspelled one is refused, so a ledger cannot silently forget a
 * dimension it was meant to track.
 */
const LEDGER_KEYS = Object.freeze(["hosts", "accounts", "processes", "elapsedMs"]);

/**
 * Structural validation of a proposed attempt. Total; returns a violation list.
 * Fail-closed: an attempt that cannot be understood is refused, never run as if
 * it had declared nothing. A silently-ignored `risk_level` (wrong case, wrong
 * type, missing) is an attempt that never escalates (audit 2, P2-N10).
 * @returns {string[]}
 */
function validateAttempt(attempt) {
    if (!isPlainObject(attempt)) return ["attempt is not an object"];

    const errors = [];
    for (const k of Object.keys(attempt)) {
        if (!ATTEMPT_KEYS.includes(k)) errors.push(`unknown attempt key '${k}'`);
    }
    for (const k of ["targets", "scopeTokens"]) {
        const v = attempt[k];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !t.trim())) {
            errors.push(`'${k}' must be an array of non-empty strings`);
        }
    }
    for (const k of ["method", "capability", "privilegeLevel", "credentialClass", "dataAccessClass"]) {
        if (attempt[k] !== undefined && (typeof attempt[k] !== "string" || !attempt[k].trim())) {
            errors.push(`'${k}' must be a non-empty string`);
        }
    }
    if (attempt.riskLevel !== undefined && !RISK_LEVELS.includes(attempt.riskLevel)) {
        errors.push(`unknown riskLevel '${attempt.riskLevel}'`);
    }
    if (attempt.exploitDepth !== undefined && !OFFSEC_DEPTHS.includes(attempt.exploitDepth)) {
        errors.push(`unknown exploitDepth '${attempt.exploitDepth}'`);
    }
    if (attempt.dataAccessClass !== undefined && !DATA_SCOPES.includes(attempt.dataAccessClass)) {
        errors.push(`unknown dataAccessClass '${attempt.dataAccessClass}'`);
    }
    for (const k of ["pivotDepth", "at", "retryAfterMs"]) {
        const v = attempt[k];
        if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
            errors.push(`'${k}' must be a finite non-negative number`);
        }
    }
    for (const k of ["persistence", "destructive", "exfiltration"]) {
        if (attempt[k] !== undefined && typeof attempt[k] !== "boolean") {
            errors.push(`'${k}' must be a boolean`);
        }
    }

    const blast = attempt.blastRadius;
    if (blast !== undefined) {
        if (!isPlainObject(blast)) {
            errors.push("'blastRadius' must be an object");
        } else {
            for (const k of Object.keys(blast)) {
                if (!ATTEMPT_BLAST_KEYS.includes(k)) errors.push(`unknown blastRadius key '${k}'`);
            }
            for (const k of ["hosts", "accounts", "processes", "durationMs"]) {
                const v = blast[k];
                if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
                    errors.push(`blastRadius.${k} must be a finite non-negative number`);
                }
            }
            for (const [k, list] of [["networkScope", NETWORK_SCOPES], ["dataScope", DATA_SCOPES]]) {
                if (blast[k] !== undefined && !list.includes(blast[k])) {
                    errors.push(`unknown blastRadius.${k} '${blast[k]}'`);
                }
            }
        }
    }

    const usage = attempt.usage;
    if (usage !== undefined) {
        if (!isPlainObject(usage)) {
            errors.push("'usage' must be an object");
        } else {
            // Closed key set at depth 1 too: `recentRequestsPerMin` (typo) must
            // not silently skip the rate check (audit 3, P2-1).
            for (const k of Object.keys(usage)) {
                if (!USAGE_KEYS.includes(k)) errors.push(`unknown usage key '${k}'`);
            }
            for (const k of ["concurrent", "recentRequestsPerMinute"]) {
                const v = usage[k];
                if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
                    errors.push(`usage.${k} must be a finite non-negative number`);
                }
            }
        }
    }

    // An attempt that identifies nothing is not a cheap attempt, it is an
    // unspecified one. A `FAST_PATH` on it would be vacuous and, worse, a
    // caller that forgot a field would be told "go ahead" (audit 2 P2-N10).
    // An EMPTY targets/scopeTokens array identifies nothing either (audit 3, P2-2).
    const identifies =
        (attempt.capability !== undefined) ||
        (attempt.method !== undefined) ||
        (Array.isArray(attempt.targets) && attempt.targets.length > 0) ||
        (Array.isArray(attempt.scopeTokens) && attempt.scopeTokens.length > 0);
    if (!identifies) {
        errors.push("attempt must identify at least a capability, a method, a target or a scope token");
    }
    return errors;
}

/** Dimension keys that express a magnitude. An effectful attempt must declare one. */
const MAGNITUDE_BLAST_KEYS = Object.freeze(["hosts", "accounts", "processes", "durationMs"]);

/**
 * The envelope's SHAPE and its SEMANTIC rules, in one place.
 *
 * An envelope produced by `makeMissionEnvelope` always passes; a hand-built
 * partial one does not. There is deliberately ONE list of rules, used by
 * construction AND by the decision path — a guard applied at construction but
 * not where a hand-built envelope reaches the same functions is the recurring
 * defect of audits 2-4 (audit 4, P1-4):
 *
 *   - the decision function promised totality, but a hand-built `{mission_id}`
 *     threw `Cannot read properties of undefined` out of the hot path;
 *   - `envelopeShapeErrors` then covered shape only, so a hand-built envelope
 *     with `destructive_actions_allowed: true` and `verification_policy: "LOW"`
 *     fast-pathed a destructive attempt and completed on one postcondition,
 *     bypassing DC-62/DC-104 entirely.
 *
 * A throw is not a decision, and a rule enforced on only one of two paths into
 * the same function is not a rule.
 * @returns {string[]}
 */
function envelopeShapeErrors(e) {
    const errors = [];
    // A non-object envelope is malformed, not a crash. `null` reached the
    // `isPlainObject(e)` guard, skipped the whole rule block and then fell through
    // to the field rules, which read properties off `null` and threw (audit 11,
    // P2-4). The validator is the one place that must be total, because every
    // consumer relies on it running before it reads anything.
    if (!isPlainObject(e)) {
        return [`envelope must be a plain object, got ${e === null ? "null" : exoticKind(e) || typeof e}`];
    }
    // The CLOSED key set. The envelope was the one shape with no key closure and no
    // forbidden-field scan, because nearly every legitimate field name in it is
    // authority-shaped necessarily. A closed set says which names the shape may
    // carry; everything else — `password` under `credential_policy`, `apiKey`
    // under `rate_budget` — is then unknown rather than excused (audit 7, P1-1).
    if (isPlainObject(e)) {
        for (const k of Object.keys(e)) {
            if (!MISSION_ENVELOPE_KEYS.includes(k)) {
                errors.push(`unknown envelope key '${k}' (the envelope's field set is closed)`);
            }
        }
        for (const [key, allowedKeys] of Object.entries(ENVELOPE_NESTED_KEY_SETS)) {
            const nested = e[key];
            if (nested === undefined) continue;
            if (!isPlainObject(nested)) {
                errors.push(`'${key}' must be an object`);
                continue;
            }
            for (const k of Object.keys(nested)) {
                if (!allowedKeys.includes(k)) {
                    errors.push(`unknown key '${k}' in '${key}' (its field set is closed)`);
                }
            }
        }
        // The forbidden/secret scan, with this shape's own vocabulary as the
        // allowlist. Every other record-like shape calls it; the envelope did not.
        const forbidden = scanForbiddenFields(e, "$", 0, [], MISSION_ENVELOPE_KEYS);
        errors.push(...forbidden);
    }
    // ME-19: one rule list for every path. These four rules were construction-only
    // and a hand-built envelope that reaches `localEnvelopeDecision` returned `[]`
    // while permitting `["*"]`, a superuser mode, or naming no authority at all
    // (audit 5, P1-3).
    for (const k of ["mission_id", "principal", "objective", "authority_reference"]) {
        if (typeof e[k] !== "string" || !e[k].trim()) {
            errors.push(`envelope must identify itself: '${k}' is required`);
        }
    }
    if (typeof e.authority_reference === "string" &&
        !/^[A-Za-z0-9_-]{1,128}$/.test(e.authority_reference)) {
        errors.push("'authority_reference' must be an opaque id string (ME-4), never an object");
    }
    if (!OPERATION_MODES.includes(e.operation_mode)) {
        errors.push(`unknown operation_mode '${e.operation_mode}'`);
    }
    // A wildcard makes every asset in scope, which is the same as having no scope
    // at all; entries must be non-empty strings (threat model AB-2, ME-15). All six
    // token lists are covered, not four: `prohibited_methods` and
    // `depth_explicit_grants` were omitted, and for `prohibited_methods` the
    // omission was fail-open on intent (audit 9, ADVISORY-1 promoted).
    for (const k of ["authorized_scope", "asset_scope", "allowed_capabilities", "allowed_methods",
        "prohibited_methods", "depth_explicit_grants"]) {
        const tokens = e[k];
        // These six lists are REQUIRED ARRAYS, not optional. They were optional
        // here (`if (tokens === undefined) continue`), so an envelope built
        // without `authorized_scope` passed this validator with `[]` errors and
        // then threw a raw TypeError at the decision's direct read
        // (`envelope.authorized_scope.includes(...)`) — a throw is not a decision,
        // and DC-119 states this function runs before any field is read
        // (audit 10, P1-A). The factory always emits all six, so no legitimate
        // envelope is affected.
        if (tokens === undefined) {
            errors.push(`'${k}' is required and must be an array of scope tokens`);
            continue;
        }
        if (!Array.isArray(tokens)) {
            errors.push(`'${k}' must be an array of scope tokens`);
            continue;
        }
        for (const t of tokens) {
            if (typeof t !== "string" || !t.trim()) errors.push(`'${k}' entries must be non-empty strings`);
            else if (t.includes("*")) errors.push(`wildcard scope token '${t}' in '${k}' is refused (no wildcard scope)`);
        }
    }
    if (!RISK_LEVELS.includes(e.max_risk_level)) errors.push(`unknown max_risk_level '${e.max_risk_level}'`);
    if (!DATA_SCOPES.includes(e.data_access_limit)) errors.push(`unknown data_access_limit '${e.data_access_limit}'`);
    if (!EXFILTRATION_POLICIES.includes(e.exfiltration_policy)) errors.push(`unknown exfiltration_policy '${e.exfiltration_policy}'`);
    if (!OFFSEC_DEPTHS.includes(e.offsec_depth)) errors.push(`unknown offsec_depth '${e.offsec_depth}'`);
    if (!VERIFICATION_PROFILES.includes(e.verification_policy)) {
        errors.push(`unknown verification_policy '${e.verification_policy}'`);
    }
    if (typeof e.cleanup_required !== "boolean") errors.push("'cleanup_required' must be a boolean");
    for (const k of ["max_concurrency", "allowed_pivot_depth"]) {
        if (!Number.isInteger(e[k]) || e[k] < 0) errors.push(`'${k}' must be a non-negative integer`);
    }
    for (const [k, v] of [["persistence_allowed", e.persistence_allowed],
        ["destructive_actions_allowed", e.destructive_actions_allowed]]) {
        if (typeof v !== "boolean") errors.push(`'${k}' must be a boolean`);
    }
    const cp = e.credential_policy;
    if (!isPlainObject(cp)) errors.push("'credential_policy' must be an object");
    else {
        if (typeof cp.leaseOnly !== "boolean") errors.push("'credential_policy.leaseOnly' must be a boolean");
        if (!Number.isFinite(cp.maxLeaseMs) || cp.maxLeaseMs <= 0) {
            errors.push("'credential_policy.maxLeaseMs' must be a finite positive number");
        }
    }
    const tw = e.time_window;
    if (!isPlainObject(tw)) errors.push("'time_window' must be an object");
    else {
        for (const k of ["start", "end"]) {
            if (tw[k] !== null && tw[k] !== undefined && !Number.isFinite(tw[k])) {
                errors.push(`'time_window.${k}' must be epoch-ms or null`);
            }
        }
        if (Number.isFinite(tw.start) && Number.isFinite(tw.end) && tw.end <= tw.start) {
            errors.push("'time_window.end' must be after 'time_window.start'");
        }
    }
    const rb = e.rate_budget;
    if (!isPlainObject(rb) || !Number.isFinite(rb.requestsPerMinute) || rb.requestsPerMinute < 0) {
        errors.push("'rate_budget.requestsPerMinute' must be a finite non-negative number");
    }
    const br = e.blast_radius_budget;
    if (!isPlainObject(br)) errors.push("'blast_radius_budget' must be an object");
    else {
        for (const k of ["max_hosts", "max_accounts", "max_processes", "max_duration_ms"]) {
            if (!Number.isFinite(br[k]) || br[k] < 0) errors.push(`'blast_radius_budget.${k}' must be a finite non-negative number`);
        }
        if (!NETWORK_SCOPES.includes(br.max_network_scope)) errors.push(`unknown max_network_scope '${br.max_network_scope}'`);
        if (!DATA_SCOPES.includes(br.max_data_scope)) errors.push(`unknown max_data_scope '${br.max_data_scope}'`);
    }

    // --- semantic rules (the half that used to exist only at construction) ---
    // Ordered after the shape checks so a malformed envelope reports the
    // malformation rather than a downstream consequence.

    // DC-25 / PENTEST_MODE_NOT_UNLIMITED_AUTHORITY: L4/L5 are OFF unless the
    // mission grants them explicitly, and `makeMissionEnvelope` said so while the
    // shared list did not — so a hand-built `offsec_depth: "LEVEL_5"` with no
    // grant fast-pathed an L5 attempt, on the same input the factory silently
    // downgrades to LEVEL_2. The same guard-on-one-of-two-paths class as the
    // semantic rules themselves (audit 6, P1-1).
    if (DEPTH_REQUIRES_EXPLICIT_OPT_IN.includes(e.offsec_depth) &&
        !(e.depth_explicit_grants ?? []).includes(e.offsec_depth)) {
        errors.push(
            `offsec_depth '${e.offsec_depth}' requires an explicit depth_explicit_grants opt-in ` +
            "(a high depth is never silently granted)"
        );
    }
    if (isPlainObject(br)) {
        if (e.destructive_actions_allowed === true && br.max_hosts === 0) {
            errors.push("destructive envelope requires a non-zero blast_radius_budget.max_hosts");
        }
        if ((e.destructive_actions_allowed === true || e.exfiltration_policy !== "NONE") &&
            br.max_duration_ms === 0) {
            errors.push("destructive/exfiltrating envelope requires a non-zero blast_radius_budget.max_duration_ms");
        }
    }
    // VR-3 / DC-62: the profile is derived from the action tier the envelope
    // PERMITS. Applied here so a hand-built envelope cannot declare or complete
    // below the floor its own permissions demand.
    if (VERIFICATION_PROFILES.includes(e.verification_policy)) {
        const requiredProfile = requiredPolicyFor(e);
        if (verificationProfileRank(e.verification_policy) < verificationProfileRank(requiredProfile)) {
            errors.push(
                `verification_policy '${e.verification_policy}' is below the '${requiredProfile}' ` +
                "required by the action tier this envelope permits (VR-3/DC-62)"
            );
        }
    }
    return errors;
}

/**
 * THE performance-critical local decision.
 *
 * Given a VALID envelope and a proposed attempt, decide whether the existing
 * envelope still covers it. No Authority call, no model call, no graph rebuild.
 *
 * TOTAL, on both sides: a malformed or under-described attempt is DENIED, and so
 * is a malformed envelope. Neither is ever classified as if it had declared
 * nothing, and no ranking helper can throw out of this function.
 *
 * `budgetState` is the mission's consumed-budget ledger (see `consumeBudget`),
 * and it is the difference between a budget and a wish. ME-14/BR-4 say an action
 * at 3/3 hosts cannot start a fourth; a per-attempt comparison alone cannot know
 * that, so five independent 1-host effects on a 3-host budget all fast-pathed.
 * An effectful attempt therefore carries the ledger forward or it is not proven
 * to be inside the budget — the same fail-closed posture as an undeclared blast
 * radius, for the same reason (audit 4, P1-5).
 *
 * @param {object} envelope
 * @param {object} attempt
 * @param {object|null} budgetState  the ledger from the mission's prior effects
 * @returns {{decision:string, reasons:string[], detail:object}}
 */
function localEnvelopeDecision(envelope, attempt = {}, budgetState = null) {
    const reasons = [];
    const detail = {};
    // Set by the aggregate-budget step and attached to `detail` only if the
    // attempt clears every hold check (audit 5, P2-7).
    let pendingDebit_ = null;
    let holdReasons_ = null;
    let holdDetail_ = null;

    // No envelope is unconditional, and needs no attempt analysis to state.
    if (!envelope || !envelope.mission_id) {
        return { decision: "DENY", reasons: ["NO_ENVELOPE"], detail: { note: "no envelope => no cyber action" } };
    }

    const malformed = validateAttempt(attempt);
    if (malformed.length) {
        return { decision: "DENY", reasons: ["MALFORMED_ATTEMPT"], detail: { errors: malformed } };
    }

    const badEnvelope = envelopeShapeErrors(envelope);
    if (badEnvelope.length) {
        return { decision: "DENY", reasons: ["MALFORMED_ENVELOPE"], detail: { errors: badEnvelope } };
    }

    const at = attempt.at ?? Date.now();

    // 1. Hard denials first. Escalation cannot repair a prohibited method.
    const prohibited = envelope.prohibited_methods ?? [];
    if (attempt.method && prohibited.includes(attempt.method)) {
        return { decision: "DENY", reasons: ["METHOD_PROHIBITED"], detail: { method: attempt.method } };
    }
    const methodUnknown = Boolean(attempt.method) && !(envelope.allowed_methods ?? []).includes(attempt.method);
    if (methodUnknown) {
        return { decision: "DENY", reasons: ["METHOD_NOT_ALLOWED"], detail: { method: attempt.method } };
    }
    if ((attempt.persistence === true) && !envelope.persistence_allowed) {
        return { decision: "DENY", reasons: ["PERSISTENCE_NOT_ALLOWED"], detail: {} };
    }
    if ((attempt.destructive === true) && !envelope.destructive_actions_allowed) {
        return { decision: "DENY", reasons: ["DESTRUCTIVE_NOT_ALLOWED"], detail: {} };
    }
    // EXFILTRATION is an envelope field: an attempt that moves data out needs a
    // policy that permits it, and anything beyond the policy escalates
    // (audit 2 P1-N2). The wanted class is derived from the RANK of the declared
    // data scope, not from a single equality: CONTENT sits above
    // PROOF_OF_ACCESS_ONLY and must not ride a proof-of-access envelope
    // (audit 3, P1-3).
    const declaredDataScope = attempt.blastRadius?.dataScope;
    const wantedExfil = attempt.exfiltration === true
        ? (declaredDataScope !== undefined &&
            dataScopeRank(declaredDataScope) > dataScopeRank("PROOF_OF_ACCESS_ONLY")
            ? "AUTHORIZED_DATA"
            : "PROOF_OF_ACCESS_ONLY")
        : "NONE";
    const capabilityUnknown =
        Boolean(attempt.capability) && !(envelope.allowed_capabilities ?? []).includes(attempt.capability);
    if (capabilityUnknown) {
        return { decision: "DENY", reasons: ["CAPABILITY_NOT_IN_ENVELOPE"], detail: { capability: attempt.capability } };
    }

    // 2. Boundary changes. These escalate; they are the ONLY escalation triggers.
    const window_ = envelope.time_window ?? {};
    if (window_.end !== null && window_.end !== undefined && at > window_.end) {
        return { decision: "ESCALATE", reasons: ["MISSION_EXPIRY"], detail: { at, end: window_.end } };
    }
    // A window is a window, not just an end date: an attempt before the mission
    // opens is outside the authorization, and "WINDOW VALID" is a stated
    // continuity condition (audit 4, P2-2).
    if (window_.start !== null && window_.start !== undefined && at < window_.start) {
        return { decision: "ESCALATE", reasons: ["MISSION_NOT_YET_OPEN"], detail: { at, start: window_.start } };
    }

    const assetScope = envelope.asset_scope ?? [];
    for (const t of attempt.targets ?? []) {
        if (!assetScope.includes(t)) {
            reasons.push("NEW_TARGET");
            detail.newTarget = t;
        }
    }
    const authScope = envelope.authorized_scope ?? [];
    for (const s of attempt.scopeTokens ?? []) {
        if (!authScope.includes(s)) {
            reasons.push("NEW_SCOPE");
            detail.newScope = s;
        }
    }
    // `authScope` is the null-safe copy; the two privilege/credential checks below
    // read `envelope.authorized_scope` DIRECTLY, which threw a raw TypeError when
    // the field was absent (audit 10, P1-A). The hardening at line 1648 was applied
    // to one of three reads in this same block.
    if (attempt.privilegeLevel !== undefined && !authScope.includes(`priv:${attempt.privilegeLevel}`)) {
        reasons.push("NEW_PRIVILEGE_LEVEL");
        detail.privilegeLevel = attempt.privilegeLevel;
    }
    if (attempt.credentialClass !== undefined &&
        !authScope.includes(`cred:${attempt.credentialClass}`)) {
        reasons.push("NEW_CREDENTIAL_CLASS");
        detail.credentialClass = attempt.credentialClass;
    }
    if (attempt.dataAccessClass !== undefined &&
        dataScopeRank(attempt.dataAccessClass) > dataScopeRank(envelope.data_access_limit)) {
        reasons.push("NEW_DATA_ACCESS_CLASS");
        detail.dataAccessClass = attempt.dataAccessClass;
    }
    if (attempt.riskLevel !== undefined && riskRank(attempt.riskLevel) > riskRank(envelope.max_risk_level)) {
        reasons.push("HIGHER_RISK");
        detail.riskLevel = attempt.riskLevel;
    }
    if (attempt.pivotDepth !== undefined && attempt.pivotDepth > envelope.allowed_pivot_depth) {
        reasons.push("NEW_PIVOT");
        detail.pivotDepth = attempt.pivotDepth;
    }
    // A deeper exploit is its own boundary change. It was labelled by whichever
    // depth rung it crossed (`NEW_PRIVILEGE_LEVEL`, or `PERSISTENCE` at L5), so an
    // escalation was reported as a privilege change it was not, and L5 was
    // reported as persistence (audit 5, ADVISORY-1).
    if (attempt.exploitDepth !== undefined && depthRank(attempt.exploitDepth) > depthRank(envelope.offsec_depth)) {
        reasons.push("DEEPER_EXPLOIT");
        detail.exploitDepth = attempt.exploitDepth;
    }
    if (attempt.destructive === true && depthRank(envelope.offsec_depth) < depthRank("LEVEL_5")) {
        reasons.push("DESTRUCTIVE_EFFECT");
    }
    if (attempt.persistence === true && depthRank(envelope.offsec_depth) < depthRank("LEVEL_5")) {
        reasons.push("PERSISTENCE");
    }
    if (exfiltrationRank(wantedExfil) > exfiltrationRank(envelope.exfiltration_policy)) {
        reasons.push("EXFILTRATION");
        detail.exfiltration = wantedExfil;
    }

    // Every documented blast-radius limit is compared, and an effectful attempt
    // that declares NO magnitude fails closed rather than skipping the check
    // (audit 2 P1-N1/P1-N3; audit 3 P1-1). `blastRadius: {}` is treated exactly
    // like an absent `blastRadius`: an empty declaration declares nothing, and
    // "declares nothing" must not mean "unbounded".
    const blast = attempt.blastRadius;
    const budget = envelope.blast_radius_budget ?? {};
    const effectful = attempt.destructive === true || attempt.persistence === true ||
        attempt.exfiltration === true ||
        (attempt.exploitDepth !== undefined && depthRank(attempt.exploitDepth) >= depthRank("LEVEL_3"));
    const blastDeclared = isPlainObject(blast) && Object.keys(blast).length > 0;

    if (!blastDeclared) {
        if (effectful) {
            reasons.push("LARGER_BLAST_RADIUS");
            detail.blastRadiusUndeclared = true;
        }
    } else {
        // An effectful attempt must declare the MAGNITUDE of its effect, and it
        // must be NON-ZERO: `{hosts: 0}` satisfies "declared a count" while
        // describing an effect that touches nothing, which is not a description
        // of a destructive, persistent or exfiltrating act (audit 3, P1-1).
        // `MAGNITUDE_BLAST_KEYS` is the single source of that key list, and the
        // duration dimension is excluded because a duration is not a count.
        if (effectful) {
            const magnitude = MAGNITUDE_BLAST_KEYS
                .filter((k) => k !== "durationMs")
                .reduce((a, k) => a + (blast[k] ?? 0), 0);
            if (magnitude === 0) {
                reasons.push("LARGER_BLAST_RADIUS");
                detail.blastRadiusIncomplete =
                    "an effectful attempt must declare a non-zero host/account/process magnitude";
            }
        }
        if (attempt.exfiltration === true && blast.dataScope === undefined) {
            reasons.push("LARGER_BLAST_RADIUS");
            detail.dataScopeUndeclared = true;
        }
        for (const [k, capKey] of [["hosts", "max_hosts"], ["accounts", "max_accounts"], ["processes", "max_processes"]]) {
            const want = blast[k] ?? 0;
            if (want > budget[capKey]) {
                reasons.push("LARGER_BLAST_RADIUS");
                detail[`${k}Over`] = want - budget[capKey];
            }
        }
        // `max_duration_ms: 0` means "no lasting effect", not "unbounded".
        const wantMs = blast.durationMs ?? 0;
        if (wantMs > budget.max_duration_ms) {
            reasons.push("LARGER_BLAST_RADIUS");
            detail.durationOver = wantMs - budget.max_duration_ms;
        }
        if (blast.networkScope !== undefined &&
            networkScopeRank(blast.networkScope) > networkScopeRank(budget.max_network_scope)) {
            reasons.push("LARGER_BLAST_RADIUS");
            detail.networkScope = blast.networkScope;
        }
        if (blast.dataScope !== undefined &&
            dataScopeRank(blast.dataScope) > dataScopeRank(budget.max_data_scope)) {
            reasons.push("LARGER_BLAST_RADIUS");
            detail.dataScope = blast.dataScope;
        }

        // The AGGREGATE ceiling. A per-attempt comparison cannot see that the
        // mission has already spent its budget, so an effectful attempt that
        // declares a magnitude must bring the ledger — and the debit is what
        // makes BR-4's "3/3 cannot start a fourth" true. Without this,
        // `consumeBudget` is a well-tested orphan and ME-14 is prose
        // (audit 4, P1-5).
        //
        // The debit is COMPUTED here but not attached to `detail` until the
        // attempt is actually cleared: a held attempt must not report a debit for
        // an effect it never performed, or a caller threading `nextBudgetState`
        // would spend budget on a hold (audit 5, P2-7). It is named
        // `nextBudgetState` on a FAST_PATH, where it is valid.
        if (effectful && !reasons.length) {
            if (!budgetState) {
                reasons.push("LARGER_BLAST_RADIUS");
                detail.budgetStateMissing = true;
            } else {
                const debit = consumeBudget(envelope, {
                    hosts: blast.hosts ?? 0,
                    accounts: blast.accounts ?? 0,
                    processes: blast.processes ?? 0,
                    elapsedMs: blast.durationMs ?? 0
                }, budgetState);
                if (!debit.ok) {
                    if (debit.reason === "BUDGET_EXHAUSTED") {
                        holdReasons_ = ["BUDGET_EXHAUSTED"];
                        holdDetail_ = { exceeded: debit.exceeded, consumed: debit.state };
                    } else {
                        reasons.push("LARGER_BLAST_RADIUS");
                        detail.budgetStateMalformed = debit.reason;
                    }
                } else {
                    pendingDebit_ = debit.state;
                }
            }
        }
    }

    if (reasons.length) {
        return { decision: "ESCALATE", reasons: [...new Set(reasons)], detail };
    }

    // 3. Budget. Exhaustion is NOT a boundary change: hold, do not re-authorize.
    const usage = attempt.usage ?? {};
    const holdReasons = holdReasons_ ?? [];
    if (typeof usage.concurrent === "number" && usage.concurrent >= envelope.max_concurrency) {
        holdReasons.push("CONCURRENCY_EXHAUSTED");
    }
    if (typeof usage.recentRequestsPerMinute === "number" &&
        typeof envelope.rate_budget?.requestsPerMinute === "number" &&
        usage.recentRequestsPerMinute >= envelope.rate_budget.requestsPerMinute) {
        holdReasons.push("RATE_EXHAUSTED");
    }
    if (holdReasons.length) {
        // A HELD attempt performed no effect, so it reports no debit: `detail`
        // never carries a `nextBudgetState` here (audit 5, P2-7).
        return {
            decision: "BUDGET_HOLD", reasons: holdReasons,
            detail: { ...holdDetail_, retryAfterMs: attempt.retryAfterMs ?? 1000 }
        };
    }

    // `detail` is carried through, not rebuilt: it holds the next budget state
    // an effectful attempt must take forward, and a fresh literal here would
    // silently discard the debit — the fix that does not reach the caller.
    if (pendingDebit_) detail.nextBudgetState = pendingDebit_;
    return {
        decision: "FAST_PATH", reasons: [],
        detail: { ...detail, verificationProfile: envelope.verification_policy }
    };
}

/**
 * Deterministic security risk prioritisation. NO model call, ever
 * (NO_MODEL_CALL_FOR_DETERMINISTIC_WORK). Produces a ranking only —
 * never a permission.
 */
const RISK_WEIGHTS = Object.freeze({
    exploitability: 3.0,
    reachability: 2.5,
    assetCriticality: 2.0,
    privilegeGain: 2.0,
    blastRadius: 1.5,
    evidenceConfidence: 1.0,
    existingControls: -2.0,
    detectionCoverage: -1.0,
    remediationCost: -0.5
});

/**
 * The nine documented risk dimensions. Allow-listed ONLY inside scoreFinding:
 * they are severity inputs (numbers in 0..1), not authority fields. Every other
 * key in a finding is still subject to the full authority-shaped/secret scan.
 */
const RISK_FACTOR_KEYS = Object.freeze([...Object.keys(RISK_WEIGHTS), "factors"]);

/**
 * Containers whose child keys are a DIFFERENT vocabulary from the object that
 * holds them, and the vocabulary their children may use.
 *
 * `factors` is exempt under both a risk factor set and a score projection, and its
 * members are the risk dimensions — so it cannot simply inherit the surrounding
 * allowlist. The four envelope budgets are here for the same reason: their names
 * are ordinary words (`leaseOnly`, `start`), while the envelope's own allowlist is
 * full of authority-shaped names, so inheriting it would leave them checked
 * against the wrong vocabulary. A table rather than hardcoded keys, so a second
 * such container is a data change and not a new branch (audit 6, ADVISORY-2;
 * audit 7, P1-1). Declared here because `factors` depends on `RISK_FACTOR_KEYS`;
 * `scanForbiddenFields` reads it at call time.
 */
const NESTED_VOCABULARY_CONTAINERS = frozenLookup({
    factors: RISK_FACTOR_KEYS,
    ...ENVELOPE_NESTED_KEY_SETS
});

const DEFAULT_FACTOR_SCORES = Object.freeze({
    exploitability: 0, reachability: 0, assetCriticality: 0, privilegeGain: 0,
    blastRadius: 0, evidenceConfidence: 0, existingControls: 0,
    detectionCoverage: 0, remediationCost: 0
});

function scoreFinding(finding = {}) {
    // A non-object is refused with the documented code, not a raw TypeError.
    // `scoreFinding(null)` threw `Cannot read properties of null (reading
    // 'factors')` after the scan, which is the one thing a total classifier must
    // not do (audit 11, P2-3). `assertCyberRecord` already answers `DCD-01` here;
    // this makes the module consistent with itself.
    if (!isPlainObject(finding)) {
        return { ok: false, code: "DCD-01", errors: ["not an object"], score: null, band: null };
    }
    const forbidden = scanForbiddenFields(finding, "$", 0, [], RISK_FACTOR_KEYS);
    if (forbidden.length) {
        return { ok: false, code: "DCD-AUTHORITY-SHAPED", errors: forbidden, score: null, band: null };
    }
    const factors = { ...DEFAULT_FACTOR_SCORES, ...(finding.factors ?? {}) };
    let raw = 0;
    for (const [k, w] of Object.entries(RISK_WEIGHTS)) {
        const v = typeof factors[k] === "number" && factors[k] >= 0 && factors[k] <= 1 ? factors[k] : 0;
        raw += w * v;
    }
    const maxNegative = Math.abs(RISK_WEIGHTS.existingControls) + Math.abs(RISK_WEIGHTS.detectionCoverage) +
        Math.abs(RISK_WEIGHTS.remediationCost);
    const max = Object.values(RISK_WEIGHTS).reduce((a, b) => a + Math.abs(b), 0);
    const normalised = Math.max(0, Math.min(1, (raw + maxNegative) / (max + maxNegative)));
    const band = normalised >= 0.75 ? "CRITICAL" : normalised >= 0.5 ? "HIGH" :
        normalised >= 0.25 ? "MEDIUM" : "LOW";
    return {
        ok: true, code: null, errors: [],
        score: Number(normalised.toFixed(4)),
        band,
        factors: Object.freeze({ ...factors }),
        deterministic: true,
        authorityRef: null,      // a score is never an authorization
        rankingOnly: true
    };
}

/**
 * A completion claim is trusted only with its profile's required evidence, AND
 * — when a mission envelope is in play — with its cleanup obligation discharged.
 * CV-2 / DC-64. The cleanup requirement is derived from the envelope, not from
 * the profile, because whether cleanup is owed is a mission property.
 *
 * `envelope` is optional so that non-mission verification stays expressible, but
 * every mission-scoped caller passes it: with `cleanup_required !== false` an
 * otherwise-complete CRITICAL claim is still refused for a missing
 * `cleanup_completed`.
 *
 * `action` names the capability this completion CLAIMS TO HAVE PERFORMED (a
 * capability string, or an object with `.capability`). On an envelope that
 * permits a rotation the action is REQUIRED, because the permit list states what
 * the mission may do, not what this claim did — inferring the requirement from
 * the permit list demanded three rotation keys to complete a `telemetry` action
 * (audit 5's own fix, ruled too wide), while omitting the inference entirely
 * left the requirement unreachable. Fail-closed on both sides: a rotation-capable
 * envelope that does not say which action is refused, and a rotation action must
 * prove its dependents.
 *
 * @returns {{ok:boolean, profile:string, missing:string[], reason:string|null}}
 */
function verifyCompletion(profile, providedKeys = [], envelope = null, action = null) {
    const required = VERIFICATION_REQUIREMENTS[profile];
    if (!required) {
        return { ok: false, profile: String(profile), missing: ["UNKNOWN_PROFILE"], reason: "UNKNOWN_VERIFICATION_PROFILE" };
    }
    // The evidence list must be an ARRAY. `new Set("post_state")` explodes a string
    // into its characters, so a bare string silently reported every requirement
    // missing (and `new Set` on a Map/Set behaves differently again) — the same
    // shape as verifyCleanup's string bug (audit 10, P2-2).
    if (!Array.isArray(providedKeys)) {
        return { ok: false, profile: String(profile), missing: ["MALFORMED_PROVIDED_KEYS"], reason: "MALFORMED_PROVIDED_KEYS" };
    }
    const provided = new Set(providedKeys);
    const missing = required.filter((k) => !provided.has(k));

    // VR-4 / D-1: the envelope's policy is a FLOOR, not a suggestion. A caller
    // may verify more strictly than the envelope demands, never less.
    //
    // The comparison is TOTAL over profile KEYS, not only over
    // `VERIFICATION_PROFILES` (audit 3, P1-6). `CREDENTIAL_ROTATION` has its own
    // requirement set but is not on the severity scale, so guarding with
    // `VERIFICATION_PROFILES.includes(profile)` silently skipped the floor and
    // let three credential checks complete a CRITICAL mass-isolation envelope.
    if (envelope) {
        // `VERIFICATION_REQUIREMENTS` keys and `PROFILE_RANK` keys are asserted
        // identical by AUD6-4, so the earlier `required` check at the top has
        // already refused an unrankable profile — the duplicate guard that sat
        // here was unreachable (audit 6, ADVISORY-4). The structural assertion
        // is what keeps that true.
        // A hand-built envelope never passed `makeMissionEnvelope`, so the same
        // rule list is applied here too (audit 4, P1-4). Otherwise a hand-built
        // `destructive_actions_allowed: true` + `verification_policy: "LOW"`
        // envelope completed on one `post_state`, bypassing DC-62/DC-104.
        const envelopeErrors = envelopeShapeErrors(envelope);
        if (envelopeErrors.length) {
            return {
                ok: false, profile, missing: ["MALFORMED_ENVELOPE"],
                reason: "MALFORMED_ENVELOPE"
            };
        }
        // The floor is the DECLARED policy raised to what the envelope's own
        // permissions demand. Taking the max means a profile below either fails.
        const declaredFloor = PROFILE_RANK[envelope.verification_policy];
        if (declaredFloor === undefined) {
            return {
                ok: false, profile, missing: ["UNRANKABLE_ENVELOPE_POLICY"],
                reason: "ENVELOPE_POLICY_UNKNOWN"
            };
        }
        const derivedFloor = verificationProfileRank(requiredPolicyFor(envelope));
        if (verificationProfileRank(profile) < Math.max(declaredFloor, derivedFloor)) {
            return {
                ok: false, profile, missing: ["PROFILE_STRICTER_THAN_ENVELOPE"],
                reason: "VERIFICATION_PROFILE_BELOW_ENVELOPE"
            };
        }
    }

    if (envelope && envelope.cleanup_required !== false && !provided.has("cleanup_completed")) {
        missing.push("cleanup_completed");
    }

    // DC-67, additively — and now correctly scoped (audit 5, P2-4; audit 5's own
    // fix ruled too wide). The rotation requirement follows the ACTION this claim
    // performed, which the envelope's permit list cannot tell us: a mission that
    // merely PERMITS `credential_revocation` was demanding three rotation keys to
    // complete a telemetry action. So on a rotation-capable envelope the action
    // must be named — fail-closed rather than guessed — and a rotation action
    // must prove its dependents.
    if (envelope) {
        const permitsRotation = (envelope.allowed_capabilities ?? [])
            .some((c) => ROTATION_CAPABILITIES.includes(c));
        if (permitsRotation) {
            const completed = typeof action === "string" ? action : action?.capability;
            if (!completed) {
                return {
                    ok: false, profile, missing: ["ACTION_REQUIRED"],
                    reason: "ROTATION_CAPABLE_ENVELOPE_REQUIRES_ACTION"
                };
            }
            // A typo must not drop the requirement: `"credential_revocaton"` is
            // not a capability, so it cannot be a rotation, and silently treating
            // it as "not a rotation" is exactly how the requirement disappeared
            // (audit 6, P2-1).
            if (!CAPABILITY_VOCABULARY.includes(completed) &&
                !(envelope.allowed_capabilities ?? []).includes(completed)) {
                return {
                    ok: false, profile, missing: ["ACTION_UNKNOWN"],
                    reason: "UNKNOWN_ACTION_CAPABILITY"
                };
            }
            if (ROTATION_CAPABILITIES.includes(completed)) {
                for (const k of VERIFICATION_REQUIREMENTS.CREDENTIAL_ROTATION) {
                    if (!provided.has(k)) missing.push(k);
                }
            }
        }
    }

    return {
        ok: missing.length === 0,
        profile,
        missing: [...new Set(missing)],
        reason: missing.length ? "REQUIRED_VERIFICATION_MISSING" : null
    };
}

/** A credential lease is bounded capability, never authority. */
function makeCredentialLease({ leaseId, credentialRef, scope, protocol, issuedAt, expiresAt, missionId, envelope = null }) {
    for (const k of ["leaseId", "credentialRef", "scope", "protocol", "expiresAt", "missionId"]) {
        if (!arguments[0]?.[k]) throw new Error(`dcd: credential lease missing '${k}'`);
    }
    if (typeof expiresAt !== "number" || typeof issuedAt !== "number") {
        throw new Error("dcd: credential lease needs numeric issuedAt/expiresAt");
    }
    // Both OPERANDS of the ceiling comparison must be readable, not just the
    // ceiling. `expiresAt - NaN > maxLeaseMs` is FALSE, so a non-finite
    // `issuedAt` minted an unbounded lease under a valid ceiling — audit 8
    // repaired the ceiling here and left the operand it is compared against
    // unreadable, which is the same "bound that cannot be read" class one operand
    // over (audit 9, P1-1). A clock read that yields NaN must not widen a lease.
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
        throw new Error("dcd: credential lease needs a finite issuedAt/expiresAt to bound it");
    }
    if (expiresAt <= issuedAt) throw new Error("dcd: credential lease must expire after issue");
    // `credential_policy.maxLeaseMs` is a bound, so it must be read somewhere.
    // It was validated at construction and never enforced, so a lease outliving
    // the mission's policy was constructible under any envelope — the same
    // "declared control that controls nothing" shape as exfiltration_policy
    // (audit 4, P2-3). The policy is applied when an envelope is supplied, which
    // is the mission-scoped path.
    if (envelope) {
        const policy = envelope.credential_policy;
        if (!isPlainObject(policy) || policy.leaseOnly !== true) {
            throw new Error("dcd: envelope credential policy is not lease-only; no lease may be issued");
        }
        // The bound must be READABLE. `expiresAt - issuedAt > "x"` is false, so a
        // hand-built policy with a non-numeric ceiling mints an unbounded lease —
        // the same fail-open as an unreadable blast-radius ceiling (audit 8,
        // P1-3). The factory refuses that policy; this path must not accept it.
        if (!Number.isFinite(policy.maxLeaseMs) || policy.maxLeaseMs <= 0) {
            throw new Error(
                "dcd: credential_policy.maxLeaseMs must be a finite positive number to bound a lease"
            );
        }
        if (expiresAt - issuedAt > policy.maxLeaseMs) {
            throw new Error(
                `dcd: credential lease of ${expiresAt - issuedAt}ms exceeds credential_policy.maxLeaseMs (${policy.maxLeaseMs})`
            );
        }
    }
    return Object.freeze({
        leaseId, credentialRef, scope, protocol, issuedAt, expiresAt, missionId,
        law: "LEASE_IS_NOT_AUTHORITY",
        authorityRef: null
    });
}

/**
 * Is an acceptance marker truthful? Normalised, because an exact-match check on
 * one spelling is a bypass: `true`, `1`, `"accepted"`, `"ACCEPTED "` and
 * `"ACCEPTED_MANUALLY"` all read as accepted to a human and none read as
 * accepted to `===` (audit 2, P1-N5).
 *
 * Fail-closed by construction: a marker that is NOT recognisably negative is
 * treated as a claim of acceptance, so a row cannot slip an unverified sample
 * into the corpus by spelling its acceptance in a way the gate does not
 * recognise.
 */
const ACCEPTED_MARKERS = Object.freeze(["ACCEPTED", "ACCEPT", "YES", "TRUE", "1"]);
const REJECTED_MARKERS = Object.freeze(["REJECTED", "REJECT", "NO", "FALSE", "0"]);

/**
 * Prefixes that mark a row as NOT accepted. A rejection is usually qualified —
 * `REJECTED_BY_CRITIC`, `INSUFFICIENT_EVIDENCE` (a documented `VERIFIER_RESULTS`
 * value), `REFUTED`, `CONTRADICTED` — and reading those as claims of acceptance
 * broke the corpus workflow: an honest negative sample had to carry a VERIFIED
 * result to be admitted (audit 3, P2-6). The default stays fail-closed: anything
 * not recognisably negative is still a claim.
 */
const REJECTION_PREFIXES = Object.freeze([
    "REJECT", "REFUT", "CONTRADICT", "INSUFFICIENT", "NO", "FALSE", "DENIED", "FAIL", "DROP"
]);

function isAcceptedMarker(value) {
    if (value === undefined || value === null) return false;  // absent = no claim
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value !== "string") return true;      // unrecognised => treat as a claim
    const norm = value.trim().toUpperCase();
    if (REJECTED_MARKERS.includes(norm)) return false;
    if (REJECTION_PREFIXES.some((p) => norm.startsWith(p))) return false;
    return true;                                     // every other spelling is a claim
}

/**
 * Corpus admission for a distillation sample. Separate from
 * `assertTeacherArtifact`, which validates artifact SHAPE and posture; this
 * validates the PROVENANCE set required before a sample may enter the corpus
 * (KD §7.1). A sample missing any field is refused, never "accepted with gaps".
 *
 * `verification_result` is validated against `VERIFIER_RESULTS` and acceptance is
 * normalised, so an unverified row cannot enter the corpus by spelling "accepted"
 * differently (audit 2, P1-N5 / DC-46).
 * @returns {{ok:boolean, code:null|string, errors:string[]}}
 */
function assertDistillSample(sample = {}) {
    // A non-object is a malformed sample, not a crash (`null` defeated the `= {}`
    // default — audit 11, P2-4).
    if (!isPlainObject(sample)) {
        return { ok: false, code: "DCD-KD-02", errors: ["sample must be a plain object"] };
    }
    const required = [
        "teacher", "teacher_version", "scenario_id", "scope_type", "input_hash", "output_hash",
        "tool_trace", "verification_result", "critic_result", "difficulty", "capability_tags",
        "accepted_or_rejected"
    ];
    const missing = required.filter((k) => sample[k] === undefined || sample[k] === null);
    const errors = missing.map((k) => `sample missing '${k}' (not corpus-admissible)`);

    if (!DISTILL_DATA_FAMILIES.includes(sample.family)) {
        errors.push(`unknown or missing data family '${sample.family}'`);
    }
    if (sample.verification_result !== undefined && !VERIFIER_RESULTS.includes(sample.verification_result)) {
        errors.push(`unknown verification_result '${sample.verification_result}'`);
    }
    if (isAcceptedMarker(sample.accepted_or_rejected) && sample.verification_result !== "VERIFIED") {
        errors.push("an accepted sample requires verification_result=VERIFIED");
    }
    if (!TEACHER_KINDS.includes(sample.teacher_kind)) {
        errors.push(`unknown teacher_kind '${sample.teacher_kind}'`);
    }
    if (!SCOPE_TYPES.includes(sample.scope_type)) {
        errors.push(`unknown scope_type '${sample.scope_type}' (a lab claim is not an estate result)`);
    }
    const forbidden = scanForbiddenFields(sample, "$", 0, [], []);
    if (forbidden.length) return { ok: false, code: "DCD-AUTHORITY-SHAPED", errors: [...errors, ...forbidden] };
    return { ok: errors.length === 0, code: errors.length ? "DCD-KD-02" : null, errors };
}

/** The CLOSED key set of a cache entry. Anything else is an inadmissible payload. */
const CACHE_ENTRY_KEYS = Object.freeze([...CACHE_REQUIRED_FIELDS, "authorityRef"]);

/**
 * Validate a cache entry's shape (kind, arithmetic) and its closed key set.
 * Shared by the write and read paths so they cannot drift: the entry is a
 * provenance envelope ABOUT a cached observation, and there is nowhere in it for
 * a permission outcome to hide — `permit`, `effect`, `decision`, `outcome` are
 * unknown keys and are refused (audit 2 P1-N7; audit 3 P1-2).
 * @returns {null|string} a reason code, or null when admissible
 */
function cacheEntryDefect(entry) {
    if (!isPlainObject(entry)) return "MALFORMED";
    if (NEVER_CACHEABLE_KINDS.includes(entry.cacheKind)) return "NEVER_CACHEABLE_KIND";
    if (!CACHE_KINDS.includes(entry.cacheKind)) return "UNKNOWN_KIND";
    // Payload first: a forbidden or nested payload is a security violation, so it
    // is reported as one rather than as a schema gap. The cache entry is a
    // provenance envelope ABOUT a cached observation; every value in it is a
    // scalar or an array of scalars. There is nowhere for a permission outcome to
    // hide — including inside an allowed key, which is where
    // `{scope:{effect:"ALLOW"}}` hid after the depth-1 closure was added
    // (audit 4, P1-2).
    for (const k of Object.keys(entry)) {
        if (!CACHE_ENTRY_KEYS.includes(k)) return "FORBIDDEN_PAYLOAD";
        const v = entry[k];
        if (isPlainObject(v) || (Array.isArray(v) && v.some(isPlainObject))) return "NESTED_PAYLOAD";
    }
    const forbidden = scanForbiddenFields(entry, "$", 0, [], CACHE_ENTRY_KEYS);
    if (forbidden.length) return "FORBIDDEN_PAYLOAD";
    // The mandatory fields are required on BOTH halves. The read path used to
    // check only kind and TTL, so it served an entry the factory refuses —
    // contradicting its own docblock ("any entry the factory would have refused
    // is not usable") and cyber-state's "without exception" (audit 4, P1-6).
    if (CACHE_REQUIRED_FIELDS.some((k) => entry[k] === undefined || entry[k] === null)) {
        return "MISSING_PROVENANCE";
    }
    // The time defect is named by WHICH field is wrong. Folding a bad
    // `observedAt` into `MALFORMED_TTL` meant the read half could not distinguish
    // "bad ttl" from "bad observedAt" while the write half could, so the two
    // halves gave different reasons for the same input — the audit-5/6/7
    // cache-parity defect one dimension further down (audit 8, P2-2).
    if (!Number.isFinite(entry.ttlMs) || entry.ttlMs < 0) return "MALFORMED_TTL";
    if (!Number.isFinite(entry.observedAt)) return "MALFORMED_OBSERVED_AT";
    return null;
}

/**
 * A cache entry is admissible only with full provenance metadata, and a
 * permission/grant-shaped kind is not cacheable at all — the kind does not exist
 * in `CACHE_KINDS`, and naming one explicitly is reported as the forbidden cache
 * it is rather than as a generic unknown kind (DC-59).
 */
function makeCacheEntry(fields) {
    // A non-object is MALFORMED on BOTH halves. The read half has had this guard
    // since it was written; the write half read `fields.cacheKind` first, so
    // `makeCacheEntry(null)` threw a raw TypeError while `cacheEntryDefect(null)`
    // returned "MALFORMED". The `= {}` default also had to go: it converted an
    // absent argument into `{}`, which then reported `unknown cacheKind
    // 'undefined'` while the read half reported MALFORMED — the same halves-
    // disagree defect one input further down (audit 9, P2-2).
    if (!isPlainObject(fields)) throw new Error("dcd: cache entry is not admissible (MALFORMED)");
    // The rules are applied in the SAME ORDER as `cacheEntryDefect`, so the two
    // halves report the same reason for the same input. The kind used to be
    // checked first and the field set second (audit 5, P2-2), but a payload FORBID
    // still came after the missing-field error here while the read half reported
    // it first — so an entry that was both malformed and payload-forbidden got
    // two different answers (audit 6, P2-2). Order: kind, payload, fields, ttl.
    //
    // The payload check is now ONE pass over the keys in key order, exactly as
    // the read half does it, so the FIRST offending key decides on both sides
    // rather than "all unknown keys, then any nested value" (audit 7, P2-3).
    if (NEVER_CACHEABLE_KINDS.includes(fields.cacheKind)) {
        throw new Error(
            `dcd: cacheKind '${fields.cacheKind}' must never be cached (NO_CACHED_PERMISSION_OUTCOME); ` +
            "cache permission inputs, never a permission outcome"
        );
    }
    if (!CACHE_KINDS.includes(fields.cacheKind)) throw new Error(`dcd: unknown cacheKind '${fields.cacheKind}'`);

    for (const k of Object.keys(fields)) {
        if (!CACHE_ENTRY_KEYS.includes(k)) {
            throw new Error(`dcd: cache entry carries inadmissible field '${k}'`);
        }
        const v = fields[k];
        if (isPlainObject(v) || (Array.isArray(v) && v.some(isPlainObject))) {
            throw new Error(`dcd: cache entry is not admissible (NESTED_PAYLOAD: '${k}')`);
        }
    }

    const missing = CACHE_REQUIRED_FIELDS.filter((k) => fields[k] === undefined || fields[k] === null);
    if (missing.length) throw new Error(`dcd: cache entry missing ${missing.join(", ")}`);
    if (!Number.isFinite(fields.ttlMs) || fields.ttlMs < 0) {
        throw new Error("dcd: cache ttlMs must be a finite non-negative number");
    }
    if (!Number.isFinite(fields.observedAt)) {
        throw new Error("dcd: cache observedAt must be a finite epoch-ms number");
    }
    const defect = cacheEntryDefect({ ...fields, authorityRef: null });
    if (defect) throw new Error(`dcd: cache entry is not admissible (${defect})`);
    return Object.freeze({ ...fields, authorityRef: null });
}

/**
 * The cleanup gate, usable standalone by a mission completion path. A mission
 * whose envelope owes cleanup cannot be reported complete on action evidence
 * alone (CV-2 / DC-64).
 * @returns {{ok:boolean, required:boolean, missing:string[], reason:string|null}}
 */
function verifyCleanup(envelope, providedKeys = []) {
    // The evidence list must be an ARRAY. A bare string satisfied the obligation
    // silently (`providedKeys.includes("cleanup_completed")` is true for the string
    // `"cleanup_completed"`), so a caller could discharge a mission's cleanup by
    // passing a string, and a number threw a raw TypeError (audit 10, P2-2).
    if (!Array.isArray(providedKeys)) {
        return { ok: false, required: true, missing: ["MALFORMED_PROVIDED_KEYS"], reason: "MALFORMED_PROVIDED_KEYS" };
    }
    // An obligation may only be waived by an envelope that actually SAYS so and is
    // otherwise valid. A hand-built `{cleanup_required:false}` waived the
    // obligation outright, so a malformed envelope could discharge a mission's
    // cleanup for it (audit 8, P1-3). `null`/absent still means "no mission
    // envelope, no obligation"; a supplied envelope must be well-formed.
    //
    // A SUPPLIED but non-object envelope (`42`, a string, a `Map`) is malformed,
    // not absent. It used to fall through to the obligation branch and report
    // CLEANUP_OBLIGATION_OUTSTANDING — fail-closed, but it told the caller to run
    // cleanup for a shape that is not an envelope at all (audit 11, ADV-3).
    if (envelope !== undefined && envelope !== null && !isPlainObject(envelope)) {
        return { ok: false, required: true, missing: ["MALFORMED_ENVELOPE"], reason: "MALFORMED_ENVELOPE" };
    }
    if (envelope && isPlainObject(envelope)) {
        const errors = envelopeShapeErrors(envelope);
        if (errors.length) {
            return { ok: false, required: true, missing: ["MALFORMED_ENVELOPE"], reason: "MALFORMED_ENVELOPE" };
        }
    }
    const required = envelope ? envelope.cleanup_required !== false : false;
    if (!required) return { ok: true, required: false, missing: [], reason: null };
    const missing = providedKeys.includes("cleanup_completed") ? [] : ["cleanup_completed"];
    return {
        ok: missing.length === 0,
        required: true,
        missing,
        reason: missing.length ? "CLEANUP_OBLIGATION_OUTSTANDING" : null
    };
}

/**
 * A cache read is fresh only inside its TTL. Expired => recompute, never serve.
 *
 * The read path is validated as strictly as the write path — BOTH halves guard
 * both dimensions (audit 2 P1-N7; audit 3 P1-2). Kind/kind-and-TTL checking was
 * not enough: a hand-built `{cacheKind:"DNS", effect:"ALLOW"}` was served fresh,
 * a permission outcome under an allowed kind, which is the forbidden cache by
 * the other door. Any entry the factory would have refused is not usable.
 */
function cacheUsable(entry, at = Date.now()) {
    if (!entry) return { usable: false, reason: "ABSENT" };
    const defect = cacheEntryDefect(entry);
    if (defect) return { usable: false, reason: defect };
    // The READ TIME must be readable, for the same reason a ceiling must be:
    // `NaN > t` and `"nope" > t` are both FALSE, so an unreadable `at` skipped the
    // staleness comparison and served a long-expired entry as fresh — the exact
    // "stale as fresh" failure the cache exists to prevent (audit 9, P1-2). Only
    // an explicit `undefined` takes the default; anything else must be a finite
    // epoch-ms number.
    if (at !== undefined && !Number.isFinite(at)) {
        return { usable: false, reason: "MALFORMED_READ_TIME" };
    }
    if (at > entry.observedAt + entry.ttlMs) return { usable: false, reason: "STALE" };
    return { usable: true, reason: null };
}

/**
 * A usage ledger for a mission envelope. A budget that is never debited is
 * advice, not a limit (BR-4 / DC-66: "an action at 3/3 hosts cannot start a
 * fourth"). Consumption is explicit and monotone; the ledger is pure and
 * returns a new frozen state, so it composes with the fast path without a
 * round-trip and without mutating a running mission.
 *
 * @returns {{ok:boolean, allowed:boolean, reason:null|string, state:object}}
 */
function consumeBudget(envelope, usage = {}, state = null) {
    const budget = envelope?.blast_radius_budget;
    if (!isPlainObject(budget)) {
        return { ok: false, allowed: false, reason: "MALFORMED_ENVELOPE", state };
    }
    // The `usage` side is closed against the SAME four names the ledger sums, so a
    // typo'd or mis-cased key is refused rather than silently becoming a zero.
    // `{hostsX: 5}` used to debit nothing and return `allowed: true` — the exact
    // "typo disables the check" defect that the `prior` loop one line away already
    // closes (audit 9, P2-1). A non-object is MALFORMED_USAGE, never a raw
    // TypeError.
    if (!isPlainObject(usage)) {
        return { ok: false, allowed: false, reason: "MALFORMED_USAGE", state };
    }
    for (const k of Object.keys(usage)) {
        if (!LEDGER_KEYS.includes(k)) {
            return { ok: false, allowed: false, reason: "MALFORMED_USAGE", state };
        }
    }
    // A ceiling that cannot be READ is not a ceiling. `want > undefined` is false
    // and `want > "x"` is false, so an absent or non-numeric ceiling admitted
    // every debit and returned `allowed: true` — on the function the docs name as
    // the thing that makes "3/3 cannot start a fourth" true (audit 8, P1-3). This
    // module's other envelope consumers must not be the only ones that fail
    // closed; a partial budget is refused rather than treated as unbounded.
    for (const capKey of ["max_hosts", "max_accounts", "max_processes", "max_duration_ms"]) {
        if (!Number.isFinite(budget[capKey]) || budget[capKey] < 0) {
            return { ok: false, allowed: false, reason: "MALFORMED_ENVELOPE", state };
        }
    }
    // The PRIOR state is validated exactly as the usage is. A ledger that is not
    // a ledger is not evidence of anything: `{}` made every sum NaN (and NaN
    // compares false against every ceiling, so the budget stopped bounding), and
    // a negative `hosts` was unbounded CREDIT, so a caller could spend a budget
    // it never had. Fail-closed on the `!state` branch only was the audit-3
    // `blastRadius: {}` shape recurring on a new dimension (audit 5, P1-1).
    const prior = state ?? Object.freeze({ hosts: 0, accounts: 0, processes: 0, elapsedMs: 0 });
    if (!isPlainObject(prior)) {
        return { ok: false, allowed: false, reason: "MALFORMED_LEDGER", state: prior };
    }
    // Closed key set, exactly as `usage` is closed: an absent dimension is a zero
    // (`{}` is a fresh mission), but a MISSPELLED one is a refusal rather than a
    // silent zero — a ledger that silently forgets what was spent is the same
    // "typo disables the check" defect the usage key set closes (audit 3 P2-1,
    // audit 5 P1-1).
    for (const k of Object.keys(prior)) {
        if (!LEDGER_KEYS.includes(k)) {
            return { ok: false, allowed: false, reason: "MALFORMED_LEDGER", state: prior };
        }
    }
    for (const k of LEDGER_KEYS) {
        const v = prior[k] ?? 0;
        if (!Number.isFinite(v) || v < 0) {
            return { ok: false, allowed: false, reason: "MALFORMED_LEDGER", state: prior };
        }
    }
    const want = {
        hosts: (prior.hosts ?? 0) + (usage.hosts ?? 0),
        accounts: (prior.accounts ?? 0) + (usage.accounts ?? 0),
        processes: (prior.processes ?? 0) + (usage.processes ?? 0),
        elapsedMs: (prior.elapsedMs ?? 0) + (usage.elapsedMs ?? 0)
    };
    for (const [k, capKey] of [["hosts", "max_hosts"], ["accounts", "max_accounts"],
        ["processes", "max_processes"]]) {
        if (!Number.isFinite(usage[k] ?? 0) || (usage[k] ?? 0) < 0) {
            return { ok: false, allowed: false, reason: "MALFORMED_USAGE", state: prior };
        }
        if (want[k] > budget[capKey]) {
            return { ok: false, allowed: false, reason: "BUDGET_EXHAUSTED", state: prior, exceeded: k };
        }
    }
    if (!Number.isFinite(usage.elapsedMs ?? 0) || (usage.elapsedMs ?? 0) < 0) {
        return { ok: false, allowed: false, reason: "MALFORMED_USAGE", state: prior };
    }
    if (want.elapsedMs > budget.max_duration_ms) {
        return { ok: false, allowed: false, reason: "BUDGET_EXHAUSTED", state: prior, exceeded: "elapsedMs" };
    }
    return { ok: true, allowed: true, reason: null, state: Object.freeze(want) };
}

/** Normalise an attack-path edge. THEORETICAL != VALIDATED != AUTHORIZED. */
function makePathEdge(edge = {}) {
    // `null` is not covered by a destructuring `= {}` default (audit 11, P2-4).
    const { from, to, relation, state, evidenceRefs = [], missionRef = null } =
        isPlainObject(edge) ? edge : {};
    if (typeof from !== "string" || !from.trim()) throw new Error("dcd: path edge needs an entity id on 'from'");
    if (typeof to !== "string" || !to.trim()) throw new Error("dcd: path edge needs an entity id on 'to'");
    if (!GRAPH_RELATIONS.includes(relation)) throw new Error(`dcd: unknown relation '${relation}'`);
    if (!EDGE_STATES.includes(state)) throw new Error(`dcd: unknown edge state '${state}'`);
    // `evidenceRefs` must be an ARRAY of non-empty strings, and the check has to be
    // an array check rather than `.length`. `new Set()` has no `.length`, so
    // `undefined === 0` is FALSE and the guard was skipped — minting a VALIDATED
    // edge with zero evidence refs, silently inverting
    // THEORETICAL_PATH_NOT_VALIDATED_PATH (audit 11, P1-2). A bare string has a
    // `.length`, passed the guard, and was then spread into its CHARACTERS
    // (`"ev-1"` → `["e","v","-","1"]`), so garbage counted as evidence.
    if (!Array.isArray(evidenceRefs)) {
        throw new Error("dcd: path edge 'evidenceRefs' must be an array of references");
    }
    for (const ref of evidenceRefs) {
        if (typeof ref !== "string" || !ref.trim()) {
            throw new Error("dcd: every evidence ref must be a non-empty string");
        }
    }
    if (state === "VALIDATED" && evidenceRefs.length === 0) {
        throw new Error("dcd: VALIDATED edge requires at least one evidence ref (VALIDATED != ASSERTED)");
    }
    if (state === "AUTHORIZED_TO_TEST" && !missionRef) {
        throw new Error("dcd: AUTHORIZED_TO_TEST edge requires a mission ref (AUTHORIZED != VALIDATED)");
    }
    return Object.freeze({
        from, to, relation, state,
        evidenceRefs: Object.freeze([...evidenceRefs]),
        missionRef,
        // an authorized-to-test edge NEVER implies executability
        executable: false,
        authorityRef: null
    });
}

/** Bounded attack-path query plan. Unbounded traversal is refused, not clamped. */
function planPathQuery(request = {}) {
    // `null` defeated the `= {}` default and threw on the first property read,
    // instead of the documented ASSET_SCOPE_REQUIRED refusal (audit 11, P2-4).
    if (!isPlainObject(request)) return { ok: false, reason: "ASSET_SCOPE_REQUIRED" };
    const b = ATTACK_PATH_QUERY_BOUNDS;
    if (b.REQUIRE_ASSET_SCOPE && !request.assetScope) {
        return { ok: false, reason: "ASSET_SCOPE_REQUIRED" };
    }
    if (Array.isArray(request.assetScope) && request.assetScope.length === 0) {
        return { ok: false, reason: "ASSET_SCOPE_REQUIRED" };
    }
    // The bounds are validated at BOTH ends. A refusal at the top of the range
    // with no check at the bottom is not a bound: a negative or string depth is
    // not a depth (audit 2 P2-N11). `assetScope` is type- and size-checked, not
    // just truthiness-checked (audit 3, P2-3).
    const scope = request.assetScope;
    if (!Array.isArray(scope) || scope.length === 0) return { ok: false, reason: "ASSET_SCOPE_REQUIRED" };
    if (scope.length > b.MAX_ASSET_SCOPE) return { ok: false, reason: "ASSET_SCOPE_EXCEEDS_BOUND" };
    if (scope.some((s) => typeof s !== "string" || !s.trim())) {
        return { ok: false, reason: "ASSET_SCOPE_ENTRIES_MUST_BE_NON_EMPTY_STRINGS" };
    }
    const maxDepth = request.maxDepth ?? b.DEFAULT_MAX_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) return { ok: false, reason: "MAX_DEPTH_NOT_A_POSITIVE_INTEGER" };
    if (maxDepth > b.MAX_MAX_DEPTH) return { ok: false, reason: "MAX_DEPTH_EXCEEDS_BOUND" };
    const topK = request.topK ?? b.DEFAULT_TOP_K;
    if (!Number.isInteger(topK) || topK < 1) return { ok: false, reason: "TOP_K_NOT_A_POSITIVE_INTEGER" };
    if (topK > b.MAX_TOP_K) return { ok: false, reason: "TOP_K_EXCEEDS_BOUND" };
    const timeBudgetMs = request.timeBudgetMs ?? b.DEFAULT_TIME_BUDGET_MS;
    // A zero budget is degenerate, not a bound (audit 3, P2-9). An over-large one
    // is REFUSED, not clamped: the path doc says `planPathQuery` refuses
    // out-of-bounds requests at both ends, and silently serving a 10s request as
    // 2s is the clamp the doc rules out (audit 5, ADVISORY-3).
    if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) return { ok: false, reason: "TIME_BUDGET_INVALID" };
    if (timeBudgetMs > b.MAX_TIME_BUDGET_MS) return { ok: false, reason: "TIME_BUDGET_EXCEEDS_BOUND" };
    const riskThreshold = request.riskThreshold ?? 0;
    if (!Number.isFinite(riskThreshold) || riskThreshold < 0 || riskThreshold > 1) {
        return { ok: false, reason: "RISK_THRESHOLD_OUT_OF_RANGE" };
    }
    return {
        ok: true, reason: null,
        plan: Object.freeze({
            assetScope: request.assetScope,
            maxDepth,
            topK,
            riskThreshold,
            // Already refused above if over MAX_TIME_BUDGET_MS, so this is the
            // value itself — a clamp here would be dead code that implies a
            // tolerance the bound does not have (audit 6, ADVISORY-3).
            timeBudgetMs,
            incremental: true,        // local change => local recomputation
            fullRebuild: false
        })
    };
}

/** Incident transition guard. CONFIRMED never jumps to CONTAINING. */
function canTransition(from, to) {
    const allowed = INCIDENT_TRANSITIONS[from];
    if (!allowed) return { ok: false, reason: "UNKNOWN_STATE" };
    return allowed.includes(to)
        ? { ok: true, reason: null }
        : { ok: false, reason: "ILLEGAL_TRANSITION" };
}

/** Workload admission: critical response never queues behind background enrichment. */
function admitWorkload(workloadClass, queueDepth) {
    if (!WORKLOAD_CLASSES.includes(workloadClass)) return { admit: false, reason: "UNKNOWN_CLASS" };
    if (workloadClass === "REAL_TIME") return { admit: true, reason: null, preemptsBackground: true };
    if (workloadClass === "NEAR_REAL_TIME") return { admit: true, reason: null, preemptsBackground: false };
    // A queue depth that cannot be READ is not a depth. `queueDepth > 0` is FALSE
    // for `-1`, `NaN`, `null`, `undefined`, `{}` and `[]`, so six of nine inputs
    // admitted BACKGROUND work while PI-7's prose states an unconditional
    // refusal — the same "bound whose operand is unreadable" class audits 8 and 9
    // closed for a corrupt clock and a bad read time, one exported function over
    // (audit 10, P1-F). No PREP path calls this yet, so the bound was latent; it
    // is refused here rather than left to be discovered by its first caller.
    if (!Number.isInteger(queueDepth) || queueDepth < 0) {
        return { admit: false, reason: "UNKNOWN_QUEUE_DEPTH" };
    }
    return queueDepth > 0
        ? { admit: false, reason: "YIELD_TO_FOREGROUND" }
        : { admit: true, reason: null, preemptsBackground: false };
}

/** Teacher output is supervision material, never truth and never authority. */
function assertTeacherArtifact(artifact = {}) {
    const errors = [];
    // A non-object is a malformed artifact, not a crash (audit 11, P2-4).
    if (!isPlainObject(artifact)) {
        return { ok: false, code: "DCD-KD-01", errors: ["artifact must be a plain object"] };
    }
    if (!TEACHER_KINDS.includes(artifact.teacherKind)) errors.push(`unknown teacherKind '${artifact.teacherKind}'`);
    const outClass = artifact.outputClass;
    if (outClass !== undefined && !TEACHER_OUTPUT_CLASSES.includes(outClass)) {
        errors.push(`unknown outputClass '${outClass}'`);
    }
    if (artifact.verificationResult !== undefined &&
        !VERIFIER_RESULTS.includes(artifact.verificationResult)) {
        errors.push(`unknown verificationResult '${artifact.verificationResult}'`);
    }
    if (artifact.verificationResult === undefined) {
        errors.push("teacher artifact without an independent verifier result is not distillable");
    }
    // KD-6, normalised: `accepted: 1` / `"true"` must not bypass the gate
    // (audit 2, P1-N5).
    const accepted = isAcceptedMarker(artifact.accepted);
    if (accepted && artifact.verificationResult !== "VERIFIED") {
        errors.push("accepted sample requires verificationResult=VERIFIED");
    }
    // KD-F-2: a hypothesis set that never solicits disconfirmation is advocacy,
    // not analysis. An explicitly empty list is the honest form; omission is not.
    if (artifact.outputClass === "HYPOTHESES" && artifact.CONTRADICTING_EVIDENCE === undefined) {
        errors.push("HYPOTHESES require CONTRADICTING_EVIDENCE (may be empty, must be solicited)");
    }
    // KD-F-1 / KD-F-3 / KD-F-4: an ACCEPTED sample must be trainable, honest and
    // terminating. A sample with no discriminating test, no declared uncertainty
    // and no stop condition teaches confident phrasing, which is the exact
    // failure the pipeline exists to filter (audit 2, P2-N6).
    if (accepted) {
        if (artifact.NEXT_TEST === undefined || artifact.NEXT_TEST === null) {
            errors.push("accepted sample requires NEXT_TEST (KD-F-1)");
        }
        if (artifact.EXPECTED_RESULT === undefined || artifact.EXPECTED_RESULT === null) {
            errors.push("accepted sample requires EXPECTED_RESULT (KD-F-1)");
        }
        if (!Array.isArray(artifact.UNCERTAINTIES) || artifact.UNCERTAINTIES.length === 0) {
            errors.push("accepted sample requires non-empty UNCERTAINTIES (KD-F-3)");
        }
        if (artifact.STOP_CONDITION === undefined || artifact.STOP_CONDITION === null) {
            errors.push("accepted sample requires STOP_CONDITION (KD-F-4)");
        }
    }
    if (artifact.teacherConfidence !== undefined && typeof artifact.teacherConfidence === "number") {
        // carried for calibration only; never read as correctness
        if (artifact.confidenceIsCorrectness === true) {
            errors.push("teacher confidence is not correctness (TC-2)");
        }
    }
    const forbidden = scanForbiddenFields(artifact, "$", 0, [], []);
    if (forbidden.length) return { ok: false, code: "DCD-AUTHORITY-SHAPED", errors: [...errors, ...forbidden] };
    return { ok: errors.length === 0, code: errors.length ? "DCD-KD-01" : null, errors };
}

/**
 * Exports are deep-frozen: `Object.freeze(module.exports)` alone freezes the key
 * set while leaving every nested object live, so a caller could reassign
 * `contracts.assertCyberRecord` through the "frozen" surface (ADVISORY-4). This
 * is a guard against accidental mutation, not against an adversarial in-process
 * caller, which no freeze can be.
 */
const API = {
    PLANES, OPERATION_MODES,
    OFFSEC_DEPTHS, depthRank, DEFAULT_OFFSEC_DEPTH, DEPTH_REQUIRES_EXPLICIT_OPT_IN,
    RISK_LEVELS, riskRank, RESPONSE_TIERS, VERIFICATION_PROFILES, VERIFICATION_REQUIREMENTS,
    verificationProfileRank, tierForAction, requiredPolicyFor,
    WORKLOAD_CLASSES, CACHE_KINDS, CACHE_REQUIRED_FIELDS, CACHE_ENTRY_KEYS, NEVER_CACHEABLE_KINDS,
    BOUNDARY_CHANGE_KINDS, LOCAL_DECISIONS,
    NETWORK_SCOPES, DATA_SCOPES, EXFILTRATION_POLICIES,
    networkScopeRank, dataScopeRank, exfiltrationRank,
    ATTEMPT_KEYS, ATTEMPT_BLAST_KEYS, USAGE_KEYS, LEDGER_KEYS, MAGNITUDE_BLAST_KEYS, REFS_NAME,
    envelopeShapeErrors, cacheEntryDefect, validateAttempt, SOURCE_TIER_BINDINGS,
    REMOVED_SOURCE_BINDINGS, PROFILE_RANK,
    GRAPH_ENTITIES, GRAPH_RELATIONS, EDGE_STATES, edgeRank, ATTACK_PATH_QUERY_BOUNDS,
    INCIDENT_STATES, INCIDENT_TRANSITIONS,
    EVIDENCE_SOURCE_KINDS,
    TEACHER_KINDS, TEACHER_OUTPUT_CLASSES, VERIFIER_RESULTS, SCOPE_TYPES, DISTILL_DATA_FAMILIES,
    TEACHER_ESCALATION_TRIGGERS, ROTATION_CAPABILITIES, CAPABILITY_VOCABULARY, unrankedCapabilities,
    ALLOWED_TIERS, DCD_FORBIDDEN_TIERS, EPISTEMIC_CLASSES, ENVELOPE_KEYS,
    SCORE_PROJECTION_KEYS, TEACHER_ARTIFACT_KEYS, DISTILL_SAMPLE_KEYS,
    FORBIDDEN_KEY_PATTERNS, SECRET_KEY_PATTERNS, SECRET_WORD_SEGMENTS, NON_SECRET_KEY_NAMES,
    RAW_PAYLOAD_KEYS, RECORD_MAX_BYTES, RECORD_MAX_DEPTH, REF_VALUE_SCHEME, OPAQUE_ID,
    isSecretShaped, isSecretValue, isReference, isAcceptedMarker, KEYISH_NAME, laws,
    scanForbiddenFields, assertCyberRecord,
    makeMissionEnvelope, localEnvelopeDecision,
    RISK_WEIGHTS, RISK_FACTOR_KEYS, NESTED_VOCABULARY_CONTAINERS, MISSION_ENVELOPE_KEYS, RATE_BUDGET_KEYS, TIME_WINDOW_KEYS, CREDENTIAL_POLICY_KEYS, BLAST_RADIUS_BUDGET_KEYS, scoreFinding,
    verifyCompletion, verifyCleanup, consumeBudget, makeCredentialLease, makeCacheEntry, cacheUsable,
    makePathEdge, planPathQuery, canTransition, admitWorkload, assertTeacherArtifact,
    assertDistillSample
};

module.exports = Object.freeze(API);
