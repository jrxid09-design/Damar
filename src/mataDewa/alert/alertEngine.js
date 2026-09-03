/**
 * Alert Engine — mode ALERT: notifikasi proaktif BERBASIS BUKTI.
 *
 * Setiap alert membawa: what / where / when / freshness / confidence /
 * severity / sources+evidence refs / affected asset+route bila diketahui.
 * Hukum: TIDAK ADA klaim "live" dari observasi basi — kesegaran jujur.
 */

const { SEVERITY, severityAtLeast } = require("../events/event");
const { EPISTEMIC_STATUS } = require("../spatial/epistemic");

const DELIVERY_STATE = Object.freeze({
    PENDING: "pending",
    DELIVERED: "delivered",
    DROPPED: "dropped"
});

class AlertEngine {

    /**
     * @param {{
     *   clock?: { nowMs(): number },
     *   maxQueue?: number,
     *   minSeverity?: string,
     *   deliver?: (alert) => Promise<void>   // kanal Damar (Manager/notification)
     * }} options
     */
    constructor({ clock = { nowMs: () => Date.now() }, maxQueue = 200, minSeverity = SEVERITY.WATCH, deliver = null } = {}) {
        this.clock = clock;
        this.maxQueue = maxQueue;
        this.minSeverity = minSeverity;
        this.deliver = typeof deliver === "function" ? deliver : null;
        /** @type {object[]} antrean alert (bounded) */
        this.queue = [];
        this.counts = { raised: 0, delivered: 0, dropped: 0, suppressed: 0 };
    }

    /**
     * Angkat alert dari event + konteks. Memvalidasi kelengkapan bukti.
     * Mengembalikan { ok, alert?, reason? }.
     */
    raise({ event, assetId = null, routeId = null, riskState = null }) {
        if (!event) return { ok: false, reason: "event wajib" };

        if (!severityAtLeast(event.severity, this.minSeverity)) {
            this.counts.suppressed += 1;
            return { ok: false, reason: `di bawah ambang severity (${event.severity} < ${this.minSeverity})` };
        }

        // Bukti wajib: minimal satu sumber + satu evidence ref.
        const sources = Array.isArray(event.sources) ? event.sources : [];
        const evidence = Array.isArray(event.evidence) ? event.evidence : [];
        if (sources.length === 0 || evidence.length === 0) {
            return { ok: false, reason: "alert tanpa sumber/evidence ditolak (harus berbasis bukti)" };
        }

        // Klarifikasi epistemik: PREDICTED tidak boleh dilabel OBSERVED, dan
        // event basi tidak boleh diklaim live.
        const isPredicted = event.epistemic === EPISTEMIC_STATUS.PREDICTED;
        const nowMs = this.clock.nowMs();
        const ageMs = Number.isFinite(event.lastObservedAt) ? Math.max(0, nowMs - event.lastObservedAt) : Infinity;

        const alert = {
            id: `alert_${event.id}`,
            what: `${event.type} (severity ${event.severity}${isPredicted ? ", predicted" : ""})`,
            where: event.location,
            radiusM: event.radiusM,
            when: {
                firstObservedAt: event.firstObservedAt,
                lastObservedAt: event.lastObservedAt,
                ageMs: Number.isFinite(ageMs) ? Math.round(ageMs) : null,
                // klaim kesegaran jujur:
                live: Number.isFinite(ageMs) && ageMs <= 5 * 60 * 1000 && !isPredicted
            },
            freshness: { ageMs, epistemic: event.epistemic },
            confidence: event.confidence,
            severity: event.severity,
            sources,
            evidenceRefs: evidence.map(e => e.observationId ?? e.attribution ?? "unknown").slice(0, 20),
            assetId,
            routeId,
            riskState,
            recommendedContext: event.recommendedContext ?? null,
            raisedAt: nowMs
        };

        this.queue.unshift(alert);
        if (this.queue.length > this.maxQueue) this.queue.pop();
        this.counts.raised += 1;

        // Pengiriman lewat kanal Damar opsional — kegagalan delivery tidak
        // menjatuhkan engine; alert tetap tercatat di antrean.
        if (this.deliver) {
            this.deliver(alert)
                .then(() => { this.counts.delivered += 1; alert.delivery = DELIVERY_STATE.DELIVERED; })
                .catch(() => { this.counts.dropped += 1; alert.delivery = DELIVERY_STATE.DROPPED; });
        } else {
            alert.delivery = DELIVERY_STATE.PENDING;
        }

        return { ok: true, alert };
    }

    list({ minSeverity = null, limit = 50 } = {}) {
        return this.queue
            .filter(a => !minSeverity || severityAtLeast(a.severity, minSeverity))
            .slice(0, limit);
    }

    get stats() {
        return {
            ...this.counts,
            queueSize: this.queue.length,
            minSeverity: this.minSeverity
        };
    }
}

module.exports = { AlertEngine, DELIVERY_STATE };
