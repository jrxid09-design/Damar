'use strict';

// Mobile DOM/events adapter for the shared DamarIslandFSM implementation.
// No separate Mobile state machine or timeout logic is implemented here.
(() => {
  if (!new URLSearchParams(window.location.search).has('r9r2-demo')) return;
  if (window.__DAMAR_MOBILE_ISLAND__) return;

  const island = document.getElementById('dynamicIsland');
  const orb = document.querySelector('.aod-orb-center');
  if (!island || !orb || typeof window.DamarIslandFSM !== 'function') return;

  const fsm = new window.DamarIslandFSM();
  let notchPhaseDone = sessionStorage.getItem('damar-r4-mobile-notch-started') === '1';
  fsm.orbPhaseDone = notchPhaseDone;
  let skipWakeClick = false;

  const inWakeArea = (x, y) => y >= 0 && y <= 6 && Math.abs(x - window.innerWidth / 2) <= 93;

  function render(_from, to) {
    island.dataset.state = to;
    island.classList.toggle('island-expanded', to === 'expanded');
    island.setAttribute('aria-expanded', String(to === 'expanded'));

    const standby = document.body.classList.contains('aod-standby-active');
    const orbVisible = standby && to === 'orb';
    const notchVisible = ['morph', 'compact', 'expanded'].includes(to);
    document.body.dataset.mobileIslandState = to;
    document.body.dataset.mobileOrb = orbVisible ? 'visible' : 'hidden';

    if (fsm.orbPhaseDone) notchPhaseDone = true;
    if (notchPhaseDone) {
      sessionStorage.setItem('damar-r4-mobile-notch-started', '1');
      document.body.dataset.mobileNotchPhaseStarted = 'true';
    }

    const status = document.getElementById('islandStatusText');
    if (status && !standby) status.textContent = 'DAMAR NOTCH';

    if (standby && orbVisible && notchVisible) {
      document.body.dataset.mobileIslandViolation = 'orb-notch-coexistence';
    } else {
      delete document.body.dataset.mobileIslandViolation;
    }
  }

  fsm.onTransition = render;
  render('hidden', fsm.state);

  function enterStandby() {
    if (fsm.state === 'hidden') fsm.enterOrb();
  }
  function leaveStandby() {
    fsm.hide();
  }

  window.addEventListener('damar-mobile-aod-change', event => {
    if (event.detail?.active) enterStandby();
    else leaveStandby();
  });
  window.addEventListener('damar-mobile-orb-activity', () => fsm.orbActivity());

  island.addEventListener('pointerenter', () => fsm.pointerEntered());
  island.addEventListener('pointerleave', () => fsm.pointerLeft());
  island.addEventListener('pointerdown', () => fsm.meaningfulInteraction());
  island.addEventListener('keydown', () => fsm.meaningfulInteraction());
  window.addEventListener('damar-island-notification', event => fsm.notification(event.detail));
  window.addEventListener('damar-island-notification-resume', () => fsm.flushNotification());
  island.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      island.click();
    }
  });

  document.addEventListener('pointermove', event => {
    const { clientX: x, clientY: y } = event;
    fsm.edgePointer(inWakeArea(x, y));
  }, { passive: true });

  document.addEventListener('pointerdown', event => {
    if (fsm.state === 'hidden' && notchPhaseDone && inWakeArea(event.clientX, event.clientY)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      fsm.edgePointer(false);
      fsm.edgePointer(true);
      skipWakeClick = true;
      window.setTimeout(() => { skipWakeClick = false; }, 500);
    }
    if (event.target?.closest?.('.aod-orb-center') && fsm.state === 'orb') fsm.orbActivity();
  }, true);

  document.addEventListener('click', event => {
    if (skipWakeClick) { skipWakeClick = false; return; }
    if (!island.contains(event.target) && !orb.contains(event.target)) fsm.dismiss();
  }, true);

  if (document.body.classList.contains('aod-standby-active')) enterStandby();
  window.__DAMAR_MOBILE_ISLAND__ = Object.freeze({
    getState: () => fsm.state,
    enterStandby,
    leaveStandby,
    orbActivity: () => fsm.orbActivity(),
    reveal: () => fsm.reveal(),
    dismiss: () => fsm.dismiss(),
    fsm
  });
})();
