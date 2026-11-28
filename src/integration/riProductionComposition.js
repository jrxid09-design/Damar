"use strict";

/**
 * DAMAR RUNTIME INTEGRATION — Production Composition Root (UIX-W5 RI R2).
 *
 * Single production composition joining the four canonical domain owners
 * to the runtime and surface seams:
 *
 *   1. Conversation continuity:
 *      Canonical owner: src/runtime/sessionContinuity (SessionStore, ChannelManager)
 *      Transport peer: RuntimeHost console peer binding
 *      Ingress: host.channels.request("console", ...)
 *      Shadow stores: 0
 *
 *   2. Approval lifecycle:
 *      Canonical owner: src/approval (createApprovalDomain)
 *      Backing: canonical ACC (makeApprovalStore)
 *      Command seam: approvalDomain.decide() -> manager.resumeConfirmation() -> Gate re-evaluation
 *      Law: APPROVED != EXECUTED, AUTHORITY_SOURCE_COUNT = 1
 *
 *   3. Mission Intelligence:
 *      Canonical owner: src/cognition/mission (makeMissionIntelligence)
 *      Backing: canonical ACC KV (m:*, idx:missions)
 *      Legacy Lab fallback: NO
 *      Shadow stores: 0
 *
 *   4. Notification & DCD projection:
 *      Canonical owner: src/notification (createNotificationDomain)
 *      Policy owner: src/notification/policy (classify)
 *      DCD owner: src/cyber/intelligence (createDetectionEngine)
 *      Bridge: DCD incident -> notification.emitSource()
 *      Law: NOTIFICATION != AUTHORITY, DISMISS_MUTATES_DCD_SOURCE = NO
 *
 *   5. RI release identity freeze (V1):
 *      Canonical owner: src/runtime/release/riFreeze
 *      Record location: the composed ACC store, key `release:ri-freeze`
 *      Consumer: verifyReleaseIdentity() below
 *      Law: NO FREEZE APPLIED ON COMPOSITION, AUTHORITY_SOURCE_COUNT = 1
 *
 *   6. Werkudara patrol loop (owner direction 2026-11-28: patrols are
 *      continuous, not on-demand):
 *      Owner: src/integration/cyberPatrolLoop, wired here at composition
 *      Records: durable journal in the composed ACC store (`cyber:patrol:*`)
 *      Read seam: GET /api/ui/cyber/posture (patroli + patrolLoop)
 *      Law: assessments are read-only; action stays behind the Gate
 */

const { makeApprovalStore } = require("../approval/store");
const { createApprovalDomain, approvalOccurrence } = require("../approval");
const { makeNotificationStore } = require("../notification/store");
const { createNotificationDomain } = require("../notification");
const { makeMissionIntelligence } = require("../cognition/mission");
const { createDetectionEngine } = require("../cyber/intelligence");
const { createCyberPatrolLoop } = require("./cyberPatrolLoop");
const { createMemoryAccStore, createSqliteAccStore } = require("../cognition/persistence/AccStore");
const { createDamarManager } = require("../manager");
const { ensureProductionAuthorityComposed, getProductionAuthorityComposition } = require("../authority/productionComposition");
const { getCanonicalRuntimeHost } = require("../runtime/host/runtimeHost");
const riFreeze = require("../runtime/release/riFreeze");

let canonicalRiInstance = null;
let riCompositionPromise = null;
let boundHost = null;

// Event listeners for SSE streaming / cross-surface push
const eventSubscribers = new Set();

function broadcastEvent(event) {
    for (const listener of eventSubscribers) {
        try {
            listener(event);
        } catch {
            // Subscriber error must not break broadcast
        }
    }
}

function subscribeEvents(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    eventSubscribers.add(listener);
    return () => {
        eventSubscribers.delete(listener);
    };
}

function clearSubscribers() {
    eventSubscribers.clear();
}

/**
 * Compose or retrieve the canonical Runtime Integration singleton.
 *
 * @param {object} [opts]
 * @param {object} [opts.host] - Composed RuntimeHost instance
 * @param {object} [opts.acc] - ACC store instance
 * @param {object} [opts.audit] - Audit ledger instance
 * @returns {Promise<object>}
 */
