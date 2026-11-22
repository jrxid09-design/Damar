'use strict';
/* DAMAR-only Electron adaptation of Coucou's generic Island lifecycle.
 * Owner directives (pre-production):
 * 1. Notch = iPhone 12 Pro Max style: flush to the top edge, center-top,
 *    zero gap, rounded lower corners only, never a floating pill.
 * 2. The standby orb morphs into the notch and they are never visible
 *    together; after the morph the orb never returns.
 * 3. R4 inactivity belongs to the shared FSM; hover never resets it. */
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
    #damarIsland .di-head { position:relative; z-index:2; height:32px; display:flex; align-items:center; justify-content:flex-start; gap:6px; padding:0 12px; color:#f2d987; cursor:pointer; }
    #damarIsland .di-title { display:none; }
    #damarIsland[data-state="expanded"] .di-title { display:none; }
    /* One character stage and one interactive canvas. Compact positions it in
       the notch; expanded moves the same canvas into a measured stage row. */
    #damarIsland .di-char-stage { position:absolute; z-index:1; top:0; left:50%; transform:translateX(-50%); width:52px; height:32px; overflow:hidden; display:block; pointer-events:none; }
    #damarIsland[data-state="expanded"] .di-char-stage { position:relative; top:auto; left:auto; transform:none; width:min(220px,calc(100% - 24px)); height:70px; margin:0 auto; pointer-events:auto; }
    #damarIsland .di-char-stage canvas { display:block; width:100%; height:100%; object-fit:contain; pointer-events:none; }
    #damarIsland[data-state="expanded"] .di-char-stage canvas { pointer-events:auto; cursor:pointer; }
    #damarIsland .di-char-stage .di-char-fallback { display:none; position:absolute; inset:0; width:100%; height:100%; object-fit:contain; pointer-events:none; }
    #damarIsland[data-renderer="fallback"] .di-char-stage canvas { display:none; }
    #damarIsland[data-renderer="fallback"] .di-char-stage .di-char-fallback { display:block; }
    #damarIsland[data-state="morph"] .di-head { color:rgba(242,217,135,.55); }
    #damarIsland .di-body { display:none; padding:1px 12px 3px; }
    #damarIsland[data-state="expanded"] .di-body { display:block; }
    #damarIsland .di-status { margin:0 0 3px; color:#c7c0b2; font-size:11px; }
    #damarIsland .di-controls { display:flex; gap:7px; align-items:center; flex-wrap:wrap; }
    #damarIsland button { min-height:32px; border:1px solid rgba(229,193,101,.45); border-radius:7px; padding:5px 9px; background:#151319; color:#f6f2e9; font:600 11px 'Segoe UI',sans-serif; cursor:pointer; }
    #damarIsland button:focus-visible { outline:2px solid #f7df94; outline-offset:2px; }
    #damarIslandWake { position:fixed; z-index:2147482999; top:0; left:50%; transform:translateX(-50%); width:210px; height:10px; pointer-events:none; }
    /* Owner directive: saat notch aktif (morph/compact/expanded), orb standby
       di bawah ikut morph-out — tidak ada state final dengan keduanya tampil. */
    body.siri-dock-active #siriOrbDock { transition: top .5s cubic-bezier(.16,1,.3,1), width .4s ease, height .4s ease, transform .5s cubic-bezier(.16,1,.3,1), opacity .4s ease; }
    body.siri-dock-active[data-island-notch="morph"] #siriOrbDock,
    body.siri-dock-active[data-island-notch="compact"] #siriOrbDock,
    body.siri-dock-active[data-island-notch="expanded"] #siriOrbDock {
      top: 14px !important;
      transform: translate(-50%, -50%) scale(.34) !important;
      opacity: 0 !important;
      pointer-events: none !important;
      filter: none !important;
    }
    body.siri-dock-active[data-island-notch="hidden"] #siriOrbDock { opacity:0 !important; pointer-events:none !important; }
  `;
  document.head.appendChild(style);
  const wake = document.createElement('div'); wake.id = 'damarIslandWake'; wake.setAttribute('aria-hidden','true');
  const island = document.createElement('section');
  island.id = 'damarIsland'; island.dataset.state = 'hidden'; island.setAttribute('aria-label','DAMAR Notch'); island.setAttribute('title','DAMAR Notch · compact presence and status');
  island.innerHTML = `<div class="di-head" role="button" tabindex="0" aria-label="Expand or collapse DAMAR presence"></div><div class="di-char-stage"><canvas id="damarIslandChar" width="1" height="1" aria-hidden="true"></canvas><img class="di-char-fallback" id="damarIslandCharFallback" src="/__preview-adapters/argon-assets/visuals/mochi_damar_hero_rig.png" alt=""></div><div class="di-body"><p class="di-status">Local runtime status</p><div class="di-controls"><button type="button" data-action="presence" aria-label="Return to Idle Presence">Return to Presence</button><button type="button" data-action="dashboard">Control</button></div></div>`;
  document.body.append(wake, island);
  const head = island.querySelector('.di-head');
  const desktop = () => window.damarDesktop;
  let pointerInside = false;

  const NOTCH_STATES = new Set(['morph', 'compact', 'expanded']);
  // Owner rule: setelah orb pernah morph menjadi notch, jangan pernah kembali
  // ke orb kecil lagi. Orb hanya untuk standby awal sebelum notch pertama.
  let orbPhaseDone = sessionStorage.getItem('damar-r4-notch-started') === '1';
  fsm.orbPhaseDone = orbPhaseDone;
  function syncOrbMorph(state) {
    if (fsm.orbPhaseDone) {
      orbPhaseDone = true;
      sessionStorage.setItem('damar-r4-notch-started', '1');
    }
    if (orbPhaseDone || NOTCH_STATES.has(state)) document.body.dataset.islandNotch = state;
    else delete document.body.dataset.islandNotch;
  }
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
    island.inert = to === 'hidden' || to === 'orb';
    updateHitTest(lastPointer);
    window.dispatchEvent(new CustomEvent('damar-island-state', { detail: { from, to } }));
  }
  let lastPointer = null;
  function updateHitTest(event) {
    const standbyMode = document.body.classList.contains('siri-dock-active');
    if (!standbyMode) { setClickThrough(false); return; }
    const x = event?.clientX, y = event?.clientY;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      lastPointer = { clientX: x, clientY: y };
      fsm.edgePointer(y >= 0 && y <= 6 && Math.abs(x - innerWidth / 2) <= 93);
      const islandRect = island.getBoundingClientRect();
      const orb = document.getElementById('siriOrbDock');
      const orbRect = orb?.getBoundingClientRect();
      const within = (r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      pointerInside = NOTCH_STATES.has(fsm.state) && within(islandRect);
      const notchActive = NOTCH_STATES.has(fsm.state);
      const standbyInteractive = !notchActive && !orbPhaseDone && within(orbRect);
      setClickThrough(!(pointerInside || standbyInteractive));
    } else setClickThrough(true);
  }
  fsm.onTransition = render;
  setClickThrough(false);
  document.addEventListener('mousemove', updateHitTest, { passive: true });
  // Mouse-only lifecycle: pointer masuk/keluar mengendalikan notch penuh.
  island.addEventListener('mouseenter', () => fsm.pointerEntered());
  // Leaving the island does not instantly collapse controls under a moving hand.
  // Outside click, Escape and the inactivity timer remain deliberate dismissals.
  island.addEventListener('pointerdown', () => fsm.meaningfulInteraction());
  island.addEventListener('keydown', () => fsm.meaningfulInteraction());
  window.addEventListener('damar-island-notification', event => fsm.notification(event.detail));
  window.addEventListener('damar-island-notification-resume', () => fsm.flushNotification());
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
      if (desktop()?.navigateSurface) await desktop().navigateSurface('dashboard');
      else window.location.assign('/cc2?r9r2-demo=1');
    } else if (action === 'presence') {
      fsm.hide();
      if (typeof window.wakeFromMiniOrb === 'function') window.wakeFromMiniOrb();
      else if (desktop()?.navigateSurface) await desktop().navigateSurface('presence');
      else window.location.assign('/s/idle_presence?r9r2-demo=1');
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
    // Class changes may switch surfaces, but never restart this session's orb.
    if (standby && fsm.state === 'hidden' && !orbPhaseDone) fsm.enterOrb();
    else if (!standby && (fsm.state === 'orb' || fsm.state === 'compact' || fsm.state === 'expanded')) fsm.hide();
    assertNoCoexistence(fsm.state);
  });
  standbyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  setStandbyMode(document.body.classList.contains('siri-dock-active'));
  if (document.body.classList.contains('siri-dock-active') && fsm.state === 'hidden') fsm.enterOrb();
  let cursorPoll = null;
  let cursorPollBusy = false;
  if (desktop()?.getCursorPoint) cursorPoll = setInterval(async () => {
    if (cursorPollBusy || !document.body.classList.contains('siri-dock-active')) return;
    cursorPollBusy = true;
    try {
      const point = await desktop().getCursorPoint();
      if (point) updateHitTest({ clientX: point.x, clientY: point.y });
    } catch { /* Forwarded mouse events remain a fallback if the host is closing. */ }
    finally { cursorPollBusy = false; }
  }, 80);
  window.addEventListener('pagehide', () => clearInterval(cursorPoll), { once: true });
  window.addEventListener('pagehide', () => { standbyObserver.disconnect(); setStandbyMode(false); }, { once: true });

  // One character canvas follows the same stage in compact and expanded states.
  // The DOM image is only a fallback while the interactive sprite renderer is unavailable.
  const charCanvas = document.getElementById('damarIslandChar');
  const charStage = island.querySelector('.di-char-stage');
  const charFallback = document.getElementById('damarIslandCharFallback');
  const charContext = charCanvas?.getContext('2d', { alpha: true }) || null;
  const rendererStats = { canvasCount: island.querySelectorAll('canvas').length, rafLoops: 0, frames: 0, resizes: 0, resizeObserverCount: 0, listenerCount: 0, mode: 'fallback' };
  let argonRaf = 0, argonStart = performance.now();
  let cssWidth = 0, cssHeight = 0, backingDpr = 0;
  let resizeObserver = null;

  function rendererReady() {
    return Boolean(charContext && typeof window.drawMochiDamar60fps === 'function' && window.__DAMAR_ARGON_RENDERER__?.isReady?.());
  }
  function syncRendererMode() {
    rendererStats.mode = rendererReady() ? 'interactive' : 'fallback';
    island.dataset.renderer = rendererStats.mode;
  }
  function syncCharacterCanvasSize() {
    if (!charCanvas || !charStage || !charContext) return;
    const rect = charStage.getBoundingClientRect();
    const nextWidth = Math.max(1, rect.width);
    const nextHeight = Math.max(1, rect.height);
    const nextDpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    if (Math.abs(nextWidth - cssWidth) < 0.25 && Math.abs(nextHeight - cssHeight) < 0.25 && nextDpr === backingDpr) return;
    cssWidth = nextWidth;
    cssHeight = nextHeight;
    backingDpr = nextDpr;
    charCanvas.width = Math.max(1, Math.round(cssWidth * backingDpr));
    charCanvas.height = Math.max(1, Math.round(cssHeight * backingDpr));
    charContext.setTransform(backingDpr, 0, 0, backingDpr, 0, 0);
    rendererStats.resizes++;
  }
  function normalizedPointer(event) {
    if (!charStage || !window.__DAMAR_ARGON_RENDERER__?.setPointer) return;
    const rect = charStage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    window.__DAMAR_ARGON_RENDERER__.setPointer(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)), true);
  }
  function resetCharacterPointer() { window.__DAMAR_ARGON_RENDERER__?.setPointer?.(0, 0, false); }

  function argonFrame(now) {
    if (!argonRaf) return;
    syncCharacterCanvasSize(); // also catches DPR changes even if ResizeObserver does not fire
    syncRendererMode();
    if (rendererStats.mode === 'interactive' && charContext && NOTCH_STATES.has(fsm.state) && cssWidth > 0 && cssHeight > 0) {
      const compactish = fsm.state === 'compact' || fsm.state === 'morph';
      try {
        window.drawMochiDamar60fps(charContext, cssWidth, cssHeight, (now - argonStart) / 1000, compactish);
        rendererStats.frames++;
      } catch { /* the animation loop remains available for recovery on the next frame */ }
    }
    argonRaf = requestAnimationFrame(argonFrame);
  }

  syncCharacterCanvasSize();
  syncRendererMode();
  if (typeof ResizeObserver === 'function' && charStage) {
    resizeObserver = new ResizeObserver(syncCharacterCanvasSize);
    resizeObserver.observe(charStage);
    rendererStats.resizeObserverCount = 1;
  }
  const onWindowResize = () => syncCharacterCanvasSize();
  const onRendererReady = () => syncRendererMode();
  window.addEventListener('resize', onWindowResize, { passive: true });
  window.addEventListener('damar-character-renderer-ready', onRendererReady);
  window.addEventListener('damar-character-renderer-unavailable', onRendererReady);
  island.addEventListener('pointermove', normalizedPointer, { passive: true });
  island.addEventListener('pointerleave', resetCharacterPointer, { passive: true });
  charCanvas?.addEventListener('click', event => {
    if (fsm.state === 'expanded') {
      event.stopPropagation();
      window.__DAMAR_ARGON_RENDERER__?.activate?.();
    }
  });
  rendererStats.listenerCount = 6;
  if (charFallback) {
    charFallback.addEventListener('load', syncRendererMode, { once: true });
    charFallback.addEventListener('error', () => { charFallback.hidden = true; }, { once: true });
    rendererStats.listenerCount += 2;
  }
  argonRaf = requestAnimationFrame(argonFrame);
  rendererStats.rafLoops = 1;
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(argonRaf);
    argonRaf = 0;
    rendererStats.rafLoops = 0;
    resizeObserver?.disconnect();
    resizeObserver = null;
    rendererStats.resizeObserverCount = 0;
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('damar-character-renderer-ready', onRendererReady);
    window.removeEventListener('damar-character-renderer-unavailable', onRendererReady);
    island.removeEventListener('pointermove', normalizedPointer);
    island.removeEventListener('pointerleave', resetCharacterPointer);
  }, { once: true });
  rendererStats.listenerCount++;

  window.__DAMAR_ISLAND__ = Object.freeze({
    fsm, reveal: () => fsm.reveal(), hide: () => fsm.hide(), getState: () => fsm.state,
    enterOrb: () => fsm.enterOrb(), wakeFromOrb: () => fsm.wakeFromOrb(), dismiss: () => fsm.dismiss(),
    getRendererDiagnostics: () => Object.freeze({ ...rendererStats, cssWidth, cssHeight, dpr: backingDpr, canvasWidth: charCanvas?.width || 0, canvasHeight: charCanvas?.height || 0, canvasNodes: island.querySelectorAll('canvas').length, fallbackVisible: Boolean(charFallback && getComputedStyle(charFallback).display !== 'none' && Number(getComputedStyle(charFallback).opacity || 1) > 0.05), characterState: window.__DAMAR_ARGON_RENDERER__?.getState?.() || null })
  });
})();
