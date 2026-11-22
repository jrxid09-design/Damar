'use strict';

// Synthetic status only. No camera, microphone, host-window, approval,
// handoff, provider, or device action is enabled by this preview adapter.
(() => {
  if (!new URLSearchParams(window.location.search).has('r9r2-demo')) return;
  const URL = '/__r9r2/runtime-status';
  const expectedRun = 'DAMAR_R9R3_CANONICAL_INTEGRATION_20261111';
  const expectedProvenance = 'R9R2_OFFLINE_OWNER_BOUND_SHADOW';
  let current = null;
  let active = true;
  let timer = null;

  const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  function render(snapshot) {
    current = snapshot;
    const execution = snapshot.execution || {};
    const recovery = snapshot.recovery || {};
    text('meshPillText', 'SIMULATED · SHADOW · OFFLINE');
    text('mobileTraceSteps', 'R9R3 SHADOW · READ-ONLY STATUS');
    text('mobileRespTimer', 'NO BACKEND AUTHORITY');
    text('mobileRespText', `• Synthetic AgentHub task: ${execution.status || 'UNKNOWN'} (${execution.taskId || 'none'}).\n• Synthetic SelfHealing state: ${recovery.state || 'UNKNOWN'}.\n• Provider calls: none from this interface. Device actuation and approvals are disabled.`);
    const date = document.querySelector('.aod-date');
    if (date) date.textContent = 'LOCAL PREVIEW · SYNTHETIC STATUS';
    const mobileStatus = document.querySelector('.status-bar span:nth-child(2)');
    if (mobileStatus) mobileStatus.textContent = 'OFFLINE · PREVIEW';
    const wake = document.querySelector('.aod-wake-pill');
    if (wake) wake.textContent = 'WAKE WORD · NOT CONNECTED';
    const phoneUse = document.getElementById('puStageLabel');
    if (phoneUse) phoneUse.textContent = 'SIMULATED PHONE USE · NO DEVICE INPUT';
    const log = document.getElementById('puLiveLog');
    if (log) log.textContent = `[SHADOW READ] AgentHub ${execution.status || 'UNKNOWN'}\n[SHADOW READ] SelfHealing ${recovery.state || 'UNKNOWN'}\n[DISABLED] No touch injection, host handoff, provider call, or approval action.`;
    const approval = document.getElementById('mobAprStatus');
    if (approval) approval.textContent = 'BLOCKED · CANONICAL AUTH REQUIRED';
    const deviceRouting = document.querySelector('#pane-phoneuse .resp-body-text');
    if (deviceRouting) deviceRouting.textContent = '• Local Mobile surface: SIMULATED preview only.\n• Workstation / server connectivity: NOT CONNECTED.\n• No camera, phone input, host handoff, or physical-device action is enabled.';
    document.querySelectorAll('#pane-matrix button[onclick*="decideMobileApproval"]').forEach(button => {
      button.disabled = true;
      button.title = 'Approval decisions are unavailable in the offline preview.';
    });
  }

  const setNotice = message => {
    const target = document.getElementById('mobileRespText');
    if (target) target.textContent = `• ${message}\n• R9R3 data is simulated and read-only.`;
  };

  // Replace local canned commands with truthful read-only status responses.
  window.runMobileCommand = command => {
    const q = String(command || '').toLowerCase();
    if (current && /status|pagi|rangkum|misi|kemarin|runtime/.test(q)) {
      const e = current.execution || {}, r = current.recovery || {};
      setNotice(`Synthetic runtime status: AgentHub ${e.status || 'UNKNOWN'}; SelfHealing ${r.state || 'UNKNOWN'}.`);
    } else setNotice('Command not executed: canonical conversation/runtime binding is unavailable.');
    text('mobileTraceSteps', 'OFFLINE SHADOW · READ-ONLY');
  };
  window.__DAMAR_MOBILE_PREVIEW__ = Object.freeze({ getSnapshot: () => current, cameraAllowed: false, actionsEnabled: false });

  // Keep the prototype's controls visible, but fail closed before any device
  // or approval API can be reached from this browser preview.
  window.toggleEdithCamera = () => setNotice('Camera unavailable in this preview; no device permission was requested.');
  window.decideMobileApproval = () => setNotice('Approval denied: no canonical owner-bound authorization is available.');
  window.handoffToPcWorkstation = () => {
    if (window.damarMobile?.openDashboard) { window.damarMobile.openDashboard(); return; }
    window.location.assign('/cc2?r9r2-demo=1');
  };
  const originalPhoneUse = window.startMobilePhoneUse;
  window.startMobilePhoneUse = description => {
    if (typeof originalPhoneUse === 'function') originalPhoneUse(description);
    text('puStageLabel', 'SIMULATED PHONE USE · NO DEVICE INPUT');
    setNotice('Phone-use animation only. No host or mobile device input was sent.');
  };
  window.mobileWinCtrl = action => {
    if (window.damarMobile?.windowControl) { window.damarMobile.windowControl(action); return; }
    setNotice(`Window control (${action}) is available only in the Electron host.`);
  };

  async function refresh() {
    if (!active) return;
    try {
      const response = await fetch(URL, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('status unavailable');
      const snapshot = await response.json();
      if (snapshot.runId !== expectedRun || snapshot.simulated !== true || snapshot.shadow !== true || snapshot.provenance !== expectedProvenance || snapshot.authorityRelevance !== 'none') throw new Error('untrusted preview snapshot');
      render(snapshot);
    } catch {
      current = null;
      text('meshPillText', 'OFFLINE · NO RUNTIME');
      setNotice('No synthetic runtime snapshot is available. No action was attempted.');
    }
    timer = window.setTimeout(refresh, 1000);
  }
  const handoff = document.querySelector('.surface-mesh-pill');
  if (handoff) { handoff.title = 'Open the single approved CC2 Dashboard'; text('meshPillText', 'OPEN CC2 DASHBOARD'); }
  window.addEventListener('pagehide', () => { active = false; window.clearTimeout(timer); }, { once: true });
  refresh();
})();
