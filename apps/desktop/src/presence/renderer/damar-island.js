'use strict';
/* DAMAR Presence product port of C/scripts/preview-adapters/damar-island.js
 * (sha256 399c148c771a47fb9524714430baae31771fd977ffba81bdd2cfaea57dc3d2a7).
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
    /* SIZE pass (Owner 2026-11-25 13:49 WIB: "ukuran notchnya samain Coucou
       aja, bener-bener copas, cuma karakternya aja yang diganti"): the island
       box now carries Coucou's exact layout numbers (windows/src/core/
       layout.ts). Hidden retracts into the top edge as the 184x0 notch core
       (NOTCH_W x 0); morph is that same 184 core at bar height; compact is
       the 288x32 bar (184 + 104, radius 14); expanded is 640 wide, radius
       22, with per-view heights (greeting 150, everything else 160 - the
       inside layout puts body content beside the stage, so Damar needs
       none of Coucou's taller view heights; see the mapping note at
       expandedView()). The character lives INSIDE the island in every
       state (Owner correction 13:56 WIB - the PERCH apron is superseded).
       NOCHAR pass (Owner 2026-11-25 14:49 WIB: "Hapus aja karakternya"):
       the character is REMOVED from the island - nothing is rendered for
       it and no character factory is auto-attached. EMPTY-SLOT correction
       (Owner 17:13/17:14 WIB: "Cuma bedanya ini karakternya kosong"): the
       layout keeps Coucou's character zones exactly - the in-bar mini
       position, the expanded left stage column, the greeting center
       stage - as a BLANK drop-in slot (see DamarNotchSlot below): no
       placeholder, no substitute graphic; the Owner's own character,
       which he is building himself, mounts there later through the slot
       contract without any layout rework.
       Coucou's fixed 720x320 panel
       is their window frame; Damar's window is the fullscreen Presence
       surface, and every island footprint here fits inside that same
       720x320 top-center region. The width/height CSS transition below
       animates every resize, so state and view changes never jump. */
    #damarIsland { position:fixed; z-index:2147483000; top:0; left:50%; transform:translateX(-50%) translateY(0); width:184px; height:0; overflow:hidden; border:0; border-radius:0 0 14px 14px; background:#08080c; color:#f5f6f8; box-shadow:0 10px 34px rgba(0,0,0,.5); font:500 13px/1.35 'Segoe UI',sans-serif; transition:width .26s cubic-bezier(.16,1,.3,1),height .26s cubic-bezier(.16,1,.3,1),border-radius .26s ease,transform .3s cubic-bezier(.16,1,.3,1),opacity .22s ease; opacity:0; pointer-events:none; }
    #damarIsland[data-state="hidden"] { width:184px; height:0; opacity:0; pointer-events:none; }
    #damarIsland[data-state="orb"] { width:184px; height:0; opacity:0; pointer-events:none; }
    #damarIsland[data-state="morph"] { width:184px; height:32px; border-radius:0 0 14px 14px; opacity:.92; pointer-events:auto; }
    #damarIsland[data-state="compact"] { width:288px; height:32px; border-radius:0 0 14px 14px; opacity:1; pointer-events:auto; }
    #damarIsland[data-state="expanded"] { width:min(640px,calc(100vw - 24px)); height:160px; border-radius:0 0 22px 22px; opacity:1; pointer-events:auto; }
    #damarIsland[data-state="expanded"][data-view="greeting"] { height:150px; }
    #damarIsland .di-head { height:32px; display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; }
    /* EMPTY-SLOT layout (Owner 2026-11-25 17:13 WIB): expanded keeps
       Coucou's two zones - the character's stage zone overlaid at the
       card's left (their expanded botX 52-76 analog: a 108 px zone whose
       center, x=64, sits in that range) and the card content indented
       past it. The stage zone is the drop-in slot: present in the
       geometry, rendered EMPTY while no character is registered; card
       content never reflows into it. The head row carries the mini slot
       at Coucou's compact mini position (slot center at (40,16) in
       morph/compact: the head is left-aligned with padding-left:26px
       around the 28x28 slot); in expanded the stage zone is the mount,
       so the head slot retires (visibility:hidden - both mounts live
       would duplicate it). */
    #damarIsland .di-head { grid-area:head; }
    #damarIsland .di-stage { grid-area:stage; }
    #damarIsland .di-body { grid-area:body; }
    #damarIsland .di-stage { display:none; }
    #damarIsland .di-slot { display:block; position:relative; }
    #damarIsland .di-stage .di-slot { position:absolute; inset:0; }
    #damarIsland .di-head .di-slot { width:52px; height:32px; flex:none; }
    #damarIsland[data-state="expanded"] .di-head .di-slot { visibility:hidden; }
    #damarIsland[data-state="morph"] .di-head, #damarIsland[data-state="compact"] .di-head { justify-content:flex-start; padding-left:26px; }
    #damarIsland[data-state="morph"] .di-head .di-slot, #damarIsland[data-state="compact"] .di-head .di-slot { width:28px; height:28px; }
    /* CLONE layout anatomy (Coucou botPosition, Owner 2026-11-25 14:57 WIB
       - the notch is a for-now clone of Coucou's system, named Damar
       Notch): 8 px top inset + 34 px header row, so body content starts
       at y=42.
       CSS-FIDELITY pass (Owner 2026-11-25 18:52 WIB - "isi dan css beda
       banget sama coucou, buat persis mirip"): the expanded layout now
       carries Coucou's actual CSS system (windows/src/style.css). Shell
       padding 8px 10px 10px; THE CARD fills the whole content area below
       the header (background #141518, border-radius 20px, border 1px
       solid rgba(255,255,255,.035), height 100%); the character stage is
       an overlay zone ON the card at Coucou's bot placement (left = the
       10 px shell pad, top 42 = 8 + 34 header, width 108, bottom = the
       10 px shell pad); card content pads left 108px past that zone and
       runs to the card's right edge - no dead black half, no content
       rendered directly on the island black anymore. */
    #damarIsland[data-state="expanded"] { display:grid; box-sizing:border-box; padding:8px 10px 10px; grid-template-rows:34px 1fr; grid-template-columns:1fr; grid-template-areas:"head" "body"; align-content:start; }
    #damarIsland[data-state="expanded"] .di-head { height:34px; }
    #damarIsland[data-state="expanded"] .di-stage { display:block; position:absolute; z-index:2; left:10px; top:42px; bottom:10px; width:108px; }
    #damarIsland .di-body { display:none; }
    #damarIsland[data-state="expanded"] .di-body { position:relative; z-index:1; height:100%; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; gap:4px; background:#141518; border:1px solid rgba(255,255,255,.035); border-radius:20px; padding:6px 16px 6px 108px; overflow:hidden; }
    #damarIsland[data-state="expanded"][data-view="permission"] { height:200px; }
    /* Greeting view (640x150): the stage zone centers ON the card (their
       greeting botX 320 / botY ~90 analog: the card spans y 42..140, so
       the stage centers at island (320, 91)) and the card shows only its
       status line, centered at the bottom, while the greeting holds. */
    #damarIsland[data-state="expanded"][data-view="greeting"] .di-stage { left:50%; transform:translateX(-50%); width:220px; }
    #damarIsland[data-state="expanded"][data-view="greeting"] .di-body { justify-content:flex-end; align-items:center; padding-left:16px; }
    #damarIsland[data-state="expanded"][data-view="greeting"] .di-pills, #damarIsland[data-state="expanded"][data-view="greeting"] .di-media, #damarIsland[data-state="expanded"][data-view="greeting"] .di-controls { display:none; }
    #damarIsland .di-status { margin:0; color:#f5f6f8; font-size:13px; font-weight:500; line-height:22px; min-height:22px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #damarIsland[data-attention="permission"] .di-status { font-size:15px; font-weight:600; }
    #damarIsland .di-mic { display:none; width:7px; height:7px; border-radius:50%; background:#e5c158; box-shadow:0 0 6px #e5c158; }
    #damarIsland[data-mic="on"] .di-mic { display:inline-block; }
    /* Coucou pill system (style.css): activity pills are 28 px tall,
       radius 999, card-flat #0e0f11 with a rgba(255,255,255,.14) border;
       buttons are pill-shaped (500 12.5px, padding 7px 13px, radius
       999, action-row gap 8px) - primary #f5f6f8 on #0b0c0e, secondary
       rgba(255,255,255,.09) on #f1f2f4. Deny keeps the secondary surface
       with Coucou's red detail text #ff8d97. The [hidden] guards below
       are load-bearing: a display:flex row would otherwise override the
       hidden attribute (the old media-row bug). */
    #damarIsland .di-pills { display:flex; gap:6px; flex-wrap:nowrap; max-height:28px; overflow:hidden; }
    #damarIsland .di-pills[hidden] { display:none; }
    #damarIsland .di-pill { height:28px; display:inline-flex; align-items:center; font-size:12px; font-weight:500; letter-spacing:.02em; color:#f5f6f8; background:#0e0f11; border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:0 11px; white-space:nowrap; min-width:0; flex:0 1 auto; }
    #damarIsland .di-pill-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #damarIsland .di-pill-more { flex:none; }
    #damarIsland .di-pill[data-state="WORKING"] { border-color:rgba(255,255,255,.38); }
    #damarIsland .di-pill[data-state="CLOSED"] { opacity:.45; }
    /* Dense stack: with a live media session AND session pills in the
       160 px default view, the Coucou-sized stack no longer fits; the
       pills (whose counts the status line already carries) yield until
       the media session clears. The 200 px permission view fits all. */
    #damarIsland[data-dense="media"] .di-pills { display:none; }
    /* Generic now-playing (Owner 2026-11-25 18:53 WIB): whatever the OS
       media session reports - title, subtitle (artist OR channel /
       uploader), source app, play state, the transport actions Core
       supports. No music-only fields or assumptions: a YouTube video
       renders exactly like a song. */
    #damarIsland .di-media { display:flex; align-items:center; gap:10px; }
    #damarIsland .di-media[hidden] { display:none; }
    #damarIsland .di-media-info { display:flex; flex-direction:column; min-width:0; flex:1; }
    #damarIsland .di-media-title { font-size:15px; font-weight:600; color:#f5f6f8; line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #damarIsland .di-media-sub { font-size:13px; font-weight:400; color:#9398a1; line-height:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #damarIsland .di-media-actions { display:flex; gap:8px; flex:none; }
    #damarIsland .di-media button { padding:7px 10px; }
    #damarIsland .di-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    #damarIsland button { border:1px solid transparent; border-radius:999px; padding:7px 13px; background:rgba(255,255,255,.09); color:#f1f2f4; font:500 12.5px/1.25 'Segoe UI',sans-serif; cursor:pointer; }
    #damarIsland button[data-action="allow-once"], #damarIsland button[data-action="presence"] { background:#f5f6f8; color:#0b0c0e; }
    #damarIsland button[data-action="deny"] { color:#ff8d97; }
    #damarIsland button:focus-visible { outline:2px solid #f5f6f8; outline-offset:2px; }
    #damarIslandWake { position:fixed; z-index:2147482999; top:0; left:50%; transform:translateX(-50%); width:240px; height:6px; pointer-events:none; }
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
  island.id = 'damarIsland'; island.dataset.state = 'hidden'; island.setAttribute('aria-label','Damar Notch');
  island.innerHTML = `<div class="di-head" role="button" tabindex="0" aria-label="Damar Notch"><div class="di-slot" data-slot="mini" aria-hidden="true"></div><span class="di-mic" role="img" aria-label="Microphone on"></span></div><div class="di-stage"><div class="di-slot" data-slot="stage" aria-hidden="true"></div></div><div class="di-body"><p class="di-status" role="status" aria-live="polite">DAMAR Core not connected</p><div class="di-pills" hidden></div><div class="di-media" hidden><div class="di-media-info"><span class="di-media-title"></span><span class="di-media-sub"></span></div><div class="di-media-actions"><button type="button" data-media="previous" aria-label="Previous">&lt;&lt;</button><button type="button" data-media="toggle" aria-label="Play or pause">&#9654;</button><button type="button" data-media="next" aria-label="Next">&gt;&gt;</button></div></div><div class="di-controls"><button type="button" data-action="presence" data-t="returnPresence">Return to Presence</button><button type="button" data-action="dashboard" data-t="dashboard">Control</button><button type="button" data-action="allow-once" data-t="allowOnce" hidden>Allow once</button><button type="button" data-action="allow-session" data-t="allowSession" hidden>Allow for session</button><button type="button" data-action="deny" data-t="deny" hidden>Deny</button></div></div>`;
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
  // Expanded per-view sizing (SIZE pass + CLONE mapping, Owner 2026-11-25
  // 14:57 WIB): the box height follows Coucou's per-view heights, mapped
  // to Damar's own content types. The greeting view (640x150) holds
  // briefly after the expanded entry; default content (status, session
  // pills, media card, activity, error/finished status) is the standard
  // 640x160; a pending permission/question - the view that presents
  // option rows (Allow once / Allow for session / Deny) - takes Coucou's
  // QUESTION_PICKER_H, 640x200. Coucou's chat/prompt growth (240 + 40 per
  // row, capped 300) has no Damar island analog yet; this per-view hook
  // is where it slots in. Coucou's remaining taller heights (176/184/240/
  // 248) belong to views Damar does not have (upload, mail, recap,
  // whatsNew). Reads state only, so it is safe to call from any handler.
  let greetingViewUntil = 0, viewTimer = 0;
  function expandedView() {
    if (fsm.state !== 'expanded') return 'default';
    if (Date.now() < greetingViewUntil) return 'greeting';
    if (permission) return 'permission';
    return 'default';
  }
  function syncIslandView() { island.dataset.view = expandedView(); }
  function render(from, to) {
    island.dataset.state = to;
    island.setAttribute('aria-expanded', String(to === 'expanded'));
    syncOrbMorph(to);
    assertNoCoexistence(to);
    if (to === 'expanded') {
      setClickThrough(false);
      greetingViewUntil = Date.now() + 2100; // the greeting view holds ~2 s
      clearTimeout(viewTimer);
      viewTimer = setTimeout(syncIslandView, 2150);
    }
    syncIslandView();
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
      // Hover wake: pointer ke strip bangun Coucou (240x6 di tepi atas) saat
      // hidden (auto-hidden) -> compact lagi.
      if (island.dataset.state === 'hidden' && y <= 6 && Math.abs(x - innerWidth / 2) <= 120) {
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
      // The mounted character stamps the decision (its DISETUJUI / DITOLAK
      // seal states) at click time; the decision itself still round-trips
      // through decidePermission, unchanged.
      slot.invoke('reactDecision', action === 'deny' ? 'deny' : 'approve');
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

  // ===== Orb standby drawing (Idle Presence) =====
  // The standby orb is drawn by the Argon engine (argon-character-engine.js,
  // design/prototype/notch-buddy.html lineage) on its own canvas below.
  // NOCHAR (Owner 2026-11-25 14:49 WIB): the notch island itself ships
  // with NO character - nothing is auto-attached; the character lives
  // only through the drop-in slot defined further below.
  const orbCanvas = document.getElementById('siriGlCanvas');
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

  // ===== Damar Notch character slot (drop-in mount) =====
  // EMPTY-SLOT contract (Owner 2026-11-25 17:13/17:14 WIB): the island
  // ships with NO character. The two slot containers in the island DOM
  // are the mount points at Coucou's character placement - "mini" in the
  // bar head (morph/compact) and "stage" in the expanded left column /
  // greeting center zone. A character module drops in by calling
  // window.DamarNotchSlot.register(factory), where factory follows the
  // repo's character factory pattern: factory.create({ isVisible,
  // reducedMotion }) returns an instance with attach(el) (called once
  // per slot container), start(), optional destroy(), and the emote /
  // gesture API (setEmote, setGesture, setSpeaking, setSpeechLevel,
  // setCostume, celebrate, poke, setGaze, setHover, playIntro, playGreet,
  // reactQuestion, reactError, setMediaPlaying). Every character-facing
  // call in this file routes through slot.invoke(...), which no-ops
  // safely while no character is registered; unregister() empties the
  // containers again. The legacy character modules in this directory are
  // NEVER auto-attached - registration is the only way in.
  const slotContainers = { mini: island.querySelector('[data-slot="mini"]'), stage: island.querySelector('[data-slot="stage"]') };
  let slotCharacter = null;
  const slot = {
    register(factory) {
      if (!factory || typeof factory.create !== 'function') return false;
      slot.unregister();
      let inst = null;
      try {
        inst = factory.create({
          isVisible: () => fsm.state === 'compact' || fsm.state === 'morph' || fsm.state === 'expanded',
          reducedMotion: () => document.body.classList.contains('degraded') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
        });
      } catch { return false; }
      if (!inst) return false;
      slotCharacter = inst;
      try {
        if (typeof inst.attach === 'function') { inst.attach(slotContainers.mini); inst.attach(slotContainers.stage); }
        if (typeof inst.start === 'function') inst.start();
        if (typeof inst.greet === 'function') inst.greet();
      } catch {}
      island.dataset.character = 'mounted';
      return true;
    },
    unregister() {
      if (!slotCharacter) return;
      try { slotCharacter.destroy?.(); } catch {}
      slotCharacter = null;
      slotContainers.mini.innerHTML = '';
      slotContainers.stage.innerHTML = '';
      delete island.dataset.character;
    },
    invoke(method, ...args) {
      const c = slotCharacter;
      if (c && typeof c[method] === 'function') { try { c[method](...args); } catch {} }
    },
    isMounted: () => !!slotCharacter,
  };
  window.DamarNotchSlot = Object.freeze({
    register: factory => slot.register(factory),
    unregister: () => slot.unregister(),
    isMounted: () => slot.isMounted(),
    containers: slotContainers,
  });
  // Character attention wiring (Coucou parity): gaze follows the pointer
  // over the head and across the window, hover/poke land on the head and
  // the stage zone, and island state changes fire the intro/greet hooks.
  // All of it routes through the slot - with no character mounted these
  // listeners are inert.
  head.addEventListener('pointermove', e => { const r = head.getBoundingClientRect(); slot.invoke('setGaze', (e.clientX - (r.left + r.width / 2)) / Math.max(1, r.width / 2), (e.clientY - (r.top + r.height / 2)) / Math.max(1, r.height / 2)); });
  head.addEventListener('pointerenter', () => slot.invoke('setHover', true));
  head.addEventListener('pointerleave', () => { slot.invoke('setHover', false); slot.invoke('setGaze', 0, 0); });
  head.addEventListener('pointerdown', () => slot.invoke('poke'));
  document.addEventListener('mousemove', e => {
    if (!slot.isMounted()) return;
    if (e.target && e.target.closest && e.target.closest('.di-head')) return;
    const r = island.getBoundingClientRect();
    slot.invoke('setGaze', (e.clientX - (r.left + r.width / 2)) / 340, (e.clientY - (r.top + r.height / 2)) / 260);
  }, { passive: true });
  const stageEl = island.querySelector('.di-stage');
  if (stageEl) {
    stageEl.addEventListener('pointerenter', () => slot.invoke('setHover', true));
    stageEl.addEventListener('pointerleave', () => slot.invoke('setHover', false));
    stageEl.addEventListener('pointerdown', () => slot.invoke('poke'));
  }
  window.addEventListener('damar-island-state', e => {
    const { from, to } = e.detail || {};
    if ((to === 'morph' || to === 'compact') && !NOTCH_STATES.has(from)) slot.invoke('playIntro');
    else if (to === 'expanded' && from !== 'expanded') slot.invoke('playGreet');
  });
  // Signal memory feeding the behavior engine (below): Core-event state
  // the engine folds every 1.2 s. It exists independently of the slot;
  // with no character mounted it simply accumulates, unused.
  const sig = { pending: 0, lastFinalAt: 0, lastFailAt: 0, workUntil: 0, alertUntil: 0, matadewaUntil: 0, mediaPlaying: false, sessionsWorking: 0, pc: null };
  let behaviorPrev = null;

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
    if (pending > 0) slot.invoke('setEmote', 'siaga');
    // A NEW waiting request gets the question reaction (blink + head tilt on a mounted character).
    if (pending > lastPending) slot.invoke('reactQuestion');
    if (pending > lastPending && fsm.state === 'hidden' && orbPhaseDone && notchEnabled && !voiceActive) fsm.reveal();
    lastPending = pending; renderStatus(); syncDense(); syncIslandView();
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
    if (a.kind === 'final' && a.status === 'COMPLETED') { slot.invoke('setEmote', 'senang'); slot.invoke('celebrate'); }
    else if (a.kind === 'final') { slot.invoke('setEmote', 'pulih'); slot.invoke('reactError'); }
    else if (['read', 'edit', 'run', 'shell'].includes(a.kind) || (a.kind === 'discussion' && a.state === 'RUNNING')) slot.invoke('setEmote', 'berpikir');
    else if (a.kind === 'discussion') slot.invoke('setEmote', a.state === 'COMPLETED' ? 'senang' : 'pulih');
    else if (a.kind === 'alert') slot.invoke('setEmote', 'siaga');
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
    pillCount = pills.length;
    pillsEl.hidden = pills.length === 0;
    const shownPills = pills.slice(0, 4);
    pillsEl.innerHTML = shownPills.map(p => '<span class="di-pill" data-state="' + p.state + '"><span class="di-pill-label">' + String(p.label || 'CLI session').replace(/[<>&"]/g, '') + '</span>' + (p.openOperations ? ' - ' + p.openOperations : '') + '</span>').join('') + (pills.length > shownPills.length ? '<span class="di-pill di-pill-more">+' + (pills.length - shownPills.length) + '</span>' : '');
    syncDense();
    syncIslandView();
  });
  const mediaEl = island.querySelector('.di-media');
  const mediaTitle = island.querySelector('.di-media-title');
  const mediaSub = island.querySelector('.di-media-sub');
  const mediaToggle = island.querySelector('[data-media="toggle"]');
  let pillCount = 0;
  let mediaPresent = false;
  function syncDense() { island.dataset.dense = (!permission && mediaPresent && pillCount > 0) ? 'media' : ''; }
  window.addEventListener('damar-presence-media', e => {
    const m = e.detail;
    mediaPresent = !!m;
    sig.mediaPlaying = !!(m && m.playing);
    // A mounted character bounces along while the widget plays (real SMTC signal, via the slot).
    slot.invoke('setMediaPlaying', sig.mediaPlaying);
    mediaEl.hidden = !m;
    if (m) {
      // Generic now-playing (Owner 2026-11-25 18:53 WIB): the projection
      // already forwards the full SMTC shape - title, artist (a song's
      // artist OR a video's channel/uploader), sourceApp, status. Render
      // exactly that; the source app label only loses its .exe suffix.
      mediaTitle.textContent = m.title || 'Unknown';
      const app = String(m.sourceApp || '').replace(/\.exe$/i, '');
      mediaSub.textContent = [m.artist, app].filter(Boolean).join(' · ');
      mediaEl.dataset.playing = m.playing ? 'true' : 'false';
      mediaToggle.innerHTML = m.playing ? '&#10073;&#10073;' : '&#9654;';
      mediaToggle.dataset.action2 = m.playing ? 'pause' : 'play';
    }
    syncDense();
    syncIslandView();
  });
  mediaEl.addEventListener('click', e => {
    const b = e.target.closest('[data-media]'); if (!b) return;
    const action = b.dataset.media === 'toggle' ? (b.dataset.action2 || 'play') : b.dataset.media;
    window.damarDesktop?.mediaControl?.(action);
  });
  // Behavior engine driver (Fase 2 v3): every 1.2 s the island folds its
  // Core-event signal memory + PC activity into signals and lets the
  // engine pick the character's emote/costume. EMPTY-SLOT: the driver and
  // the 90 ms lip-sync fast path route every character call through the
  // slot; with no character registered the tick exits immediately and
  // every invoke no-ops, so the empty notch costs nothing. The event
  // handlers above keep their island duties regardless: peek reveals,
  // session pills, the media widget and the permission state.
  const coreSpeaking = () => { try { return typeof damarIsSpeaking !== 'undefined' && !!damarIsSpeaking; } catch { return false; } };
  setInterval(() => {
    if (!slot.isMounted() || typeof window.DamarNotchBehavior === 'undefined') return;
    const now = Date.now();
    const d = window.DamarNotchBehavior.decideBehavior({
      pendingPermissions: sig.pending,
      alertActive: now < sig.alertUntil,
      mataDewaActive: now < sig.matadewaUntil,
      speaking: coreSpeaking(),
      mediaPlaying: sig.mediaPlaying,
      working: now < sig.workUntil || sig.sessionsWorking > 0,
      justFinished: now - sig.lastFinalAt < 9000,
      justFailed: now - sig.lastFailAt < 9000,
      pc: sig.pc,
    }, behaviorPrev, now);
    slot.invoke('setGesture', d.gesture || null);
    slot.invoke('setSpeaking', !!d.talk);
    if (d.changed) {
      behaviorPrev = { emote: d.emote, costume: d.costume, since: now };
      if (d.celebrate) slot.invoke('celebrate');
      slot.invoke('setEmote', d.emote);
      slot.invoke('setCostume', d.costume);
    }
  }, 1200);
  // Lip-sync fast path: while Damar speaks, the mouth follows the LIVE
  // speech state (page-global damarIsSpeaking) + voice amplitude at 90 ms
  // - the 1.2 s behavior tick is too coarse for mouth flaps. Attention and
  // a waiting approval suppress the talk pose. Slot-routed like the rest.
  setInterval(() => {
    if (!slot.isMounted()) return;
    const now = Date.now();
    const talkNow = coreSpeaking() && !(now < sig.alertUntil) && !(sig.pending > 0);
    slot.invoke('setSpeaking', talkNow);
    if (talkNow) { try { if (typeof voiceAmp === 'number' && Number.isFinite(voiceAmp)) slot.invoke('setSpeechLevel', Math.max(0, Math.min(1, voiceAmp))); } catch {} }
  }, 90);
  window.addEventListener('damar-presence-behavior', e => { sig.pc = e.detail?.pcActivity || null; });
  window.addEventListener('damar-presence-mic', e => { island.dataset.mic = e.detail ? 'on' : 'off'; });
  window.addEventListener('damar-presence-lang', () => { renderLabels(); renderStatus(); });
  renderLabels();
  window.addEventListener('damar-presence-status', e => { if (typeof e.detail === 'string') { statusText = e.detail; renderStatus(); } });
  window.__DAMAR_ISLAND__ = Object.freeze({
    fsm, configure, voiceStart, voiceEnd, isVoiceActive: () => voiceActive, reveal: () => fsm.reveal(), hide: () => fsm.hide(), getState: () => fsm.state,
    enterOrb: () => fsm.enterOrb(), wakeFromOrb: () => fsm.wakeFromOrb(), dismiss: () => fsm.dismiss(),
    slot: window.DamarNotchSlot
  });
})();
