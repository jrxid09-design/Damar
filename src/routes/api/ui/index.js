"use strict";

const express = require("express");
const { ensureRuntimeIntegrationComposed, getRuntimeIntegrationComposition } = require("../../../integration/riProductionComposition");
const { manager: channelManager } = require("../../../channels");

const { tokenGuard } = require("../../../core/auth/tokenCompare");

const router = express.Router();

// Fail-closed W4 transport authentication boundary for all RI routes
router.use(tokenGuard({ roleWhenAuthenticated: "user", surface: "ui" }));

async function getComposition() {
    let comp = getRuntimeIntegrationComposition();
    if (!comp) {
        comp = await ensureRuntimeIntegrationComposed();
    }
    return comp;
}

// ---------------------------------------------------------------------------
// 1. COMMAND SEAM (W4 CommandClient -> /api/ui/commands)
// ---------------------------------------------------------------------------

router.post("/commands", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const { kind, operation, target, payload = {}, idempotencyKey = null } = req.body || {};

        if (!kind || typeof kind !== "string") {
            return res.status(400).json({ error: "kind must be a non-empty string" });
        }
        if (!operation || typeof operation !== "string") {
            return res.status(400).json({ error: "operation must be a non-empty string" });
        }

        // B2: Approval decisions
        if (kind === "APPROVAL_DECISION" || operation === "approval.decide") {
            const approvalId = target?.approval_id || target?.approvalId || payload?.approvalId;
            if (!approvalId || typeof approvalId !== "string") {
                return res.status(400).json({ error: "target.approval_id required for approval decision" });
            }

            const decision = payload.decision;
            if (decision !== "APPROVE" && decision !== "DENY") {
                return res.status(400).json({ error: "payload.decision must be APPROVE or DENY" });
            }

            try {
                const result = await comp.decideApproval({
                    approvalId,
                    decision,
                    reason: payload.reason ?? null,
                    expectedRevision: payload.expectedRevision ?? null,
                    actor: payload.actor ?? "web_surface",
                    authenticationEvidence: payload.authenticationEvidence ?? null,
                    confirmationProof: payload.confirmationProof ?? null,
                    idempotencyKey
                });

                return res.json({
                    accepted: true,
                    operation: "approval.decide",
                    data: result
                });
            } catch (err) {
                const code = err.code || "APPROVAL_ERROR";
                const status = code === "UNKNOWN_APPROVAL" ? 404 :
                               (code === "STALE_REVISION" || code === "ALREADY_RESOLVED") ? 409 : 400;
                return res.status(status).json({
                    error: err.message,
                    code,
                    detail: err.detail ?? null
                });
            }
        }

        // B4: Notification dismissal
        if (kind === "NONCONSEQUENTIAL_COMMAND" && (operation === "notification.dismiss" || operation === "notification.acknowledge" || operation === "notification.read")) {
            const notificationId = target?.notification_id || target?.notificationId || payload?.notificationId;
            if (!notificationId || typeof notificationId !== "string") {
                return res.status(400).json({ error: "target.notification_id required" });
            }

            try {
                let rec;
                if (operation === "notification.dismiss") {
                    rec = await comp.notification.dismiss(notificationId);
                } else if (operation === "notification.acknowledge") {
                    rec = await comp.notification.acknowledge(notificationId);
                } else {
                    rec = await comp.notification.markRead(notificationId);
                }
                return res.json({
                    accepted: true,
                    operation,
                    data: rec
                });
            } catch (err) {
                const status = err.code === "UNKNOWN_NOTIFICATION" ? 404 : 400;
                return res.status(status).json({
                    error: err.message,
                    code: err.code || "NOTIFICATION_ERROR"
                });
            }
        }

        // B1: Conversation message command
        if (kind === "CONSEQUENTIAL_COMMAND" && operation === "conversation.send") {
            const text = payload.text;
            if (typeof text !== "string") {
                return res.status(400).json({ error: "payload.text must be a string" });
            }
            const channel = payload.channel || "console";
            if (!comp.host) {
                return res.status(503).json({ error: "RuntimeHost not composed" });
            }

            const reqPayload = { text };
            if (payload.authProof && typeof payload.authProof === "object") {
                const { kind, credentialId, nonce, signature } = payload.authProof;
                reqPayload.authProof = { kind, credentialId, nonce, signature };
            }

            const result = await comp.host.channels.request(channel, reqPayload);
            return res.json({
                accepted: true,
                operation: "conversation.send",
                data: result
            });
        }

        return res.status(400).json({ error: `unsupported command kind: ${kind} operation: ${operation}` });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// 2. APPROVAL READ SEAM
// ---------------------------------------------------------------------------

router.get("/approvals", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const { state, limit, cursor } = req.query;
        const pageResult = await comp.approval.page({
            state: state ? String(state) : null,
            limit: limit ? Number(limit) : undefined,
            cursor: cursor ? String(cursor) : null
        });
        res.json({
            data: pageResult.items,
            nextCursor: pageResult.nextCursor
        });
    } catch (err) {
        next(err);
    }
});

