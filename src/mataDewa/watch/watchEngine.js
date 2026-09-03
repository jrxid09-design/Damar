/**
 * Watch Engine — pemantauan persisten headless (mode WATCH).
 *
 * Kebijakan (per aset) menentukan hazard apa yang diawasi dengan ring/radius
 * apa. Mesin melakukan: deduplication, cooldown, freshness, severity,
 * confidence, provider quality, event lifecycle — TANPA spam notifikasi.
 *
 * Inti ini berjalan di daemon walau UI MATA_DEWA tertutup (UI state ≠
 * core monitoring state). Dimiliki Damar; dimulai/dihentikan bersama Damar.
 */

const { SEVERITY, canonicalSeverity, severityAtLeast, describeEventFreshness } = require("../events/event");
const { evaluateLightningRisk, HAZARD_TYPE, buildAssetHazardEvent } = require("./lightning");
const { evaluateRfPresenceRisk, HAZARD_TYPE: RF_HAZARD } = require("./rfPresence");
const { isValidPoint } = require("../spatial/geo");

const EVENT_LIFECYCLE = Object.freeze({
    NEW: "new",
    ACTIVE: "active",
    COOLDOWN: "cooldown",
    RESOLVED: "resolved"
});

const HAZARD_EVALUATORS = {
    [HAZARD_TYPE.LIGHTNING]: evaluateLightningRisk,
    [RF_HAZARD.RF_PRESENCE]: evaluateRfPresenceRisk
};

class WatchEngine {

    /**
     * @param {{
     *   assetRegistry: object,
     *   clock?: { nowMs(): number },
     *   pollIntervalMs?: number,
     *   hazardWindowMs?: number,
     *   onAlert?: (alert: object) => void
     * }} options
     */
    constructor({ assetRegistry, clock = { nowMs: () => Date.now() }, pollIntervalMs = 5 * 60 * 1000, hazardWindowMs = 15 * 60 * 1000, onAlert = null } = {}) {
        if (!assetRegistry) throw new TypeError("WatchEngine butuh assetRegistry");
        this.assetRegistry = assetRegistry;
        this.clock = clock;
        this.pollIntervalMs = pollIntervalMs;
        this.hazardWindowMs = hazardWindowMs;
        this.onAlert = typeof onAlert === "function" ? onAlert : null;

        /** id aset → { lastAlertAtMs, lastSeverity, lastEventId } */
        this.alertState = new Map();
        /** event aktif per aset+hazard (dedup key) */
        this.activeEvents = new Map();
        this.running = false;
        this._timer = null;
        this.lastRunAtMs = null;
        this.lastRunStats = null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        // Interval tidak menahan proses (unref) — kepatuhan lifecycle Damar.
        this._timer = setInterval(() => {
            this.tick().catch(() => { /* kegagalan satu tick tidak mematikan engine */ });
        }, this.pollIntervalMs);
        this._timer.unref?.();
    }

    async stop() {
        this.running = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /** Dedup key: aset + hazard + ring keadaan risiko. */
    _dedupKey(assetId, hazardType) {
        return `${assetId}:${hazardType}`;
    }

    /**
     * Satu putaran evaluasi. Mengambil observasi hazard dari pemantauan
     * (observer dipasok service via fetchObservations), evaluasi per aset,
     * terbitkan alert bila kebijakan lolos.
     *
     * @param {Function} fetchObservations async (hazardType) => observations[]
     */
    async tick(fetchObservations) {
        if (!this.running) return { ran: false, reason: "not_running" };
        const nowMs = this.clock.nowMs();
        this.lastRunAtMs = nowMs;
        const alerts = [];
        const evaluated = { assets: 0, hazards: 0, alerts: 0, suppressed: 0 };

        const hazardsWanted = new Set();
        for (const asset of this.assetRegistry.list()) {
            if (!asset.watchPolicy?.enabled) continue;
            for (const h of asset.watchPolicy.hazardTypes ?? []) hazardsWanted.add(h);
        }

        const observationsByType = new Map();
        if (typeof fetchObservations === "function") {
            for (const hazardType of hazardsWanted) {
                try {
                    observationsByType.set(hazardType, await fetchObservations(hazardType) ?? []);
                }
                catch {
                    observationsByType.set(hazardType, []); // provider gagal → tidak ada data, bukan kegagalan engine
                }
            }
        }

        for (const asset of this.assetRegistry.list()) {
            const policy = asset.watchPolicy;
            if (!policy?.enabled || !isValidPoint(asset.geometry)) continue;
            evaluated.assets += 1;

            for (const hazardType of policy.hazardTypes ?? []) {
                const evaluator = HAZARD_EVALUATORS[hazardType];
                if (!evaluator) continue; // hazard belum punya evaluator jujur → tidak dipura-pura
                const observations = observationsByType.get(hazardType) ?? [];
                evaluated.hazards += 1;
                const evaluation = evaluator(asset, observations, { nowMs, windowMs: this.hazardWindowMs });
                if (!evaluation) continue;

                if (!severityAtLeast(evaluation.severity, canonicalSeverity(policy.minSeverity))) continue;

                const key = this._dedupKey(asset.id, hazardType);
                const state = this.alertState.get(key) ?? { lastAlertAtMs: 0, lastSeverity: null, lastEventId: null };
                const cooldownOk = nowMs - state.lastAlertAtMs >= (policy.cooldownMs ?? 0);
                const severityEscalated = canonicalSeverity(evaluation.severity) !== state.lastSeverity &&
                    severityAtLeast(evaluation.severity, state.lastSeverity ?? SEVERITY.INFO);

                if (!cooldownOk && !severityEscalated) {
                    evaluated.suppressed += 1;
                    continue;
                }

                const event = buildAssetHazardEvent(asset, evaluation, { hazardType, nowMs });
                if (!event) continue;

                this.alertState.set(key, {
                    lastAlertAtMs: nowMs,
                    lastSeverity: evaluation.severity,
                    lastEventId: event.id
                });
                this.activeEvents.set(key, {
                    event,
                    lifecycle: EVENT_LIFECYCLE.ACTIVE,
                    updatedAt: nowMs
                });
                evaluated.alerts += 1;

                const alert = {
                    event,
                    assetId: asset.id,
                    assetType: asset.type,
                    hazardType,
                    riskState: evaluation.riskState,
                    ring: evaluation.ring,
                    nearestStrikeM: evaluation.nearestStrikeM,
                    strikeCount: evaluation.strikeCount,
                    freshness: describeEventFreshness(event, {}, nowMs),
                    stale: evaluation.stale ?? false,
                    at: nowMs
                };
                alerts.push(alert);
                if (this.onAlert) {
                    try { this.onAlert(alert); } catch { /* konsumen gagal ≠ engine gagal */ }
                }
            }
        }

        this.lastRunStats = evaluated;
        return { ran: true, at: nowMs, alerts, stats: evaluated };
    }

    /** Event aktif (belum resolved) untuk UI/Manager. */
    listActiveEvents() {
        return [...this.activeEvents.entries()].map(([key, value]) => ({
            key,
            lifecycle: value.lifecycle,
            updatedAt: value.updatedAt,
            event: value.event
        }));
    }

    resolveEvent(key) {
        const entry = this.activeEvents.get(key);
        if (!entry) return false;
        entry.lifecycle = EVENT_LIFECYCLE.RESOLVED;
        entry.updatedAt = this.clock.nowMs();
        this.activeEvents.delete(key);
        return true;
    }

    get isRunning() { return this.running; }
}

module.exports = { WatchEngine, EVENT_LIFECYCLE, HAZARD_TYPE, RF_HAZARD, HAZARD_EVALUATORS };
