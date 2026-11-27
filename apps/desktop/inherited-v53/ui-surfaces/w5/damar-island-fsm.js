/*
 * DAMAR Companion Island state logic, adapted from Coucou Windows.
 * Upstream: Louis-CFM/coucou, windows/src/island/fsm.ts
 * Reviewed revision: b1bc09de7f7c24a80bd8eca5729b8bee60f66402
 * Copyright (c) 2026 Louis Raillé. Licensed under the MIT License.
 * This adaptation uses only generic state/timer behavior; no Coucou/Mochi
 * character, artwork, sounds, agent hooks, credentials, or approval logic.
 *
 * R4: one initial orb phase, then notch for the lifetime of this FSM.
 * Pointer motion never extends inactivity. Hidden edge wake needs a fresh entry.
 */
'use strict';

class DamarIslandFSM {
  constructor({
    orbMorphAfterMs = 10000,
    morphMs = 620,
    inactivityMs = 300000,
    clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) }
  } = {}) {
    this.state = 'hidden';
    this.orbMorphAfterMs = orbMorphAfterMs;
    this.morphMs = morphMs;
    this.inactivityMs = inactivityMs;
    this.clock = clock;
    this.orbStarted = false;
    this.orbPhaseDone = false;
    this.edgeInside = false;
    this.edgeArmed = false;
    this.deferredNotification = false;
    this.notificationActive = false;
    this.onTransition = null;
    this.timers = new Map();
  }

  setIntervals({ orbMorphAfterMs, morphMs, inactivityMs } = {}) {
    if (Number.isFinite(orbMorphAfterMs) && orbMorphAfterMs >= 0) this.orbMorphAfterMs = orbMorphAfterMs;
    if (Number.isFinite(morphMs) && morphMs >= 0) this.morphMs = morphMs;
    if (Number.isFinite(inactivityMs) && inactivityMs >= 0) this.inactivityMs = inactivityMs;
    // Reschedule sesuai state kini (dipakai pengujian; produksi memakai default Owner).
    if (this.state === 'orb') this.scheduleOrbMorph();
    if (this.state === 'compact' || this.state === 'expanded') this.notchActivity();
  }

  enterOrb() {
    if (this.state !== 'hidden') return;
    if (this.orbStarted || this.orbPhaseDone) { this.reveal(); return; }
    this.orbStarted = true;
    this.cancelTimers();
    this.transition('orb');
    this.scheduleOrbMorph();
  }

  scheduleOrbMorph() {
    // Owner: 10 detik tanpa aktivitas percakapan di mode orb -> morph ke notch.
    this.schedule('orbMorph', this.orbMorphAfterMs, () => this.wakeFromOrb());
  }

  wakeFromOrb() {
    if (this.state !== 'orb') return;
    this.cancelTimers();
    this.orbPhaseDone = true;
    this.transition('morph');
    this.schedule('morph', this.morphMs, () => {
      this.transition('compact');
      this.notchActivity();
    });
  }

  orbActivity() {
    // Initial orb duration is fixed, not a rolling hover/activity window.
  }

  notchActivity() {
    if (this.state !== 'compact' && this.state !== 'expanded') return;
    if (this.notificationActive) { this.clear('inactivity'); return; }
    this.schedule('inactivity', this.inactivityMs, () => this.hide());
  }

  meaningfulInteraction() {
    this.notchActivity();
  }

  notification({ substantive = false, defer = false, active = false } = {}) {
    if (!substantive) return;
    this.notificationActive = Boolean(active);
    if (defer) { this.deferredNotification = true; return; }
    this.deferredNotification = false;
    if (this.state === 'hidden') this.reveal();
    else if (this.state === 'orb') this.wakeFromOrb();
    this.notchActivity();
  }

  flushNotification() {
    this.notificationActive = false;
    if (this.deferredNotification) this.notification({ substantive: true });
    else this.notchActivity();
  }

  edgePointer(inside) {
    inside = Boolean(inside);
    const fresh = inside && !this.edgeInside;
    this.edgeInside = inside;
    if (!inside) this.edgeArmed = true;
    if (this.state === 'hidden' && fresh && this.edgeArmed) {
      this.edgeArmed = false;
      this.reveal();
    }
  }

  reveal() {
    // Hover wake: dari hidden (auto-hidden) -> compact notch lagi; dari orb -> morph.
    if (this.state === 'orb') { this.wakeFromOrb(); return; }
    if (this.state !== 'hidden') return;
    this.cancelTimers();
    this.orbPhaseDone = true;
    this.deferredNotification = false;
    this.transition('compact');
    this.notchActivity();
  }

  pointerEntered() {
    if (this.state === 'compact') this.transition('expanded');
  }

  pointerLeft() {
    if (this.state === 'expanded') this.transition('compact');
  }

  toggle() {
    if (this.state === 'hidden') this.reveal();
    else if (this.state === 'orb') this.reveal();
    else if (this.state === 'compact') { this.transition('expanded'); this.notchActivity(); }
    else if (this.state === 'expanded') { this.transition('compact'); this.notchActivity(); }
  }

  dismiss() {
    if (this.state === 'compact' || this.state === 'expanded') this.hide();
  }

  hide() {
    this.cancelTimers();
    if (this.orbStarted) this.orbPhaseDone = true;
    this.edgeArmed = !this.edgeInside;
    this.transition('hidden');
  }

  schedule(name, delay, action) {
    this.clear(name);
    this.timers.set(name, this.clock.setTimeout(() => { this.timers.delete(name); action(); }, Math.max(0, delay)));
  }

  clear(name) {
    const timer = this.timers.get(name);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(name);
  }

  cancelTimers() { for (const name of [...this.timers.keys()]) this.clear(name); }

  transition(next) {
    if (!['hidden', 'orb', 'morph', 'compact', 'expanded'].includes(next) || this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.onTransition?.(previous, next);
  }
}

if (typeof module !== 'undefined') module.exports = { DamarIslandFSM };
if (typeof window !== 'undefined') window.DamarIslandFSM = DamarIslandFSM;
