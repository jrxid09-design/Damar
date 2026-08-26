"use strict";

const { validateResourceGovernorConfig } = require("./config");
const {
    PRESSURE_BANDS, ADMISSION_OUTCOMES, REASONS,
    HEAVY_CLASSES, WORKLOAD_CLASSES,
    validateDemandShape, createAdmissionDecision, freezeDeep, isFiniteNumber
} = require("./model");
const { workloadIdToString } = require("./ids");
const { createResourceLease, nextLeaseId } = require("./lease");
const { AdmissionQueue } = require("./queue");
const { computePressureBand } = require("./pressure");

const DIAGNOSTIC_CAP = 64;
const RELEASE_TOMBSTONE_CAP = 4096;

function realClock() { return { nowMs: () => Date.now() }; }

class ResourceGovernor {
    constructor({ config, observer, clock } = {}) {
        this.config = validateResourceGovernorConfig(config ?? {});
        if (!observer || typeof observer.observe !== "function") {
            throw new Error("ResourceGovernor requires an injected observer with observe()");
        }
        this._observer = observer;
        this._clock = clock ?? realClock();

        this._leases = new Map();
        this._releasedHandles = [];
        this._activeByGroup = new Map();
        this._activeByClass = new Map();
        this._admittedPerClass = new Map();
        for (const c of WORKLOAD_CLASSES) this._admittedPerClass.set(c, 0);

        this._queue = new AdmissionQueue({
            capacity: this.config.maxQueue,
            aging: this.config.aging
        });

        this._metrics = {
            admitted: 0, released: 0, expired: 0,
            rejected: 0, deferred: 0, queuedCurrent: 0,
            peakConcurrent: 0
        };
        this._history = [];
        this._historySeq = 0;
        this._diagnostics = [];
        this._faulted = null;
    }

    // ---------- observation ----------

    _observe() {
        try {
            const raw = this._observer.observe();
            if (raw === null || typeof raw !== "object") throw new Error("observer returned malformed snapshot");
            const snap = {
                observerHealthy: true,
                totalMemBytes: raw.totalMemBytes,
                freeMemBytes: raw.freeMemBytes,
                rssBytes: raw.rssBytes,
                heapUsedBytes: raw.heapUsedBytes,
                heapLimitBytes: raw.heapLimitBytes,
                externalBytes: raw.externalBytes,
                arrayBuffersBytes: raw.arrayBuffersBytes,
                eventLoopLagMs: raw.eventLoopLagMs,
                timestampMs: this._clock.nowMs()
            };
            const { band, contributions } = computePressureBand({ snapshot: snap, config: this.config });
            snap.pressureBand = band;
            snap.contributions = contributions;
            return snap;
        } catch (err) {
            this._diagnostic(`observer failure: ${err && err.message}`);
            return {
                observerHealthy: false, pressureBand: PRESSURE_BANDS.UNKNOWN,
                contributions: {}, timestampMs: this._clock.nowMs()
            };
        }
    }

    _diagnostic(message) {
        this._diagnostics.push({ seq: ++this._historySeq, ts: this._clock.nowMs(), message });
        if (this._diagnostics.length > DIAGNOSTIC_CAP) this._diagnostics.shift();
    }

    // ---------- validation helpers ----------

