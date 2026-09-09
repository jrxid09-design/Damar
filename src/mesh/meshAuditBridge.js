"use strict";

/**
 * WAVE 6 MESH — audit bridge (L1).
 *
 * Mesh events append to the FROZEN Audit Ledger via its sink port, with
 * node provenance fields (node, trustGeneration, causal link). The bridge
 * NEVER mutates ledger semantics and NEVER blocks mesh ingress (best-effort,
 * bounded queue with drop-oldest telemetry policy for audit records).
 */

const { canonicalJson } = require("./canonical");

const DEFAULTS = Object.freeze({ maxBuffer: 512 });

class MeshAuditBridge {
    /**
     * @param {object} deps
     * @param {object} deps.ledger frozen Audit Ledger instance exposing append(record)
     * @param {string} deps.localNodeId
     */
    constructor({ ledger, localNodeId, config = {} } = {}) {
        if (!ledger || typeof ledger.append !== "function") throw new TypeError("MeshAuditBridge requires an audit ledger with append()");
        this.ledger = ledger;
        this.localNodeId = String(localNodeId).slice(0, 128);
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this._buffer = []; // bounded drop-oldest buffer when the ledger is not attached
        this._attached = true;
        this._dropped = 0;
    }

    _record(type, data) {
        return {
            type: `mesh.${type}`,
            node: this.localNodeId,
            at: new Date().toISOString(),
            data
        };
    }

    _append(record) {
        if (this._attached) {
            try {
                this.ledger.append(record);
                return true;
            } catch {
                this._attached = false; // fail soft to buffer; audit never blocks mesh ingress
            }
        }
        if (this._buffer.length >= this.config.maxBuffer) {
            this._buffer.shift(); // drop-oldest (bounded)
            this._dropped++;
        }
        this._buffer.push(record);
        return false;
    }

    ingestAccepted(envelope, { transportPeer = null, receivedAtMs = null } = {}) {
        return this._append(this._record("ingest_accepted", {
            messageId: envelope.messageId,
            messageType: envelope.messageType,
            sourceNodeId: envelope.sourceNodeId,
            destinationNodeId: envelope.destinationNodeId,
            trustGeneration: envelope.trustGeneration,
            payloadDigest: envelope.payloadDigest,
            transportPeer: transportPeer ? String(transportPeer).slice(0, 128) : null,
            receivedAtMs: receivedAtMs ?? null
        }));
    }

    ingestRejected(code, detail) {
        return this._append(this._record("ingest_rejected", {
            code: String(code).slice(0, 64),
            detail: String(detail ?? "").slice(0, 300)
        }));
    }

    trustChanged({ nodeId, from, to, trustGeneration, reason = null }) {
        return this._append(this._record("trust_changed", {
            nodeId: String(nodeId).slice(0, 128),
            from: String(from).slice(0, 32),
            to: String(to).slice(0, 32),
            trustGeneration: String(trustGeneration).slice(0, 128),
            reason: reason ? String(reason).slice(0, 300) : null
        }));
    }

    pairingEvent({ event, nodeId, deviceId = null, pairingTxId = null }) {
        return this._append(this._record("pairing", {
            event: String(event).slice(0, 64),
            nodeId: nodeId ? String(nodeId).slice(0, 128) : null,
            deviceId: deviceId ? String(deviceId).slice(0, 128) : null,
            pairingTxId: pairingTxId ? String(pairingTxId).slice(0, 128) : null
        }));
    }

    /** Deterministic digest of the buffered records (tamper-evidence aid). */
    bufferedDigest() {
        return require("node:crypto").createHash("sha256").update(canonicalJson(this._buffer)).digest("hex");
    }

    stats() {
        return Object.freeze({
            attached: this._attached,
            buffered: this._buffer.length,
            dropped: this._dropped
        });
    }
}

module.exports = Object.freeze({ MeshAuditBridge, DEFAULTS });
