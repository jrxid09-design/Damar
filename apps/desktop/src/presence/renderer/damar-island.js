'use strict';
/* DAMAR Presence product port of C/scripts/preview-adapters/damar-island.js
 * (sha256 399c148c771a47fb9524714430baae31771fd977ffba81bdd2cfaea57dc3d2a7). Geometry/tokens unchanged.
 * Product deltas only: demo-route fallbacks removed; Core-owned config (presence.idleToNotchMs, morphMs,
 * notchEnabled) applied live via configure(); voice conversation yields the notch to the orb; the orb stays hidden
 * while the notch is pointer-hidden after the first morph (Owner directive 2); status line from Core counts.
 * DAMAR-only Electron adaptation of Coucou's generic Island lifecycle.
 * Owner directives (pre-production):
 * 1. Notch = iPhone 12 Pro Max style: flush to the top edge, center-top,
 *    zero gap, rounded lower corners only, never a floating pill.
 * 2. The standby orb morphs into the notch and they are never visible
 *    together; after the morph the orb never returns.
 * 3. The notch reacts to mouse activity ONLY: expand on pointer entry,
 *    hide on pointer exit / outside click. No inactivity timers, no
 *    user interval settings. */
(() => {
  if (window.__DAMAR_ISLAND__) return;
  const fsm = new window.DamarIslandFSM();

  const style = document.createElement('style');
  style.textContent = `
    #damarIsland { position:fixed; z-index:2147483000; top:0; left:50%; transform:translateX(-50%) translateY(-100%); width:186px; height:34px; overflow:hidden; border:0; border-radius:0 0 20px 20px; background:#08080c; color:#f6f2e9; box-shadow:inset 0 -1px 0 rgba(229,193,101,.40); font:600 12px/1.2 'Segoe UI',sans-serif; transition:width .26s cubic-bezier(.16,1,.3,1),height .26s cubic-bezier(.16,1,.3,1),border-radius .26s ease,transform .3s cubic-bezier(.16,1,.3,1),opacity .22s ease; opacity:1; pointer-events:auto; }
    #damarIsland[data-state="hidden"] { transform:translateX(-50%) translateY(-102%); opacity:0; pointer-events:none; }
    #damarIsland[data-state="orb"] { transform:translateX(-50%) translateY(-102%); opacity:0; pointer-events:none; }
    #damarIsland[data-state="morph"] { transform:translateX(-50%) translateY(0); width:112px; height:30px; border-radius:0 0 17px 17px; opacity:.92; }
    #damarIsland[data-state="compact"] { transform:translateX(-50%) translateY(0); width:186px; height:34px; border-radius:0 0 20px 20px; }
    #damarIsland[data-state="expanded"] { transform:translateX(-50%) translateY(0); width:min(420px,calc(100vw - 24px)); height:158px; border-radius:0 0 22px 22px; }
    #damarIsland .di-head { height:32px; display:flex; align-items:center; justify-content:center; gap:6px; color:#f2d987; cursor:pointer; }
    #damarIsland .dnc-slot { width:52px; height:32px; display:block; } #damarIsland .dnc-slot svg { width:100%; height:100%; display:block; }
    #damarIsland[data-state="expanded"] .dnc-head { width:88px; height:64px; }
    /* The stage carries the character when expanded; the head canvas would duplicate it above the 70px stage. */
    #damarIsland[data-state="expanded"] .dnc-head { visibility:hidden; }
    #damarIsland .di-char-stage { position:relative; width:100%; height:70px; overflow:hidden; display:none; }
    #damarIsland[data-state="expanded"] .di-char-stage { display:block; }
    #damarIsland .di-char-stage .dnc-stage { position:absolute; inset:0; margin:auto; width:100%; height:100%; }
    #damarIsland[data-state="morph"] .di-head { color:rgba(242,217,135,.55); }
    #damarIsland .di-body { display:none; padding:1px 12px 3px; }
    #damarIsland[data-state="expanded"] .di-body { display:block; }
    #damarIsland .di-status { margin:0 0 3px; color:#c7c0b2; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #damarIsland[data-attention="permission"] .di-status { color:#f2d987; }
    #damarIsland .di-mic { display:none; width:7px; height:7px; border-radius:50%; background:#e5c158; box-shadow:0 0 6px #e5c158; }
    #damarIsland[data-mic="on"] .di-mic { display:inline-block; }
    #damarIsland .di-pills { display:flex; gap:5px; flex-wrap:wrap; margin:0 0 5px; }
    #damarIsland .di-pill { font-size:10px; letter-spacing:.02em; color:#e8e2d2; background:rgba(245,185,66,.13); border:1px solid rgba(245,185,66,.35); border-radius:999px; padding:2px 8px; white-space:nowrap; }
    #damarIsland .di-pill[data-state="WORKING"] { background:rgba(245,185,66,.3); color:#ffe9a8; }
    #damarIsland .di-pill[data-state="CLOSED"] { opacity:.45; }
    #damarIsland .di-media { display:flex; gap:8px; align-items:center; margin:0 0 5px; color:#e8e2d2; font-size:11px; }
    #damarIsland .di-media-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:170px; }
    #damarIsland .di-media button { background:rgba(245,185,66,.13); border:1px solid rgba(245,185,66,.35); color:#ffe9a8; border-radius:7px; font-size:10px; padding:2px 7px; cursor:pointer; }
    #damarIsland .di-controls { display:flex; gap:7px; align-items:center; flex-wrap:wrap; }
    #damarIsland button { min-height:32px; border:1px solid rgba(229,193,101,.45); border-radius:7px; padding:5px 9px; background:#151319; color:#f6f2e9; font:600 11px 'Segoe UI',sans-serif; cursor:pointer; }
    #damarIsland button:focus-visible { outline:2px solid #f7df94; outline-offset:2px; }
    #damarIslandWake { position:fixed; z-index:2147482999; top:0; left:50%; transform:translateX(-50%); width:210px; height:10px; pointer-events:none; }
    /* Owner directive: saat notch aktif (morph/compact/expanded), orb standby
       di bawah ikut morph-out — tidak ada state final dengan keduanya tampil. */
    body.siri-dock-active #siriOrbDock { transition: top .5s cubic-bezier(.16,1,.3,1), width .4s ease, height .4s ease, transform .5s cubic-bezier(.16,1,.3,1), opacity .4s ease; }
    body.siri-dock-active[data-island-notch="morph"] #siriOrbDock,
    body.siri-dock-active[data-island-notch="compact"] #siriOrbDock,
    body.siri-dock-active[data-island-notch="expanded"] #siriOrbDock,
    body.siri-dock-active[data-island-notch="hidden"] #siriOrbDock {
      top: 14px !important;
      transform: translate(-50%, -50%) scale(.34) !important;
      opacity: 0 !important;
      pointer-events: none !important;
      filter: none !important;
    }
  `;
  document.head.appendChild(style);
  const wake = document.createElement('div'); wake.id = 'damarIslandWake'; wake.setAttribute('aria-hidden','true');
  const island = document.createElement('section');
  island.id = 'damarIsland'; island.dataset.state = 'hidden'; island.setAttribute('aria-label','DAMAR Companion Island');
  island.innerHTML = `<div class="di-head" role="button" tabindex="0" aria-label="DAMAR Companion Island"><div class="dnc-slot dnc-head" data-dnc="head" aria-hidden="true"></div><span class="di-mic" role="img" aria-label="Microphone on"></span></div><div class="di-char-stage"><div class="dnc-slot dnc-stage" data-dnc="stage" aria-hidden="true"></div></div><div class="di-body"><p class="di-status" role="status" aria-live="polite">DAMAR Core not connected</p><div class="di-pills" hidden></div><div class="di-media" hidden><span class="di-media-text"></span><button type="button" data-media="previous" aria-label="Previous track">&lt;&lt;</button><button type="button" data-media="toggle" aria-label="Play or pause">&#9654;</button><button type="button" data-media="next" aria-label="Next track">&gt;&gt;</button></div><div class="di-controls"><button type="button" data-action="presence" data-t="returnPresence">Return to Presence</button><button type="button" data-action="dashboard" data-t="dashboard">Control</button><button type="button" data-action="allow-once" data-t="allowOnce" hidden>Allow once</button><button type="button" data-action="allow-session" data-t="allowSession" hidden>Allow for session</button><button type="button" data-action="deny" data-t="deny" hidden>Deny</button></div></div>`;
  document.body.append(wake, island);
  const head = island.querySelector('.di-head');
  const desktop = () => window.damarDesktop;
  let pointerInside = false;

  const NOTCH_STATES = new Set(['morph', 'compact', 'expanded']);
  // Owner rule: setelah orb pernah morph menjadi notch, jangan pernah kembali
  // ke orb kecil lagi. Orb hanya untuk standby awal sebelum notch pertama.
  let orbPhaseDone = false;
  function syncOrbMorph(state) {
    if (state === 'morph') orbPhaseDone = true;
    if (NOTCH_STATES.has(state)) document.body.dataset.islandNotch = state;
    // Owner directive 2: after the morph the orb never returns (except voice, below), also while the notch is hidden.
    else if (state === 'hidden' && orbPhaseDone && !voiceActive) document.body.dataset.islandNotch = 'hidden';
    else delete document.body.dataset.islandNotch;
  }
  let voiceActive = false, notchEnabled = true;
  // Voice conversation uses the orb: the notch yields, the orb stays (no morph) while voice runs, then the normal
  // orb window (idleToNotchMs) runs again and morphs back to the notch.
  function voiceStart() {
    if (voiceActive || !document.body.classList.contains('siri-dock-active')) return;
    voiceActive = true;
    if (fsm.state !== 'orb') { fsm.hide(); fsm.enterOrb(); }
    fsm.cancelTimers();
  }
  function voiceEnd() {
    if (!voiceActive) return;
    voiceActive = false;
    if (fsm.state === 'orb' && notchEnabled) fsm.scheduleOrbMorph();
  }
  let configKey = '';
  function configure({ idleToNotchMs, morphMs, notchEnabled: enabled } = {}) {
    const key = JSON.stringify([idleToNotchMs, morphMs, enabled]);
    if (key === configKey) return; // identical pushes (every Core state change carries the config) change nothing
    configKey = key;
    if (typeof enabled === 'boolean') notchEnabled = enabled;
    // Only a real change reschedules the running orb window (repeated identical config must not reset it).
    if ((Number.isFinite(idleToNotchMs) && idleToNotchMs !== fsm.orbMorphAfterMs) || (Number.isFinite(morphMs) && morphMs !== fsm.morphMs))
      fsm.setIntervals({ orbMorphAfterMs: idleToNotchMs, morphMs });
    if (voiceActive && fsm.state === 'orb') fsm.cancelTimers();
    else if (!notchEnabled) {
      fsm.cancelTimers();
      if (NOTCH_STATES.has(fsm.state) || fsm.state === 'hidden') { fsm.hide(); if (document.body.classList.contains('siri-dock-active')) { orbPhaseDone = false; fsm.enterOrb(); fsm.cancelTimers(); } }
    } else if (fsm.state === 'orb' && !voiceActive) fsm.scheduleOrbMorph();
  }
  const enterOrbBase = fsm.enterOrb.bind(fsm);
  fsm.enterOrb = () => { enterOrbBase(); if (!notchEnabled || voiceActive) fsm.cancelTimers(); };
  const revealBase = fsm.reveal.bind(fsm);
  fsm.reveal = () => { if (notchEnabled && !voiceActive) revealBase(); };
  const orbActivityBase = fsm.orbActivity.bind(fsm);
  fsm.orbActivity = () => { if (notchEnabled && !voiceActive) orbActivityBase(); };
  function orbVisible() {
    const orb = document.getElementById('siriOrbDock');
    if (!orb) return false;
    const cs = getComputedStyle(orb);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const rect = orb.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return Number(cs.opacity) > 0.05;
  }
  function assertNoCoexistence(state) {
    // Invariant Owner: notch aktif => orb standby tidak terlihat.
    if (NOTCH_STATES.has(state) && document.body.classList.contains('siri-dock-active') && orbVisible()) {
      document.body.dataset.islandNotchViolation = 'orb-visible-during-notch';
    } else {
      delete document.body.dataset.islandNotchViolation;
    }
  }
  function setClickThrough(ignore) {
    const api = desktop();
    if (api?.setIgnoreMouse) api.setIgnoreMouse(Boolean(ignore));
  }
  function setStandbyMode(standby) {
    desktop()?.setStandbyMode?.(Boolean(standby));
    setClickThrough(Boolean(standby));
    assertNoCoexistence(fsm.state);
  }
  function render(from, to) {
    island.dataset.state = to;
    island.setAttribute('aria-expanded', String(to === 'expanded'));
    syncOrbMorph(to);
    assertNoCoexistence(to);
    if (to === 'expanded') setClickThrough(false);
    if (to === 'hidden' || to === 'compact') updateHitTest();
    window.dispatchEvent(new CustomEvent('damar-island-state', { detail: { from, to } }));
  }
  function updateHitTest(event) {
    const standbyMode = document.body.classList.contains('siri-dock-active');
    if (!standbyMode) { setClickThrough(false); return; }
    const x = event?.clientX, y = event?.clientY;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const islandRect = island.getBoundingClientRect();
      const orb = document.getElementById('siriOrbDock');
      const orbRect = orb?.getBoundingClientRect();
      const within = (r) => r && x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 10 && y <= r.bottom + 10;
      pointerInside = within(islandRect);
      const notchActive = NOTCH_STATES.has(fsm.state);
      const standbyInteractive = !notchActive && !orbPhaseDone && within(orbRect);
      setClickThrough(!(pointerInside || standbyInteractive));
      // Aktivitas pointer di area orb/notch memperpanjang jendela Owner:
      // orb -> 10 detik (menuju morph). Notch TIDAK pakai timer.
      if (standbyInteractive && fsm.state === 'orb') fsm.orbActivity();
      // Hover wake: pointer ke area notch saat hidden (auto-hidden) -> compact lagi.
      if (island.dataset.state === 'hidden' && y <= 12 && Math.abs(x - innerWidth / 2) <= 110) {
        fsm.reveal();
        return; // jangan jalankan compact-check dengan rect/pointerInside lama pada event yang sama
      }
      // Mouse-only close: pointer terlacak jauh dari notch saat compact -> hidden,
      // tapi HANYA bila state compact sudah stabil (bukan sisa event mouseleave
      // yang baru saja collapse expanded->compact pada pointermove yang sama).
      const seqAtEntry = transitionSeq;
      if (fsm.state === 'compact' && !pointerInside && y > islandRect.bottom + 24) {
        setTimeout(() => {
          if (fsm.state === 'compact' && transitionSeq === seqAtEntry) fsm.pointerLeft();
        }, 90);
      }
    }
  }
  let transitionSeq = 0;
  fsm.onTransition = (from, to) => { transitionSeq++; render(from, to); };
  setClickThrough(false);
  document.addEventListener('mousemove', updateHitTest, { passive: true });
  // Mouse-only lifecycle: pointer masuk/keluar mengendalikan notch penuh.
  island.addEventListener('mouseenter', () => fsm.pointerEntered());
  island.addEventListener('mouseleave', () => fsm.pointerLeft());
  // Klik di luar notch menutupnya (tanpa timer). Klik pada orb standby dikecualikan:
  // itu pemicu morph orb -> notch.
  document.addEventListener('click', event => {
    if (event.target.closest('#siriOrbDock')) return;
    if (!island.contains(event.target)) fsm.dismiss();
  }, true);
  // Klik orb standby: morph orb -> notch (bukan coexistence).
  document.addEventListener('click', event => {
    if (!document.body.classList.contains('siri-dock-active') || !event.target.closest('#siriOrbDock')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    fsm.reveal();
  }, true);
  const activate = () => { if (fsm.state === 'hidden' || fsm.state === 'orb') fsm.reveal(); else fsm.toggle(); };
  head.addEventListener('click', activate);
  head.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
  island.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'dashboard') {
      fsm.hide();
      // Opens DAMAR Control (the single configuration surface) in the Owner's browser; never a demo route.
      await desktop()?.navigateSurface?.('dashboard');
    } else if (['allow-once', 'allow-session', 'deny'].includes(action) && permission) {
      // Owner decision from the notch: main process authenticates it; the renderer only names the pending request.
      const decision = action === 'deny' ? 'deny' : action === 'allow-session' ? 'session' : 'once';
      await desktop()?.decidePermission?.({ permissionId: permission.permissionId, decision });
    } else if (action === 'presence') {
      fsm.hide();
      if (typeof window.wakeFromMiniOrb === 'function') window.wakeFromMiniOrb();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (fsm.state === 'expanded' || fsm.state === 'compact')) { fsm.dismiss(); event.preventDefault(); }
    if (event.altKey && event.key.toLowerCase() === 'd') fsm.toggle();
  });
  desktop()?.on?.('toggle-standby-orb', activate);
  desktop()?.on?.('window-restored', () => { setClickThrough(false); updateHitTest(); });
  window.addEventListener('blur', () => { if (fsm.state === 'expanded') fsm.pointerLeft(); });
  window.addEventListener('beforeunload', () => { fsm.cancelTimers(); setClickThrough(false); });
  const standbyObserver = new MutationObserver(() => {
    const standby = document.body.classList.contains('siri-dock-active');
    setStandbyMode(standby);
    // Alur Owner final: Idle Presence penuh -> (idle pemicu prototipe) -> orb;
    // FSM memegang timer 10s orb->morph; notch tidak punya timer (pointer/klik
    // luar yang menutup). Setelah notch, TIDAK kembali ke orb; hover area notch
    // memunculkan kembali.
    if (standby && fsm.state === 'hidden' && !orbPhaseDone) fsm.enterOrb();
    else if (!standby && (fsm.state === 'orb' || fsm.state === 'compact' || fsm.state === 'expanded')) fsm.hide();
    if (!standby && fsm.state === 'hidden') { orbPhaseDone = false; delete document.body.dataset.islandNotch; } // fase orb di-reset hanya dari Idle Presence penuh
    assertNoCoexistence(fsm.state);
  });
  standbyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  setStandbyMode(document.body.classList.contains('siri-dock-active'));
  if (document.body.classList.contains('siri-dock-active') && fsm.state === 'hidden') fsm.enterOrb();
  window.addEventListener('pagehide', () => { standbyObserver.disconnect(); setStandbyMode(false); }, { once: true });

  // ===== Argon (Damar Notch) character rendering di dalam notch =====
  // Sumber: design/prototype/notch-buddy.html (aset & engine disetujui Owner),
  // dipotong ke ui-prototypes/w5/argon-character-engine.js. Emote mengikuti
  // state island; orb standby memakai drawOrbStandby60fps.
  const orbCanvas = document.getElementById('siriGlCanvas');
  // Damar Notch character (damar-notch-character.js, rig v4): two rig views
  // (compact head + expanded stage) sharing one state - per-part spring rig,
  // real blink/gaze, gestures, lip-sync - bound to the same Core events as
  // notchPhysics below.
  const dnc = typeof window.DamarNotchCharacter !== 'undefined' ? window.DamarNotchCharacter.create({
    isVisible: () => fsm.state === 'compact' || fsm.state === 'morph' || fsm.state === 'expanded',
    reducedMotion: () => document.body.classList.contains('degraded') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }) : null;
  if (dnc) {
    dnc.attach(island.querySelector('[data-dnc="head"]'));
    dnc.attach(island.querySelector('[data-dnc="stage"]'));
    dnc.start();
    dnc.greet();
    head.addEventListener('pointermove', e => { const r = head.getBoundingClientRect(); dnc.setGaze((e.clientX - (r.left + r.width / 2)) / Math.max(1, r.width / 2), (e.clientY - (r.top + r.height / 2)) / Math.max(1, r.height / 2)); });
    head.addEventListener('pointerenter', () => dnc.setHover(true));
    head.addEventListener('pointerleave', () => { dnc.setHover(false); dnc.setGaze(0, 0); });
    head.addEventListener('pointerdown', () => dnc.poke());
  }
  let argonRaf = 0, argonStart = performance.now();
  function emoteForState(state) {
    if (state === 'orb') return 'orbStandby';
    if (state === 'morph') return 'siaga';
    if (state === 'expanded') return 'senang';
    return 'siaga';
  }
  function argonFrame(now) {
    const t = (now - argonStart) / 1000;
    try {
      if (typeof window.drawDamarNotch60fps === 'function') {
        if (fsm.state === 'orb' && orbCanvas) {
          const octx = orbCanvas.getContext('2d');
          octx.save();
          octx.clearRect(0, 0, orbCanvas.width, orbCanvas.height);
          octx.translate(orbCanvas.width / 2, orbCanvas.height / 2);
          window.drawOrbStandby60fps(octx, t);
          octx.restore();
        }
        // The layered character renders itself from its own loop; only the
        // orb standby (separate WebGL-style canvas) is drawn here.
      }
    } catch {}
    argonRaf = requestAnimationFrame(argonFrame);
  }
  if (typeof window.drawDamarNotch60fps === 'function') {
    argonRaf = requestAnimationFrame(argonFrame);
    window.addEventListener('pagehide', () => cancelAnimationFrame(argonRaf), { once: true });
  }

  // Coucou-parity attention: a new pending permission peeks the notch out (compact; never auto-expands, no timer).
  // Allow is offered only when Core says the request is fully shown here (file write/edit with name + diff counts);
  // anything else is Deny or "Answer in CLI". Decisions go through main (Owner credential), never from this page.
  let lastPending = 0, permission = null, statusText = '';
  const T = (k, ...a) => window.DAMAR_I18N?.t(k, ...a) ?? k;
  const btn = a => island.querySelector(`[data-action="${a}"]`);
  function renderLabels() { island.querySelectorAll('[data-t]').forEach(b => { b.textContent = T(b.dataset.t); }); island.querySelector('.di-mic').setAttribute('aria-label', T('micOn')); }
  function renderStatus() {
    const el = island.querySelector('.di-status');
    if (!permission) { el.textContent = statusText; return; }
    const p = permission;
    el.textContent = p.allowable ? (p.tool === 'workspace_edit' ? T('permEdit', p.file, p.added, p.removed) : T('permWrite', p.file, p.added, p.removed)) : T('permOther', T('tool', p.tool));
  }
  window.addEventListener('damar-presence-attention', e => {
    const pending = Number(e.detail?.pendingPermissions) || 0;
    permission = e.detail?.permission || null;
    btn('allow-once').hidden = btn('allow-session').hidden = !(permission && permission.allowable);
    btn('deny').hidden = !permission;
    // While a request waits, the row is the decision (Deny always; Allow only when fully shown). The CLI that owns
    // the turn still shows its own card; the first answer from either surface wins.
    btn('presence').hidden = btn('dashboard').hidden = !!permission;
    island.dataset.attention = pending > 0 ? 'permission' : '';
    if (typeof notchPhysics !== 'undefined' && pending > 0) notchPhysics.emote = 'siaga';
    sig.pending = pending;
    if (dnc && pending > 0) dnc.setEmote('siaga');
    if (pending > lastPending && fsm.state === 'hidden' && orbPhaseDone && notchEnabled && !voiceActive) fsm.reveal();
    lastPending = pending; renderStatus();
  });
  // Live activity ticker (Core GET /api/r9/activity, redacted) + finished-turn emote.
  window.addEventListener('damar-presence-activity', e => {
    const a = e.detail; if (!a) return;
    if (typeof notchPhysics !== 'undefined') {
      if (a.kind === 'final' && a.status === 'COMPLETED') { notchPhysics.emote = 'senang'; notchPhysics.isDancing = true; setTimeout(() => { notchPhysics.isDancing = false; }, 1600); }
      else if (a.kind === 'final') notchPhysics.emote = 'pulih';
      else if (['read', 'edit', 'run', 'shell'].includes(a.kind) || (a.kind === 'discussion' && a.state === 'RUNNING')) notchPhysics.emote = 'berpikir';
      else if (a.kind === 'discussion') notchPhysics.emote = a.state === 'COMPLETED' ? 'senang' : 'pulih';
      else if (a.kind === 'alert') notchPhysics.emote = 'siaga';
    }
    if (a.kind === 'final' && a.status === 'COMPLETED') sig.lastFinalAt = Date.now();
    else if (a.kind === 'final') sig.lastFailAt = Date.now();
    else if (['read', 'edit', 'run', 'shell'].includes(a.kind) || a.kind === 'discussion') sig.workUntil = Date.now() + 6000;
    if (a.kind === 'alert') { sig.alertUntil = Date.now() + 8000; if (a.source === 'mata-dewa') sig.matadewaUntil = Date.now() + 90000; }
    if (dnc) {
      if (a.kind === 'final' && a.status === 'COMPLETED') { dnc.setEmote('senang'); dnc.celebrate(); }
      else if (a.kind === 'final') dnc.setEmote('pulih');
      else if (['read', 'edit', 'run', 'shell'].includes(a.kind) || (a.kind === 'discussion' && a.state === 'RUNNING')) dnc.setEmote('berpikir');
      else if (a.kind === 'discussion') dnc.setEmote(a.state === 'COMPLETED' ? 'senang' : 'pulih');
      else if (a.kind === 'alert') dnc.setEmote('siaga');
    }
    // A watchlist alert peeks the notch out like a permission request (compact only; never auto-expands, no timer).
    if (a.kind === 'alert' && fsm.state === 'hidden' && orbPhaseDone && notchEnabled && !voiceActive) fsm.reveal();
    window.dispatchEvent(new CustomEvent('damar-presence-motion-pulse'));
  });
  // Session pills + now-playing (Fase 3 last mile): rendered from the Core
  // projection the adapter forwards - Core session registry and the SMTC
  // sense, never surface-local state, so CLI/headless work appears here.
  const pillsEl = island.querySelector('.di-pills');
  window.addEventListener('damar-presence-sessions', e => {
    const pills = Array.isArray(e.detail) ? e.detail : [];
    sig.sessionsWorking = pills.filter(p => p.state === 'WORKING').length;
    pillsEl.hidden = pills.length === 0;
    pillsEl.innerHTML = pills.map(p => '<span class="di-pill" data-state="' + p.state + '">' + String(p.label || 'CLI session').replace(/[<>&"]/g, '') + (p.openOperations ? ' - ' + p.openOperations : '') + '</span>').join('');
  });
  const mediaEl = island.querySelector('.di-media');
  const mediaText = island.querySelector('.di-media-text');
  const mediaToggle = island.querySelector('[data-media="toggle"]');
  window.addEventListener('damar-presence-media', e => {
    const m = e.detail;
    sig.mediaPlaying = !!(m && m.playing);
    mediaEl.hidden = !m;
    if (m) {
      mediaText.textContent = (m.title || 'Unknown') + (m.artist ? ' - ' + m.artist : '');
      mediaToggle.innerHTML = m.playing ? '&#10073;&#10073;' : '&#9654;';
      mediaToggle.dataset.action2 = m.playing ? 'pause' : 'play';
    }
  });
  mediaEl.addEventListener('click', e => {
    const b = e.target.closest('[data-media]'); if (!b) return;
    const action = b.dataset.media === 'toggle' ? (b.dataset.action2 || 'play') : b.dataset.media;
    window.damarDesktop?.mediaControl?.(action);
  });
  // Behavior engine driver (Fase 2 v3): every 1.2 s the island folds its
  // Core-event memory + PC activity into signals and lets the engine pick
  // the character's emote/costume. The direct event->emote calls above stay
  // as the low-latency path; the engine owns costumes, context and idle.
  const sig = { pending: 0, lastFinalAt: 0, lastFailAt: 0, workUntil: 0, alertUntil: 0, matadewaUntil: 0, mediaPlaying: false, sessionsWorking: 0, pc: null };
  let behaviorPrev = null;
  window.addEventListener('damar-presence-behavior', e => { sig.pc = e.detail?.pcActivity || null; });
  // The Owner page's real voice state: damarIsSpeaking flips with the actual
  // TTS utterance (speakWithOrbReactivity) - the same signal presence-adapter
  // polls to end voice conversations. Read as a bare global, like the adapter.
  const coreSpeaking = () => { try { return typeof damarIsSpeaking !== 'undefined' && !!damarIsSpeaking; } catch { return false; } };
  setInterval(() => {
    if (!dnc || typeof window.DamarNotchBehavior === 'undefined') return;
    const now = Date.now();
    const d = window.DamarNotchBehavior.decideBehavior({
      alertActive: now < sig.alertUntil,
      pendingApprovals: sig.pending,
      recentFailure: now - sig.lastFailAt < 20000,
      recentCompletion: now - sig.lastFinalAt < 4000,
      missionActive: now < sig.workUntil || sig.sessionsWorking > 0,
      mediaPlaying: sig.mediaPlaying,
      matadewaMode: now < sig.matadewaUntil,
      speaking: coreSpeaking(),
      pc: sig.pc,
    }, behaviorPrev, now);
    // Gestures and the talk channel apply EVERY tick (idempotent setters):
    // point holds while an alert/approval decision stands, wave ends when
    // the completion decision ends, the mouth follows the talk decision.
    dnc.setGesture(d.gesture || null);
    dnc.setSpeaking(!!d.talk);
    if (d.changed) {
      behaviorPrev = { emote: d.emote, costume: d.costume, since: now };
      if (d.celebrate) dnc.celebrate();
      dnc.setEmote(d.emote);
      dnc.setCostume(d.costume);
    }
  }, 1200);
  // Lip-sync fast path (90 ms): the 1.2 s engine tick is too coarse for a
  // mouth. Speaking state mirrors the engine's talk rule from the same
  // island signal memory; the envelope comes from the page's voiceAmp,
  // which the TTS onboundary handler pulses to 1.0 on every real word
  // boundary (it decays in the page render loop). No boundary pulses ->
  // the rig's documented steady-envelope fallback takes over.
  setInterval(() => {
    if (!dnc) return;
    const now = Date.now();
    const talkNow = coreSpeaking() && !(now < sig.alertUntil) && !(sig.pending > 0);
    dnc.setSpeaking(talkNow);
    if (talkNow) {
      try {
        if (typeof voiceAmp === 'number' && Number.isFinite(voiceAmp)) dnc.setSpeechLevel(Math.max(0, Math.min(1, voiceAmp)));
      } catch {}
    }
  }, 90);
  window.addEventListener('damar-presence-mic', e => { island.dataset.mic = e.detail ? 'on' : 'off'; });
  window.addEventListener('damar-presence-lang', () => { renderLabels(); renderStatus(); });
  renderLabels();
  window.addEventListener('damar-presence-status', e => { if (typeof e.detail === 'string') { statusText = e.detail; renderStatus(); } });
  window.__DAMAR_ISLAND__ = Object.freeze({
    fsm, configure, voiceStart, voiceEnd, isVoiceActive: () => voiceActive, reveal: () => fsm.reveal(), hide: () => fsm.hide(), getState: () => fsm.state,
    enterOrb: () => fsm.enterOrb(), wakeFromOrb: () => fsm.wakeFromOrb(), dismiss: () => fsm.dismiss()
  });
})();