router.get("/approvals/:id", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const record = await comp.approval.get(req.params.id);
        if (!record) {
            return res.status(404).json({ error: `Approval '${req.params.id}' not found` });
        }
        res.json({ data: record });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// 3. MISSION READ SEAM (Canonical Mission Intelligence)
// ---------------------------------------------------------------------------

router.get("/missions", async (req, res, next) => {
    try {
        const comp = await getComposition();
        // Canonical missions are indexed in m:idx:missions via makeMissionStore
        const missionIds = (await comp.acc.getKv("mission:idx:missions")) || [];
        const items = [];
        for (const id of missionIds) {
            const m = await comp.mission.get(id);
            if (m) items.push(m);
        }
        res.json({ data: items });
    } catch (err) {
        next(err);
    }
});

router.get("/missions/:id", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const mission = await comp.mission.get(req.params.id);
        if (!mission) {
            return res.status(404).json({ error: `Mission '${req.params.id}' not found` });
        }
        res.json({ data: mission });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// 4. NOTIFICATION READ / MUTATION SEAM
// ---------------------------------------------------------------------------

router.get("/notifications", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const { state, sourceType, limit, cursor } = req.query;
        const pageResult = await comp.notification.page({
            state: state ? String(state) : null,
            sourceType: sourceType ? String(sourceType) : null,
            limit: limit ? Number(limit) : undefined,
            cursor: cursor ? String(cursor) : null
        });
        res.json({
            data: pageResult.items,
            nextCursor: pageResult.nextCursor
        });
    } catch (err) {
        next(err);
    }
});

router.get("/notifications/:id", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const record = await comp.notification.get(req.params.id);
        if (!record) {
            return res.status(404).json({ error: `Notification '${req.params.id}' not found` });
        }
        res.json({ data: record });
    } catch (err) {
        next(err);
    }
});

router.post("/notifications/:id/dismiss", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const record = await comp.notification.dismiss(req.params.id);
        res.json({
            accepted: true,
            data: record
        });
    } catch (err) {
        const status = err.code === "UNKNOWN_NOTIFICATION" ? 404 : 400;
        res.status(status).json({
            error: err.message,
            code: err.code || "NOTIFICATION_ERROR"
        });
    }
});

// ---------------------------------------------------------------------------
// 5. CONVERSATION SEAM (RI-B1)
// ---------------------------------------------------------------------------

router.get("/conversations/:id", async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!id || typeof id !== "string" || !id.startsWith("dsc_")) {
            return res.status(400).json({ error: "Invalid conversation session ID: must start with dsc_" });
        }
        const turns = await channelManager.continuityHistory(id);
        res.json({
            data: {
                sessionId: id,
                turns: turns || []
            }
        });
    } catch (err) {
        next(err);
    }
});

router.post("/conversations/messages", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const { text, channel = "console", authProof } = req.body || {};
        if (typeof text !== "string") {
            return res.status(400).json({ error: "text must be a string" });
        }
        if (!comp.host) {
            return res.status(503).json({ error: "RuntimeHost not composed" });
        }
        const reqPayload = { text };
        if (authProof && typeof authProof === "object") {
            const { kind, credentialId, nonce, signature } = authProof;
            reqPayload.authProof = { kind, credentialId, nonce, signature };
        }

        const result = await comp.host.channels.request(channel, reqPayload);
        res.json({ data: result });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// 6. PRESENCE / RUNTIME STATUS PROJECTION SEAM
// ---------------------------------------------------------------------------

router.get("/presence/state", async (req, res, next) => {
    try {
        const comp = await getComposition();
        if (comp.host) {
            return res.json({
                data: {
                    status: comp.host.status(),
                    health: comp.host.health()
                }
            });
        }
        res.json({
            data: {
                phase: "READY",
                healthy: true
            }
        });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// 6B. CYBER POSTURE SEAM (DCD read projection)
// ---------------------------------------------------------------------------
// Read-only projection of the single composed detection engine (comp.cyber)
// plus its security_incident notification records, for the desktop Core's
// Cyber binding (GET /api/r9/cyber there). No mutation route exists here by
// design: incident intake stays with the composition's own bridges
// (recordDcdIncident / transitionDcdIncident) and every cyber action stays
// behind the Authority Gate as designed.

router.get("/cyber/posture", async (req, res, next) => {
    try {
        const comp = await getComposition();
        const clean = (v, n) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, n) : null);
        const incidents = (typeof comp.cyber?.listIncidents === "function" ? comp.cyber.listIncidents() : []).map(i => ({
            incidentId: clean(i.incidentId, 80),
            state: clean(i.state, 40),
            sourceKind: clean(i.sourceKind, 40),
            riskLevel: clean(i.riskLevel, 20),
            summary: clean(i.summary, 300),
            createdAt: Number.isSafeInteger(i.createdAt) ? i.createdAt : null,
            historyCount: Array.isArray(i.history) ? i.history.length : 0
        })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 32);
        const byState = {};
        for (const i of incidents) byState[i.state || "UNKNOWN"] = (byState[i.state || "UNKNOWN"] || 0) + 1;
        const active = incidents.filter(i => !["RESOLVED", "CLOSED", "DISMISSED"].includes(i.state)).length;
        let notifications = [];
        try {
            const pageResult = await comp.notification.page({ sourceType: "security_incident", limit: 20 });
            notifications = (pageResult.items || []).map(n => ({
                id: clean(n.notification_id || n.id || n.sourceId, 80),
                state: clean(n.state, 40),
                event: clean(n.event, 40),
                severity: clean(n.severity, 20),
                summary: clean(n.summary, 300),
                occurredAt: Number.isSafeInteger(n.occurredAt) ? n.occurredAt : (Number.isSafeInteger(n.createdAt) ? n.createdAt : null)
            }));
        } catch {}
        res.json({
            data: {
                engine: "dcd",
                incidents,
                counts: { total: incidents.length, active, byState },
                notifications,
                generatedAt: Date.now()
            }
        });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// 7. REAL-TIME EVENT STREAM (SSE) SEAM
// ---------------------------------------------------------------------------

router.get("/events", async (req, res) => {
    const comp = await getComposition();

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.write(":connected\n\n");

    const unsubscribe = comp.subscribe((event) => {
        try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
            // Client write failed
        }
    });

    req.on("close", () => {
        unsubscribe();
    });
});

module.exports = router;
