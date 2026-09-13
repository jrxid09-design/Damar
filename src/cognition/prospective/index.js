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

function dueAtMs(reminder, bounds = BOUNDS) {
    const t = reminder.trigger;
    if (t.kind === "AT") return Date.parse(t.at);
    if (t.kind === "AFTER") return (reminder.armedAtMs ?? 0) + t.delayMs;
    if (t.kind === "RECURRING") {
        const next = (reminder.armedAtMs ?? 0) + t.intervalMs * (reminder.occurrenceIndex + 1);
        if (t.until && next > Date.parse(t.until)) return null;
        // Bug review independen (audit putaran-7, W7R7-P2-2): ceiling
        // maxOccurrences dulu hanya dicek kalau pemanggil MEMBERINYA --
        // trigger `until`-saja yang jatuh tempo jauh di masa depan bisa
        // tick tanpa batas, menumpuk firedOccurrenceIds tanpa henti karena
        // reminder-nya sendiri tetap ARMED (bukan terminal) selamanya.
        // bounds.MAX_RECURRENCE_OCCURRENCES sekarang jadi langit-langit
        // implisit terlepas dari apakah maxOccurrences eksplisit diberikan.
        const effectiveMaxOccurrences = t.maxOccurrences
            ? Math.min(t.maxOccurrences, bounds.MAX_RECURRENCE_OCCURRENCES)
            : bounds.MAX_RECURRENCE_OCCURRENCES;
        if (reminder.occurrenceIndex + 1 > effectiveMaxOccurrences) return null;
        return next;
    }
    return null; // ON_STATE: bukan berbasis waktu (ON_EVENT ditolak sejak putaran-18, AUD18-P2-2 -- tidak ada jalur dispatch)
}

