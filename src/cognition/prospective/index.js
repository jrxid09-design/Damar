"use strict";

/**
 * W7-L4 PROSPECTIVE MEMORY AND TEMPORAL COGNITION.
 *
 * ACC subdomain `src/cognition/prospective/**` (`W7_TEMPORAL_COGNITION_SPEC.md`).
 *
 * PROSPECTIVE MEMORY != EXECUTION AUTHORITY. A WakeEvent wakes cognition,
 * never an actuator — records.js's `validatePayloadRef` structurally
 * rejects capabilityId/actuatorRef/authProof/intentTemplate on any payload.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { makeReminder, makeExpectation, makeWakeEvent } = require("./records");
const { loadSnapshot, saveSnapshot } = require("./store");

function occurrenceKey(reminderId, occurrenceIndex) { return `${reminderId}:${occurrenceIndex}`; }

function dueAtMs(reminder) {
    const t = reminder.trigger;
    if (t.kind === "AT") return Date.parse(t.at);
    if (t.kind === "AFTER") return (reminder.armedAtMs ?? 0) + t.delayMs;
    if (t.kind === "RECURRING") {
        const next = (reminder.armedAtMs ?? 0) + t.intervalMs * (reminder.occurrenceIndex + 1);
        if (t.until && next > Date.parse(t.until)) return null;
        if (t.maxOccurrences && reminder.occurrenceIndex + 1 > t.maxOccurrences) return null;
        return next;
    }
    return null; // ON_STATE / ON_EVENT: bukan berbasis waktu
}

async function createProspectiveMemory({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS } = {}) {

    const snapshot = await loadSnapshot(store);
    const reminders = snapshot.reminders;
    const expectations = snapshot.expectations;
    const firedOccurrenceIds = snapshot.firedOccurrenceIds;
    const remindersPerGoal = new Map();
    for (const r of reminders.values()) {
        if (r.ownerRef) remindersPerGoal.set(r.ownerRef, (remindersPerGoal.get(r.ownerRef) ?? 0) + 1);
    }

    let wakeEventsThisMinute = [];
    const deferredWakeEvents = [];

    function now() { return clock.nowMs(); }
    function nowIso() { return new Date(now()).toISOString(); }

    let armedReminderCount = [...reminders.values()].filter(r => r.state === "ARMED").length;

    function arm(spec) {
        if (armedReminderCount >= bounds.MAX_ARMED_REMINDERS) {
            fail(REASONS.PROSPECTIVE_FULL, "jumlah reminder armed melebihi batas");
        }
        if (spec.ownerRef && (remindersPerGoal.get(spec.ownerRef) ?? 0) >= bounds.MAX_REMINDERS_PER_GOAL) {
            fail(REASONS.PER_GOAL_LIMIT_EXCEEDED, "jumlah reminder per goal melebihi batas");
        }
        const reminder = makeReminder({ ...spec, reminderId: spec.reminderId ?? crypto.randomUUID(), nowIso: nowIso() });
        const armed = Object.freeze({ ...reminder, armedAtMs: now() });
        reminders.set(armed.reminderId, armed);
        armedReminderCount += 1;
        if (armed.ownerRef) remindersPerGoal.set(armed.ownerRef, (remindersPerGoal.get(armed.ownerRef) ?? 0) + 1);
        return armed;
    }

    function admitWakeEvent(event) {
        const windowMs = 60_000;
        wakeEventsThisMinute = wakeEventsThisMinute.filter(t => now() - t < windowMs);
        if (wakeEventsThisMinute.length >= bounds.MAX_WAKE_EVENTS_PER_MINUTE) {
            deferredWakeEvents.push(event); // §9: tidak pernah dibuang diam-diam, hanya ditunda+terhitung
            return null;
        }
        wakeEventsThisMinute.push(now());
        return event;
    }

    /** PM-2: penembakan idempoten per occurrence id. */
    function fireReminder(reminder, { missed = false, lateness = 0 } = {}) {
        const occId = occurrenceKey(reminder.reminderId, reminder.occurrenceIndex);
        if (firedOccurrenceIds.has(occId)) return null; // duplikat -> no-op
        firedOccurrenceIds.add(occId);

        const event = makeWakeEvent({
            reminderId: reminder.reminderId, wakeClass: reminder.wakeClass,
            payloadRef: reminder.payloadRef, firedAt: nowIso(),
            occurrenceId: occId, lateness, missed
        });

        const isRecurring = reminder.trigger.kind === "RECURRING";
        const nextIndex = reminder.occurrenceIndex + 1;
        const stillRecurs = isRecurring && dueAtMs({ ...reminder, occurrenceIndex: nextIndex }) !== null;

        reminders.set(reminder.reminderId, Object.freeze({
            ...reminder,
            state: stillRecurs ? "ARMED" : "FIRED",
            occurrenceIndex: nextIndex,
            firedAt: nowIso(), missedAt: missed ? nowIso() : reminder.missedAt
        }));

        return admitWakeEvent(event);
    }

    function retire(reminder, reason) {
        reminders.set(reminder.reminderId, Object.freeze({ ...reminder, state: "RETIRED", retiredReason: reason }));
    }

    /**
     * §5 restart catch-up: dipanggil sekali segera setelah muat snapshot.
     * Paling banyak SATU tembakan catch-up per reminder yang basi, dibatasi
     * MAX_CATCHUP_FIRES_PER_RESTART total; sisanya MISSED_EXPIRED.
     */
    function restartCatchUp() {
        const events = [];
        let catchUpBudget = bounds.MAX_CATCHUP_FIRES_PER_RESTART;
        const nowMs = now();

        for (const reminder of [...reminders.values()]) {
            if (reminder.state !== "ARMED") continue;
            if (!["AT", "AFTER", "RECURRING"].includes(reminder.trigger.kind)) continue;

            const due = dueAtMs(reminder);
            if (due === null || due > nowMs) continue; // belum jatuh tempo, bukan catch-up

            if (catchUpBudget <= 0) {
                retire(reminders.get(reminder.reminderId), "MISSED_EXPIRED");
                continue;
            }
            catchUpBudget -= 1;
            const fired = fireReminder(reminders.get(reminder.reminderId), { missed: true, lateness: nowMs - due });
            if (fired) events.push(fired);
        }
        return events;
    }

    const catchUpEvents = restartCatchUp();

    /** §4 operasi normal: tembak setiap AT/AFTER/RECURRING yang sudah jatuh tempo. */
    function tick(goalStatusPort = null) {
        const events = [];
        const nowMs = now();
        for (const reminder of [...reminders.values()]) {
            if (reminder.state !== "ARMED") continue;
            if (!["AT", "AFTER", "RECURRING"].includes(reminder.trigger.kind)) continue;

            // PM-3: goal terminal -> pensiun, tidak pernah ditembak.
            if (reminder.ownerRef && goalStatusPort?.isTerminal?.(reminder.ownerRef)) {
                retire(reminders.get(reminder.reminderId), "GOAL_TERMINAL");
                continue;
            }

            const due = dueAtMs(reminder);
            if (due === null || due > nowMs) continue;
            const fired = fireReminder(reminders.get(reminder.reminderId), { missed: false, lateness: 0 });
            if (fired) events.push(fired);
        }
        return events;
    }

    function checkOnStateReminders(evaluatePort) {
        const events = [];
        for (const reminder of [...reminders.values()]) {
            if (reminder.state !== "ARMED" || reminder.trigger.kind !== "ON_STATE") continue;
            const satisfied = evaluatePort?.(reminder.trigger.subject, reminder.trigger.attribute, reminder.trigger.predicate);
            if (satisfied) {
                const fired = fireReminder(reminder, { missed: false, lateness: 0 });
                if (fired) events.push(fired);
            }
        }
        return events;
    }

    function armExpectation(spec) {
        if (expectations.size >= bounds.MAX_PENDING_EXPECTATIONS) {
            const oldest = [...expectations.values()].sort((a, b) => Date.parse(a.window.latestAt) - Date.parse(b.window.latestAt))[0];
            if (oldest) expectations.delete(oldest.expectationId);
        }
        const e = makeExpectation({ ...spec, expectationId: spec.expectationId ?? crypto.randomUUID() });
        expectations.set(e.expectationId, e);
        return e;
    }

    /** §6/PM-4: pelanggaran TIDAK PERNAH menegaskan nilai sebaliknya — hanya membuka jalur kebijakan. */
    function checkExpectations(evaluatePort) {
        const results = [];
        const nowMs = now();
        for (const e of [...expectations.values()]) {
            if (e.state !== "PENDING") continue;
            const observed = evaluatePort?.(e.subject, e.attribute);
            if (observed && observed.value === e.expectedValue &&
                observed.atMs >= Date.parse(e.window.earliestAt ?? 0) && observed.atMs <= Date.parse(e.window.latestAt)) {
                const next = Object.freeze({ ...e, state: "SATISFIED" });
                expectations.set(e.expectationId, next);
                results.push({ expectationId: e.expectationId, outcome: "SATISFIED" });
            } else if (nowMs > Date.parse(e.window.latestAt)) {
                const next = Object.freeze({ ...e, state: "VIOLATED" });
                expectations.set(e.expectationId, next);
                results.push({ expectationId: e.expectationId, outcome: "VIOLATED", policy: e.onViolated });
            }
        }
        return results;
    }

    function getReminder(reminderId) { return reminders.get(reminderId) ?? null; }
    function getExpectation(expectationId) { return expectations.get(expectationId) ?? null; }
    function deferredCount() { return deferredWakeEvents.length; }

    async function persist() { return saveSnapshot(store, { reminders, expectations, firedOccurrenceIds }); }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        catchUpEvents,
        arm, tick, checkOnStateReminders,
        armExpectation, checkExpectations,
        getReminder, getExpectation, deferredCount,
        persist, laws, bounds
    });
}

module.exports = { createProspectiveMemory, laws, BOUNDS };
