'use strict';
// DAMAR Presence product adapter (injected after the Owner page, like the prototype's preview adapter, but with no
// demo path). Receives Core-derived state, the redacted activity feed and Core-owned presence.* config from the
// Electron main process over the allowlisted bridge; it has no network access (CSP connect-src 'none') and no
// credential. Its only mutation is naming a pending permission + decision for main to authenticate.
(() => {
  const desktop = window.damarDesktop;
  if (!desktop?.getPresence) return;
  const island = () => window.__DAMAR_ISLAND__;
  const I18N = window.DAMAR_I18N, T = (k, ...a) => (I18N ? I18N.t(k, ...a) : k);
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let config = null, lastSeq = -1, ticker = null;

  const style = document.createElement('style');
  style.textContent = `
    @font-face { font-family: 'Cinzel'; src: url('/fonts/Cinzel-VariableFont_wght.ttf') format('truetype'); font-weight: 400 900; font-display: swap; }
    @font-face { font-family: 'Cinzel Decorative'; src: url('/fonts/CinzelDecorative-Bold.ttf') format('truetype'); font-weight: 700; font-display: swap; }
    html.damar-reduced-motion *, html.damar-reduced-motion *::before, html.damar-reduced-motion *::after {
      animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; transition-delay: 0s !important; scroll-behavior: auto !important; }
    #settingsPopover { display: none !important; }`;
  document.head.appendChild(style);

  // Reduced motion also calms canvas/WebGL (orb, particles, character): animation frames are parked, and only a short
  // burst is let through when something changes (state, resize, new activity), so every canvas shows a current static
  // frame instead of continuous motion.
  const nativeRAF = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
  const parked = new Map(); let parkedId = 0x40000000, burstUntil = 0, reduced = false;
  window.requestAnimationFrame = cb => {
    if (!reduced || performance.now() < burstUntil) return nativeRAF(cb);
    const id = ++parkedId; parked.set(id, cb); return id;
  };
  window.cancelAnimationFrame = id => { if (!parked.delete(id)) nativeCancel(id); };
  function pulse(ms = 160) {
    burstUntil = performance.now() + ms;
    const cbs = [...parked.values()]; parked.clear();
    for (const cb of cbs) nativeRAF(cb);
  }
  ['damar-island-state', 'resize', 'damar-presence-motion-pulse'].forEach(ev => window.addEventListener(ev, () => pulse()));
  function applyMotion() {
    const was = reduced;
    reduced = config?.reducedMotion === 'on' || (config?.reducedMotion !== 'off' && media.matches);
    document.documentElement.classList.toggle('damar-reduced-motion', reduced);
    if (was && !reduced) pulse(0);
    document.body.dataset.reducedMotion = String(reduced);
  }
  media.addEventListener?.('change', applyMotion);
  window.__DAMAR_MOTION__ = Object.freeze({ parkedCount: () => parked.size, reduced: () => reduced });

  function applyConfig(next) {
    if (!next) return;
    config = next;
    island()?.configure({ idleToNotchMs: next.idleToNotchMs, morphMs: next.morphMs, notchEnabled: next.notchEnabled });
    applyMotion();
    window.dispatchEvent(new CustomEvent('damar-presence-mic', { detail: next.voiceEnabled === true }));
    renderGreeting();
    document.body.dataset.presenceConfigSource = next.source || 'unknown';
  }
  // Greeting: time of day + the configured address (Core presence.salutation, falling back to presence.displayName).
  function renderGreeting() {
    const el = document.getElementById('greetingTitle'); if (!el) return;
    const name = (typeof config?.salutation === 'string' && config.salutation.trim()) || (typeof config?.displayName === 'string' ? config.displayName.trim() : '');
    el.textContent = T('greeting', new Date().getHours(), name);
  }
  window.addEventListener('damar-presence-lang', renderGreeting);
  setInterval(renderGreeting, 60000);
  function tickerText(a) {
    if (!a) return null;
    if (a.kind === 'read') return T('read', a.file);
    if (a.kind === 'edit') return T('edit', a.file, a.added, a.removed);
    if (a.kind === 'run') return T('run');
    if (a.kind === 'shell') return T('shell');
    if (a.kind === 'final') return a.status === 'COMPLETED' ? T('done') : T('failed') + a.status;
    if (a.kind === 'alert') return a.label ? T('alert', a.label) : T('alertCount', 1);
    if (a.kind === 'discussion') return a.state === 'RUNNING' ? T('discussing', a.round, a.of) : a.state === 'COMPLETED' ? T('discussionDone') : T('discussionEnded', a.state);
    return null;
  }
  function statusFor(view) {
    if (!view || view.status !== 'CONNECTED') return T('notConnected');
    const a = view.activity || {}, parts = ['Core ' + view.lifecycle];
    if (a.pendingPermissions) parts.push(T('permissionWaiting', a.pendingPermissions));
    if (a.activeTurns) parts.push(T('turnsRunning', a.activeTurns));
    if (a.activePandawaRuns) parts.push(T('pandawaRuns', a.activePandawaRuns));
    if (parts.length === 1) parts.push(T('idle'));
    const recent = ticker && Date.now() - ticker.shownAt < 15000 ? ticker.text : null;
    return recent ? recent + ' · ' + parts.join(' · ') : parts.join(' · ');
  }
  let lastView = null;
  function applyState(view) {
    if (!view) return;
    lastView = view;
    for (const a of view.activity?.events || []) {
      if (a.seq <= lastSeq) continue;
      lastSeq = a.seq;
      const text = tickerText(a); if (text) ticker = { text, shownAt: Date.now() };
      window.dispatchEvent(new CustomEvent('damar-presence-activity', { detail: a }));
    }
    window.dispatchEvent(new CustomEvent('damar-presence-status', { detail: statusFor(view) }));
    window.dispatchEvent(new CustomEvent('damar-presence-attention', { detail: { pendingPermissions: view.activity?.pendingPermissions || 0, permission: view.permission || null } }));
    window.dispatchEvent(new CustomEvent('damar-presence-sessions', { detail: view.sessionPills || [] }));
    window.dispatchEvent(new CustomEvent('damar-presence-media', { detail: view.media || null }));
    window.dispatchEvent(new CustomEvent('damar-presence-behavior', { detail: { pcActivity: view.pcActivity || null } }));
    if (view.lang) I18N?.setLang(view.lang);
    try {
      if (typeof canonicalAdapter !== 'undefined') canonicalAdapter.refresh().then(() => {
        if (typeof currentWorkspace !== 'undefined' && currentWorkspace && typeof renderWorkspaceContent === 'function') renderWorkspaceContent(currentWorkspace);
      });
    } catch {}
    pulse();
  }
  window.addEventListener('damar-presence-lang', () => window.dispatchEvent(new CustomEvent('damar-presence-status', { detail: statusFor(lastView) })));

  // Owner: no settings UI in Presence/Notch. The prototype's settings panel stays in the DOM (the Owner page's own code
  // references it) but hidden; its gear entry point only opens DAMAR Control (the single configuration surface).
  const gear = document.getElementById('settingsGearBtn');
  if (gear) {
    const label = () => { gear.title = T('controlOpen'); gear.setAttribute('aria-label', T('controlOpen')); };
    label(); window.addEventListener('damar-presence-lang', label);
    gear.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); desktop.navigateSurface('dashboard'); }, true);
  }

  // No simulated Computer Use in the product: the prototype's scripted walkthrough is replaced by a truthful notice.
  if (typeof window.startComputerUseMode === 'function') {
    window.startComputerUseMode = () => { try { presentTruthUnavailable(T('cuNotice')); } catch {} };
  }
  // Spoken replies follow the UI language.
  if (typeof window.speakWithOrbReactivity === 'function') {
    const speak = window.speakWithOrbReactivity;
    window.speakWithOrbReactivity = (text, ...rest) => speak(I18N?.lang() === 'en' ? (I18N.PAGE_EN[text] || text) : text, ...rest);
  }
  // Voice conversation yields the notch to the orb; it ends when DAMAR stops speaking.
  if (typeof window.triggerWakeWordResponse === 'function') {
    const base = window.triggerWakeWordResponse;
    window.triggerWakeWordResponse = (...args) => {
      island()?.voiceStart();
      const startedAt = Date.now();
      const poll = setInterval(() => {
        const speaking = typeof damarIsSpeaking !== 'undefined' && damarIsSpeaking;
        if (!speaking && Date.now() - startedAt > 1500) { clearInterval(poll); island()?.voiceEnd(); }
      }, 250);
      return base(...args);
    };
  }

  desktop.onPresence(msg => { if (msg?.config) applyConfig(msg.config); if (msg?.view) applyState(msg.view); });
  desktop.getPresence().then(msg => { applyConfig(msg?.config); applyState(msg?.view); }).catch(() => {});
})();