    _validateInput(workloadId, demandSpec) {
        let idValue;
        try {
            idValue = workloadIdToString(workloadId);
        } catch (err) {
            return { error: this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.INVALID_WORKLOAD_ID, String(workloadId?.value ?? "?")) };
        }
        const cls = demandSpec && typeof demandSpec === "object" ? demandSpec.workloadClass : undefined;
        if (!WORKLOAD_CLASSES.includes(cls)) {
            return { error: this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.INVALID_DEMAND, idValue) };
        }
        let demand;
        try {
            const shape = validateDemandShape(
                { ...demandSpec },
                this.config.demandMaxima
            );
            demand = freezeDeep({ ...shape, workloadClass: cls });
        } catch (err) {
            return { error: this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.INVALID_DEMAND, idValue) };
        }
        if (!Object.prototype.hasOwnProperty.call(this.config.groupLimits, demand.concurrencyGroup)) {
            return { error: this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.UNKNOWN_GROUP, idValue) };
        }
        return { idValue, demand: freezeDeep(demand) };
    }

    _isHeavy(demand) {
        if (HEAVY_CLASSES.includes(demand.workloadClass)) return true;
        const t = this.config.heavyDemand;
        return demand.memoryBytesHint >= t.memoryBytes ||
            demand.cpuWeight >= t.cpuWeight ||
            demand.expectedDurationMs >= t.durationMs;
    }

    _count(map, key) { return map.get(key) ?? 0; }

    _activeTotalSafe() {
        let t = 0;
        for (const v of this._activeByGroup.values()) t += v;
        return t;
    }

    _checkInvariants(context) {
        const total = this._activeTotalSafe();
        if (total > this.config.globalConcurrencyLimit) {
            this._fault(`global concurrency invariant violated (${context})`);
            return false;
        }
        for (const [g, n] of this._activeByGroup) {
            if (n > this.config.groupLimits[g]) {
                this._fault(`group ${g} concurrency invariant violated (${context})`);
                return false;
            }
        }
        if (this._metrics.queuedCurrent !== this._queue.size) {
            this._fault(`queue accounting inconsistent (${context})`);
            return false;
        }
        return true;
    }

    _fault(message) {
        this._faulted = message;
        this._diagnostic(`INTERNAL_FAULT: ${message} — governor failed closed`);
    }

    // ---------- decisions ----------

    _decision(outcome, reason, workloadIdValue, extra = {}) {
        return createAdmissionDecision({
            outcome, reason, workloadId: workloadIdValue,
            lease: extra.lease ?? null,
            queuePosition: extra.queuePosition ?? null
        });
    }

    _record(workloadIdValue, demand, decision, note) {
        this._history.push({
            seq: ++this._historySeq,
            ts: this._clock.nowMs(),
            workloadId: workloadIdValue,
            workloadClass: demand ? demand.workloadClass : null,
            group: demand ? demand.concurrencyGroup : null,
            outcome: decision.outcome,
            reason: decision.reason,
            note: note ?? null
        });
        if (this._history.length > this.config.historyCapacity) this._history.shift();
    }

    _tryEnqueue(idValue, demand, limitReason, snapshot) {
        if (this._queue.isFull) {
            const d = this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.QUEUE_FULL, idValue);
            this._metrics.rejected++;
            this._record(idValue, demand, d, limitReason);
            return d;
        }
        const entry = this._queue.enqueue({
            workloadId: idValue,
            demand,
            basePriority: demand.priority,
            enqueuedAt: this._clock.nowMs()
        });
        this._metrics.queuedCurrent = this._queue.size;
        const d = this._decision(ADMISSION_OUTCOMES.QUEUE, REASONS.OK_QUEUED, idValue, {
            queuePosition: this._queue.entries(snapshot.timestampMs).indexOf(entry) + 1
        });
        this._record(idValue, demand, d, limitReason);
        return d;
    }

    _grant(idValue, demand, snapshot) {
        const now = this._clock.nowMs();
        const lease = createResourceLease({
            leaseId: nextLeaseId(this._clock),
            workloadId: idValue,
            workloadClass: demand.workloadClass,
            group: demand.concurrencyGroup,
            admittedAt: now,
            expiresAt: now + this.config.leaseTtlMs,
            reservedDemand: {
                cpuWeight: demand.cpuWeight,
                memoryBytesHint: demand.memoryBytesHint,
                ioWeight: demand.ioWeight,
                networkWeight: demand.networkWeight,
                expectedDurationMs: demand.expectedDurationMs,
                preemptible: demand.preemptible
            },
            generation: 1
        });
        this._leases.set(lease.leaseId, {
            handle: lease,
            workloadId: idValue,
            workloadClass: demand.workloadClass,
            group: demand.concurrencyGroup,
            admittedAt: now,
            expiresAt: lease.expiresAt,
            lastSeenAt: now,
            released: false
        });
        this._bump(this._activeByGroup, demand.concurrencyGroup, +1);
        this._bump(this._activeByClass, demand.workloadClass, +1);
        this._admittedPerClass.set(demand.workloadClass, this._admittedPerClass.get(demand.workloadClass) + 1);
        this._metrics.admitted++;
        this._metrics.peakConcurrent = Math.max(this._metrics.peakConcurrent, this._activeTotalSafe());
        const d = this._decision(ADMISSION_OUTCOMES.ADMIT, REASONS.OK_ADMITTED, idValue, { lease });
        this._record(idValue, demand, d, null);
        return d;
    }

    _bump(map, key, delta) {
        map.set(key, this._count(map, key) + delta);
        if (map.get(key) <= 0) map.delete(key);
    }

    _pressureVerdict(demand, snapshot) {
        const band = snapshot.pressureBand;
        const heavy = this._isHeavy(demand);
        if (!snapshot.observerHealthy) {
            return heavy ? { defer: REASONS.DEFERRED_OBSERVER_UNAVAILABLE } : null;
        }
        if (band === PRESSURE_BANDS.CRITICAL) {
            return heavy ? { queue: REASONS.PRESSURE_CRITICAL_HEAVY } : null;
        }
        if (heavy) {
            if (demand.workloadClass === "BACKGROUND" &&
                (band === PRESSURE_BANDS.ELEVATED || band === PRESSURE_BANDS.HIGH)) {
                return { queue: REASONS.DEFERRED_BACKGROUND_UNDER_PRESSURE };
            }
            if (band === PRESSURE_BANDS.HIGH) {
                const lag = snapshot.contributions?.lagBand;
                if (lag === PRESSURE_BANDS.HIGH || lag === PRESSURE_BANDS.CRITICAL) {
                    return { defer: REASONS.DEFERRED_EVENT_LOOP_SEVERE };
                }
                return { defer: REASONS.DEFERRED_PRESSURE_HIGH };
            }
        }
        return null;
    }

    _hasSlotFor(demand) {
        if (this._activeTotalSafe() >= this.config.globalConcurrencyLimit) return false;
        if (this._count(this._activeByGroup, demand.concurrencyGroup) >= this.config.groupLimits[demand.concurrencyGroup]) return false;
        const clsLimit = this.config.classConcurrencyLimits[demand.workloadClass];
        if (clsLimit !== undefined && this._count(this._activeByClass, demand.workloadClass) >= clsLimit) return false;
        return true;
    }

    // ---------- public API ----------

    admit(workloadId, demandSpec) {
        if (this._faulted) {
            const d = this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.INTERNAL_FAULT, "?");
            return d;
        }
        const { error, idValue, demand } = this._validateInput(workloadId, demandSpec);
        if (error) { this._metrics.rejected++; return error; }

        const now = this._clock.nowMs();
        this.reclaimExpired(now);

        const snapshot = this._observe();

        const hostFree = isFiniteNumber(snapshot.freeMemBytes) ? snapshot.freeMemBytes : Infinity;
        if (this._isHeavy(demand) && hostFree <= this.config.memoryThresholds.hostHardFloorBytes) {
            const d = this._decision(ADMISSION_OUTCOMES.REJECT_RESOURCE_LIMIT, REASONS.MEMORY_HARD_CEILING, idValue);
            this._metrics.rejected++;
            this._record(idValue, demand, d, null);
            this._checkInvariants("admit(memory-ceiling)");
            return d;
        }

        const verdict = this._pressureVerdict(demand, snapshot);
        if (verdict !== null) {
            let d;
            if (verdict.defer !== undefined) {
                d = this._decision(ADMISSION_OUTCOMES.DEFER, verdict.defer, idValue);
                this._metrics.deferred++;
                this._record(idValue, demand, d, null);
            } else {
                d = this._tryEnqueue(idValue, demand, verdict.queue, snapshot);
            }
            this._checkInvariants("admit(pressure)");
            return d;
        }

        if (!this._hasSlotFor(demand)) {
            const limitReason =
                this._activeTotalSafe() >= this.config.globalConcurrencyLimit ? REASONS.LIMIT_GLOBAL_CONCURRENCY :
                    this._count(this._activeByGroup, demand.concurrencyGroup) >= this.config.groupLimits[demand.concurrencyGroup] ?
                        REASONS.LIMIT_GROUP_CONCURRENCY : REASONS.LIMIT_CLASS_CONCURRENCY;
            const d = this._tryEnqueue(idValue, demand, limitReason, snapshot);
            this._checkInvariants("admit(slots)");
            return d;
        }

        const d = this._grant(idValue, demand, snapshot);
        this._checkInvariants("admit(grant)");
        return d;
    }

    _authenticate(lease) {
        if (lease === null || typeof lease !== "object") {
            throw new Error("UNKNOWN_LEASE: not a lease object");
        }
        if (typeof lease.leaseId !== "string" || lease.kind !== "ResourceLease") {
            throw new Error("UNKNOWN_LEASE: malformed lease");
        }
        const record = this._leases.get(lease.leaseId);
        if (!record || record.handle !== lease) {
            throw new Error(`UNKNOWN_LEASE: ${lease.leaseId} is not an authentic live lease`);
        }
        return record;
    }

    release(lease) {
        if (this._releasedHandles.some(h => h === lease)) {
            return freezeDeep({ released: false, alreadyReleased: true, leaseId: lease.leaseId });
        }
        const record = this._authenticate(lease);
        record.released = true;
        this._leases.delete(record.handle.leaseId);
        this._rememberReleasedHandle(record.handle);
        this._bump(this._activeByGroup, record.group, -1);
        this._bump(this._activeByClass, record.workloadClass, -1);
        this._metrics.released++;
        this.promoteQueued(this._clock.nowMs());
        this._checkInvariants("release");
        return freezeDeep({ released: true, alreadyReleased: false, leaseId: record.handle.leaseId });
    }

    _rememberReleasedHandle(handle) {
        this._releasedHandles.push(handle);
        if (this._releasedHandles.length > RELEASE_TOMBSTONE_CAP) this._releasedHandles.shift();
    }

    renew(lease) {
        const record = this._authenticate(lease);
        const now = this._clock.nowMs();
        const renewed = createResourceLease({
            leaseId: nextLeaseId(this._clock),
            workloadId: record.workloadId,
            workloadClass: record.workloadClass,
            group: record.group,
            admittedAt: record.admittedAt,
            expiresAt: now + this.config.leaseTtlMs,
            reservedDemand: record.handle.reservedDemand,
            generation: record.handle.generation + 1
        });
        this._leases.delete(record.handle.leaseId);
        this._rememberReleasedHandle(record.handle);
        const newRecord = { ...record, handle: renewed, expiresAt: renewed.expiresAt, lastSeenAt: now };
        this._leases.set(renewed.leaseId, newRecord);
        this._checkInvariants("renew");
        return renewed;
    }

    account(lease) {
        const record = this._authenticate(lease);
        const now = this._clock.nowMs();
        record.lastSeenAt = now;
        return freezeDeep({
            leaseId: lease.leaseId,
            workloadId: record.workloadId,
            heldMs: Math.max(0, now - record.admittedAt),
            ttlRemainingMs: Math.max(0, record.expiresAt - now)
        });
    }

    reclaimExpired(nowMs = this._clock.nowMs()) {
        const expired = [];
        for (const [id, record] of this._leases) {
            if (record.expiresAt <= nowMs) expired.push([id, record]);
        }
        for (const [id, record] of expired) {
            this._leases.delete(id);
            this._rememberReleasedHandle(record.handle);
            this._bump(this._activeByGroup, record.group, -1);
            this._bump(this._activeByClass, record.workloadClass, -1);
            this._metrics.expired++;
        }
        if (expired.length > 0) this.promoteQueued(nowMs);
        return expired.length;
    }

    promoteQueued(nowMs = this._clock.nowMs()) {
        let promoted = 0;
        let progressed = true;
        while (progressed && this._queue.size > 0) {
            progressed = false;
            const ordered = this._queue.entries(nowMs);
            for (const entry of ordered) {
                const snapshot = this._observe();
                if (this._pressureVerdict(entry.demand, snapshot) !== null) continue;
                if (!this._hasSlotFor(entry.demand)) continue;
                this._queue.removeByWorkloadId(entry.workloadId);
                this._metrics.queuedCurrent = this._queue.size;
                this._grant(entry.workloadId, entry.demand, snapshot);
                promoted++;
                progressed = true;
                break;
            }
        }
        if (promoted > 0) this._checkInvariants("promote");
        return promoted;
    }

    recommendations(nowMs = this._clock.nowMs()) {
        const snapshot = this._observe();
        const band = snapshot.pressureBand;
        const out = [];
        const push = (type, detail) => out.push(freezeDeep({ type, detail, atMs: nowMs }));
        if (this._activeTotalSafe() > 0 &&
            (band === PRESSURE_BANDS.HIGH || band === PRESSURE_BANDS.CRITICAL)) {
            push("REDUCE_CONCURRENCY", { band });
        }
        if ((band === PRESSURE_BANDS.ELEVATED || band === PRESSURE_BANDS.HIGH || band === PRESSURE_BANDS.CRITICAL) &&
            this._count(this._activeByClass, "BACKGROUND") > 0) {
            push("PAUSE_BACKGROUND", { backgroundActive: this._count(this._activeByClass, "BACKGROUND") });
        }
        if (snapshot.observerHealthy) {
            const idleThresholdMs = Math.floor(this.config.leaseTtlMs / 2);
            let idleCount = 0;
            let preemptibleCount = 0;
            for (const record of this._leases.values()) {
                if (nowMs - record.lastSeenAt >= idleThresholdMs) idleCount++;
                const preemptible = record.handle.reservedDemand?.preemptible === true ||
                    (record.workloadClass !== "INTERACTIVE" && record.workloadClass !== "VOICE");
                if (preemptible) preemptibleCount++;
            }
            if (idleCount > 0 && (band === PRESSURE_BANDS.HIGH || band === PRESSURE_BANDS.CRITICAL)) {
                push("RELEASE_IDLE_LEASES", { idleCount });
            }
            if (preemptibleCount > 0 && band === PRESSURE_BANDS.CRITICAL) {
                push("CANCEL_PREEMPTIBLE", { candidateCount: preemptibleCount });
            }
        }
        return Object.freeze(out);
    }

    getResourceStatus() {
        const snapshot = this._observe();
        const perGroup = {};
        for (const [g] of Object.entries(this.config.groupLimits)) perGroup[g] = this._count(this._activeByGroup, g);
        const perClass = {};
        for (const c of WORKLOAD_CLASSES) {
            const active = this._count(this._activeByClass, c);
            const admittedLifetime = this._admittedPerClass.get(c);
            if (active > 0 || admittedLifetime > 0) perClass[c] = { active, admittedLifetime };
        }
        return freezeDeep({
            pressureBand: snapshot.pressureBand,
            observerHealthy: snapshot.observerHealthy,
            faulted: this._faulted ? { reason: this._faulted } : null,
            activeLeases: this._activeTotalSafe(),
            queueDepth: this._queue.size,
            limits: {
                global: this.config.globalConcurrencyLimit,
                groups: { ...this.config.groupLimits },
                classes: { ...this.config.classConcurrencyLimits },
                maxQueue: this.config.maxQueue
            },
            perGroup,
            perClass,
            metrics: { ...this._metrics },
            diagnostics: Object.freeze(this._diagnostics.slice(-16).map(d => ({ seq: d.seq, ts: d.ts, message: d.message }))),
            recentDecisions: Object.freeze(this._history.slice(-16).map(h => ({
                seq: h.seq, ts: h.ts, workloadId: h.workloadId,
                workloadClass: h.workloadClass, outcome: h.outcome, reason: h.reason
            }))),
            observed: freezeDeep({
                totalMemBytes: snapshot.totalMemBytes ?? null,
                freeMemBytes: snapshot.freeMemBytes ?? null,
                rssBytes: snapshot.rssBytes ?? null,
                heapUsedBytes: snapshot.heapUsedBytes ?? null,
                externalBytes: snapshot.externalBytes ?? null,
                arrayBuffersBytes: snapshot.arrayBuffersBytes ?? null,
                eventLoopLagMs: snapshot.eventLoopLagMs ?? null
            })
        });
    }

    queueEntries(nowMs = this._clock.nowMs()) {
        return this._queue.entries(nowMs).map(e => ({
            seq: e.seq, workloadId: e.workloadId, workloadClass: e.demand.workloadClass,
            basePriority: e.basePriority, effectivePriority: this._queue.effectivePriority(e, nowMs)
        }));
    }

    get isFaulted() { return Boolean(this._faulted); }
}

function createResourceGovernor(options) {
    return new ResourceGovernor(options);
}

module.exports = { ResourceGovernor, createResourceGovernor };