async function ensureRuntimeIntegrationComposed({ host = null, acc = null, audit = null, clock = () => Date.now() } = {}) {
    const effectiveHost = host || getCanonicalRuntimeHost();
    if (canonicalRiInstance !== null) {
        if (effectiveHost && !boundHost) {
            boundHost = effectiveHost;
        }
        return canonicalRiInstance;
    }

    if (riCompositionPromise !== null) {
        return riCompositionPromise;
    }

    riCompositionPromise = (async () => {
        boundHost = effectiveHost;
        // 1. Ensure Authority & OwnerTrust are composed
        let authorityComp = getProductionAuthorityComposition();
        if (!authorityComp || !authorityComp.ownerTrust) {
            try {
                authorityComp = await ensureProductionAuthorityComposed();
            } catch {
                authorityComp = null;
            }
        }
        const ownerTrust = authorityComp?.ownerTrust ?? null;

        // 2. Resolve canonical ACC store
        let resolvedAcc = acc;
        if (!resolvedAcc) {
            if (process.env.DAMAR_ACC_STORE === "memory" || process.env.NODE_ENV === "test") {
                resolvedAcc = createMemoryAccStore();
            } else {
                try {
                    const dbMod = require("../memory/db");
                    if (dbMod && dbMod.database && typeof dbMod.database.run === "function") {
                        resolvedAcc = createSqliteAccStore(dbMod.database);
                    } else {
                        resolvedAcc = createMemoryAccStore();
                    }
                } catch {
                    resolvedAcc = createMemoryAccStore();
                }
            }
        }

        // 3. Resolve canonical Manager
        const manager = createDamarManager();

        // 4. Compose Approval Domain
        const approvalStore = makeApprovalStore(resolvedAcc);
        const approval = createApprovalDomain({
            store: approvalStore,
            ownerTrust,
            manager,
            audit,
            clock
        });

        // 5. Compose Notification Domain
        const notificationStore = makeNotificationStore(resolvedAcc);
        const notification = createNotificationDomain({
            store: notificationStore,
            audit,
            clock
        });

        // 6. Compose Mission Intelligence
        const missionIntel = makeMissionIntelligence(resolvedAcc);

        // 7. Compose Cyber Detection Engine (DCD)
        const cyber = createDetectionEngine();

        // 7B. Werkudara patrol loop: continuous read-only SISTEM and
        // JARINGAN patrols on engine-level timers in this composition
        // (never an external cron or watchdog). Starting it must never
        // break the composition: a patrol fault degrades the loop, not
        // the daemon.
        let patrol = null;
        try {
            patrol = createCyberPatrolLoop({ acc: resolvedAcc, clock, broadcast: broadcastEvent });
            patrol.start();
        } catch {
            patrol = null;
        }

        // 8. Bridge helpers for DCD incidents -> Notification projection
        async function recordDcdIncident(params) {
            const incident = cyber.createIncident(params);
            const sequence = incident.history ? incident.history.length : 1;
            const occurredAt = incident.createdAt || clock();

            try {
                await notification.emitSource({
                    sourceType: "security_incident",
                    sourceId: incident.incidentId,
                    sourceOccurrenceId: `${incident.incidentId}:${sequence}`,
                    sourceOccurrenceSequence: sequence,
                    occurredAt,
                    event: "detected",
                    severity: incident.riskLevel === "CRITICAL" ? "critical" : incident.riskLevel === "HIGH" ? "high" : "normal",
                    privacySensitivity: "SECRET", // Privacy fail-closed by default
                    summary: incident.summary || `Security incident detected: ${incident.incidentId}`,
                    targetSurfaces: ["web_dashboard", "cli"]
                });

                broadcastEvent({
                    type: "incident.created",
                    incidentId: incident.incidentId,
                    state: incident.state,
                    riskLevel: incident.riskLevel,
                    occurredAt
                });
            } catch {
                // Bridge emission must not crash caller
            }

            return incident;
        }

        async function transitionDcdIncident(incidentId, toState, opts = {}) {
            const transResult = cyber.transition(incidentId, toState, opts);
            if (!transResult.ok) return transResult;

            const incident = transResult.incident;
            const sequence = incident.history ? incident.history.length : 1;
            const occurredAt = opts.nowMs || clock();
            const eventType = toState === "CONFIRMED" ? "confirmed" : toState === "RESOLVED" ? "resolved" : "status_changed";

            try {
                await notification.emitSource({
                    sourceType: "security_incident",
                    sourceId: incidentId,
                    sourceOccurrenceId: `${incidentId}:${sequence}`,
                    sourceOccurrenceSequence: sequence,
                    occurredAt,
                    event: eventType,
                    severity: incident.riskLevel === "CRITICAL" ? "critical" : "normal",
                    privacySensitivity: "SECRET",
                    summary: incident.summary || `Security incident ${incidentId} transitioned to ${toState}`,
                    targetSurfaces: ["web_dashboard", "cli"]
                });

                broadcastEvent({
                    type: "incident.transitioned",
                    incidentId,
                    state: toState,
                    occurredAt
                });
            } catch {
                // Bridge emission must not crash caller
            }

            return transResult;
        }

        // 9. Bridge helpers for Approval suspensions -> Notification projection
        async function createApprovalFromSuspension(managerResult, opts = {}) {
            const surfaced = await approval.createFromSuspension(managerResult, opts);
            try {
                const occ = approvalOccurrence(surfaced);
                await notification.emitSource({
                    sourceType: "approval",
                    sourceId: surfaced.approval_id,
                    sourceOccurrenceId: occ.sourceOccurrenceId,
                    sourceOccurrenceSequence: occ.sourceOccurrenceSequence,
                    occurredAt: occ.occurredAt,
                    event: "pending",
                    severity: surfaced.risk === "CRITICAL" ? "critical" : "high",
                    privacySensitivity: "SECRET",
                    summary: surfaced.purpose || `Confirmation required for capability ${surfaced.capability_ref}`,
                    targetSurfaces: ["web_dashboard", "cli"]
                });

                broadcastEvent({
                    type: "approval.created",
                    approvalId: surfaced.approval_id,
                    state: surfaced.state,
                    capabilityRef: surfaced.capability_ref,
                    expiresAt: surfaced.expires_at
                });
            } catch {
                // Notification projection is best-effort
            }
            return surfaced;
        }

        async function decideApproval(params) {
            const result = await approval.decide(params);
            if (result && result.approval) {
                try {
                    const occ = approvalOccurrence(result.approval);
                    await notification.emitSource({
                        sourceType: "approval",
                        sourceId: result.approval.approval_id,
                        sourceOccurrenceId: occ.sourceOccurrenceId,
                        sourceOccurrenceSequence: occ.sourceOccurrenceSequence,
                        occurredAt: occ.occurredAt,
                        event: "resolved",
                        severity: "normal",
                        privacySensitivity: "SECRET",
                        summary: `Approval ${result.approval.approval_id} ${result.approval.state}`,
                        targetSurfaces: ["web_dashboard", "cli"]
                    });

                    broadcastEvent({
                        type: "approval.decided",
                        approvalId: result.approval.approval_id,
                        state: result.approval.state,
                        authorityResult: result.approval.authority_result,
                        idempotent: Boolean(result.idempotent)
                    });
                } catch {
                    // Best effort notification projection
                }
            }
            return result;
        }

        /**
         * CANONICAL RI FREEZE CONSUMER.
         *
         * Satu-satunya tempat di komposisi ini yang memutuskan apakah
         * identitas rilis RI boleh proceed. Sumber kebenaran: durable
         * readback dari store kanonik composition ini sendiri (`acc`) —
         * bukan argumen, bukan cache, bukan Git tag, bukan env var.
         *
         * Komposisi TIDAK PERNAH menerapkan freeze. Freeze adalah tindakan
         * operasional dan harus dilakukan eksplisit oleh operator lewat
         * `riFreeze.applyFreeze` — kalau komposisi menerapkannya sendiri,
         * setiap proses yang start akan membekukan identitasnya diam-diam.
         */
        async function freezeStatus() {
            return await riFreeze.readFreeze(resolvedAcc);
        }

        async function verifyReleaseIdentity(release) {
            return await riFreeze.assertReleaseFrozen({ store: resolvedAcc, release });
        }

        const instance = Object.freeze({
            get host() {
                return boundHost || getCanonicalRuntimeHost();
            },
            acc: resolvedAcc,
            ownerTrust,
            manager,
            approval,
            notification,
            mission: missionIntel.mission,
            missionIntelligence: missionIntel,
            cyber,
            patrol,
            // Canonical RI freeze consumer (V1). Read-only against the
            // composed ACC; it never applies a freeze on its own.
            freezeStatus,
            verifyReleaseIdentity,
            // Projection bridge
            recordDcdIncident,
            transitionDcdIncident,
            createApprovalFromSuspension,
            decideApproval,
            // Subscriptions
            subscribe: subscribeEvents,
            broadcast: broadcastEvent,
            clearSubscribers,
            // Lifecycle cleanup
            cleanup() {
                if (patrol) {
                    try { patrol.stop(); } catch { /* ignore cleanup faults */ }
                }
                clearSubscribers();
                canonicalRiInstance = null;
                boundHost = null;
            }
        });

        canonicalRiInstance = instance;
        return instance;
    })();

    try {
        return await riCompositionPromise;
    } finally {
        riCompositionPromise = null;
    }
}

function getRuntimeIntegrationComposition() {
    return canonicalRiInstance;
}

function resetRuntimeIntegrationCompositionForTesting() {
    if (canonicalRiInstance) {
        try {
            canonicalRiInstance.cleanup();
        } catch {
            // Ignore cleanup faults
        }
    }
    canonicalRiInstance = null;
    boundHost = null;
    riCompositionPromise = null;
    clearSubscribers();
}

module.exports = {
    ensureRuntimeIntegrationComposed,
    getRuntimeIntegrationComposition,
    resetRuntimeIntegrationCompositionForTesting,
    subscribeEvents,
    broadcastEvent,
    clearSubscribers
};