async function createProspectiveMemory({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS } = {}) {

    const snapshot = await loadSnapshot(store);
    const reminders = snapshot.reminders;
    const expectations = snapshot.expectations;
    const firedOccurrenceIds = snapshot.firedOccurrenceIds;
    const remindersPerGoal = new Map();
    for (const r of reminders.values()) {
        // Bug review independen (Codex putaran-7): rebuild restart lama
        // menghitung SEMUA reminder tersimpan (termasuk FIRED/RETIRED),
        // padahal releaseArmedCapacity() hanya melepas slot untuk yang
        // ARMED di proses hidup -- pasca-restart, goal dengan reminder
        // terminal salah diblokir MAX_REMINDERS_PER_GOAL sampai kompaksi
        // retensi terjadi. Sekarang hanya reminder ARMED yang dihitung.
        if (r.ownerRef && r.state === "ARMED") {
            remindersPerGoal.set(r.ownerRef, (remindersPerGoal.get(r.ownerRef) ?? 0) + 1);
        }
    }

    let wakeEventsThisMinute = [];
    const deferredWakeEvents = [];
    let droppedDeferredWakeEventCount = 0;

    function now() { return clock.nowMs(); }
    function nowIso() { return new Date(now()).toISOString(); }

    let armedReminderCount = [...reminders.values()].filter(r => r.state === "ARMED").length;

    function arm(spec) {
        // Bug review independen (audit putaran-21, AUD21-ADV-1): spec null/
        // non-objek meledakkan `spec.reminderId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-10, AUD10-P1-2/AUD10-P2-4):
        // reminderId pemanggil dulu langsung menimpa entri lama tanpa cek
        // tabrakan -- replay sebuah reminderId yang sudah ARMED menaikkan
        // armedReminderCount/remindersPerGoal LAGI untuk record yang sama
        // (kapasitas armed terkuras permanen sampai restart), dan replay
        // reminderId yang sudah RETIRED/FIRED menghidupkannya kembali ke
        // ARMED, melewati finalitas state terminal.
        if (spec.reminderId && reminders.has(spec.reminderId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `reminderId '${spec.reminderId}' sudah ada`);
        }
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
            // Bug review independen (Codex putaran-6): antrean ini tidak
            // pernah dibatasi -- beban recurring-reminder yang bertahan lama
            // membuatnya tumbuh tanpa batas. Sekarang dibatasi, kelebihan
            // tertua dibuang TAPI TETAP TERHITUNG (bukan hilang diam-diam).
            if (deferredWakeEvents.length > bounds.MAX_DEFERRED_WAKE_EVENTS) {
                deferredWakeEvents.shift();
                droppedDeferredWakeEventCount += 1;
            }
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
        // Bug review independen (audit putaran-19, AUD19-P2-3): tidak ada
        // batas eksplisit pada firedOccurrenceIds -- hanya dipangkas
        // oportunistik saat reminder lain dikompaksi. Dipangkas FIFO
        // (Set mempertahankan urutan insersi) begitu melebihi batas eksplisit.
        if (firedOccurrenceIds.size > bounds.MAX_FIRED_OCCURRENCE_IDS) {
            firedOccurrenceIds.delete(firedOccurrenceIds.values().next().value);
        }

        const event = makeWakeEvent({
            reminderId: reminder.reminderId, wakeClass: reminder.wakeClass,
            payloadRef: reminder.payloadRef, firedAt: nowIso(),
            occurrenceId: occId, lateness, missed
        });

        const isRecurring = reminder.trigger.kind === "RECURRING";
        const nextIndex = reminder.occurrenceIndex + 1;
        const stillRecurs = isRecurring && dueAtMs({ ...reminder, occurrenceIndex: nextIndex }, bounds) !== null;

        reminders.set(reminder.reminderId, Object.freeze({
            ...reminder,
            state: stillRecurs ? "ARMED" : "FIRED",
            occurrenceIndex: nextIndex,
            firedAt: nowIso(), missedAt: missed ? nowIso() : reminder.missedAt
        }));

        // Bug diketemukan review independen (Codex): kapasitas armed tidak
        // pernah dilepas setelah reminder berhenti ARMED secara permanen,
        // sehingga proses berumur panjang akhirnya menolak arm() baru
        // walau tidak ada lagi reminder yang benar-benar ARMED.
        if (!stillRecurs) {
            releaseArmedCapacity(reminder);
            compactTerminalRemindersIfOverBound();
        }

        return admitWakeEvent(event);
    }

    function retire(reminder, reason) {
        reminders.set(reminder.reminderId, Object.freeze({ ...reminder, state: "RETIRED", retiredReason: reason }));
        releaseArmedCapacity(reminder);
        compactTerminalRemindersIfOverBound();
    }

    function releaseArmedCapacity(reminder) {
        armedReminderCount = Math.max(0, armedReminderCount - 1);
        if (reminder.ownerRef) {
            const next = Math.max(0, (remindersPerGoal.get(reminder.ownerRef) ?? 1) - 1);
            // Bug review independen (audit putaran-4, W7R4-P2-3): nilai
            // hanya diturunkan ke 0, kuncinya sendiri tidak pernah dihapus
            // -- satu entri Map menumpuk selamanya per ownerRef berbeda
            // yang pernah dipakai, walau reminder-nya sudah tidak ada.
            if (next === 0) remindersPerGoal.delete(reminder.ownerRef);
            else remindersPerGoal.set(reminder.ownerRef, next);
        }
    }

    /**
     * Bug review independen (Codex putaran-6): hanya reminder ARMED yang
     * dihitung ke batas kapasitas -- reminder FIRED/RETIRED (dan
     * firedOccurrenceIds miliknya) tertahan selamanya di memori dan snapshot.
     * Dipanggil setiap kali reminder menjadi terminal; hanya mengompaksi
     * reminder terminal PALING LAMA (createdAt), tidak pernah reminder yang
     * masih ARMED.
     */
    function compactTerminalRemindersIfOverBound() {
        if (reminders.size <= bounds.MAX_TOTAL_REMINDERS_RETAINED) return;
        const terminal = [...reminders.values()]
            .filter(r => r.state === "FIRED" || r.state === "RETIRED")
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const victim = terminal[0];
        if (!victim) return;
        reminders.delete(victim.reminderId);
        const prefix = `${victim.reminderId}:`;
        for (const key of firedOccurrenceIds) {
            if (key.startsWith(prefix)) firedOccurrenceIds.delete(key);
        }
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

            const due = dueAtMs(reminder, bounds);
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

            const due = dueAtMs(reminder, bounds);
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
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.expectationId` jadi TypeError mentah -- sibling
        // `arm()` di file yang sama dijaga putaran-21 (PM-repair-22), fungsi
        // ini terlewat.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // expectationId yang sudah ada (mis. sudah VIOLATED) menimpanya
        // kembali ke PENDING, memicu ulang jalur kebijakan (onSatisfied/
        // onViolated) untuk expectation yang sudah final.
        if (spec.expectationId && expectations.has(spec.expectationId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `expectationId '${spec.expectationId}' sudah ada`);
        }
        // Bug review independen (audit putaran-14, AUD14-P1-2): kompaksi
        // (menghapus expectation valid lain) dulu berjalan SEBELUM
        // makeExpectation memvalidasi spec -- spec yang ditolak (mis.
        // window.latestAt cacat) tetap mengevict satu expectation pending
        // yang VALID sebelum error dilempar, kehilangan data permanen.
        // Validasi/bangun record DULU, baru kompaksi+simpan.
        const e = makeExpectation({ ...spec, expectationId: spec.expectationId ?? crypto.randomUUID() });
        if (expectations.size >= bounds.MAX_PENDING_EXPECTATIONS) {
            const oldest = [...expectations.values()].sort((a, b) => Date.parse(a.window.latestAt) - Date.parse(b.window.latestAt))[0];
            if (oldest) expectations.delete(oldest.expectationId);
        }
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
    function droppedDeferredCount() { return droppedDeferredWakeEventCount; }
    function reminderCount() { return reminders.size; }
    function remindersPerGoalSize() { return remindersPerGoal.size; }
    function firedOccurrenceIdsSize() { return firedOccurrenceIds.size; }

    async function persist() { return saveSnapshot(store, { reminders, expectations, firedOccurrenceIds }); }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        catchUpEvents,
        arm, tick, checkOnStateReminders,
        armExpectation, checkExpectations,
        getReminder, getExpectation, deferredCount, droppedDeferredCount, reminderCount, remindersPerGoalSize,
        firedOccurrenceIdsSize,
        persist, laws, bounds
    });
}

module.exports = { createProspectiveMemory, laws, BOUNDS };
