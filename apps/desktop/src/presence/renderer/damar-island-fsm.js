/*
 * DAMAR Companion Island state logic, adapted from Coucou Windows.
 * Upstream: Louis-CFM/coucou, windows/src/island/fsm.ts
 * Reviewed revision: b1bc09de7f7c24a80bd8eca5729b8bee60f66402
 * Copyright (c) 2026 Louis Raillé. Licensed under the MIT License.
 * This adaptation uses only generic state/timer behavior; no Coucou
 * character, artwork, sounds, agent hooks, credentials, or approval logic.
 *
 * Owner lifecycle (final):
 *   FULL_IDLE_PRESENCE
 *     -> (tidak ada interaksi; idle pemicu dari prototipe) ORB_STANDBY
 *     -> (10 detik tanpa aktivitas percakapan di mode orb) MORPH -> NOTCH_COMPACT
 *   Notch dijalankan oleh pointer SAJA (tanpa timer): pointer masuk -> expanded,
 *   keluar -> compact lalu hidden; klik di luar -> hidden; hover area notch saat
 *   hidden -> compact lagi. TIDAK ada auto-hide berbasis waktu (BUKAN balik ke orb).
 *   Percakapan suara memakai orb: notch yield, lalu kembali setelahnya.
 */
'use strict';

class DamarIslandFSM {
  constructor({
    orbMorphAfterMs = 10000,     // Owner: 10 detik orb tanpa percakapan -> notch
    morphMs = 620                // durasi transisi visual orb -> notch saja
  } = {}) {
    this.state = 'hidden';
    this.orbMorphAfterMs = orbMorphAfterMs;
    this.morphMs = morphMs;
    this.onTransition = null;
    this.timers = new Map();
  }

  setIntervals({ orbMorphAfterMs, morphMs } = {}) {
    if (Number.isFinite(orbMorphAfterMs) && orbMorphAfterMs >= 0) this.orbMorphAfterMs = orbMorphAfterMs;
    if (Number.isFinite(morphMs) && morphMs >= 0) this.morphMs = morphMs;
    // Reschedule sesuai state kini (dipakai pengujian; produksi memakai default Owner).
    if (this.state === 'orb') this.scheduleOrbMorph();
  }

  enterOrb() {
    if (this.state !== 'hidden') return;
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
    this.transition('morph');
    this.schedule('morph', this.morphMs, () => {
      this.transition('compact');
    });
  }

  orbActivity() {
    // Aktivitas percakapan di mode orb mengulang jendela 10 detik.
    if (this.state !== 'orb') return;
    this.scheduleOrbMorph();
  }

  notchActivity() {
    // Tidak ada timer notch; aktivitas pointer di atas notch tidak perlu
    // mereschedule apa pun (pointer-leave/klik-luar yang menutupnya).
  }

  reveal() {
    // Hover wake: dari hidden (auto-hidden) -> compact notch lagi; dari orb -> morph.
    if (this.state === 'orb') { this.wakeFromOrb(); return; }
    if (this.state !== 'hidden') return;
    this.cancelTimers();
    this.transition('compact');
  }

  pointerEntered() {
    if (this.state === 'compact') { this.transition('expanded'); this.notchActivity(); }
    else if (this.state === 'expanded') this.notchActivity();
    else if (this.state === 'hidden') { this.reveal(); }
  }

  pointerLeft() {
    if (this.state === 'expanded') { this.transition('compact'); this.notchActivity(); }
    else if (this.state === 'compact') this.transition('hidden');
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

  hide() { this.cancelTimers(); this.transition('hidden'); }

  schedule(name, delay, action) {
    this.clear(name);
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); action(); }, Math.max(0, delay)));
  }

  clear(name) {
    const timer = this.timers.get(name);
    if (timer !== undefined) clearTimeout(timer);
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
