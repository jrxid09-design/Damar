'use strict';
const platform = require('../../ui-platform/browser/runtime');
const { ApiClient } = require('../../ui-platform/apiClient');
const { ReadModelClient } = require('../../ui-platform/readModelClient');
const { QueryCache } = require('../../ui-platform/queryCache');
const { SubscriptionManager } = require('../../ui-platform/subscriptions');
const { CommandClient } = require('../../ui-platform/commandClient');
const { renderPrimitive, Button, StateIndicator } = require('../../ui-platform/components');
const { entityRef, deepLink } = require('../../ui-platform/entityRefs');
const { project, voiceStatusRecord } = require('../projection');
const { THEME } = require('../theme');
const instances = new WeakMap();
const FORMS = Object.freeze(['AMBIENT', 'COMPACT', 'EXPANDED', 'MISSION_FOCUS', 'APPROVAL_FOCUS', 'SECURITY_ATTENTION']);

function boot(document = globalThis.document, window = globalThis.window, options = {}) {
  if (instances.has(document)) return instances.get(document);
  const api = options.api || new ApiClient({ baseUrl: window.location.origin, session: options.session });
  const readModel = options.readModel || new ReadModelClient(api);
  const cache = options.cache || new QueryCache();
  const commands = options.commands || new CommandClient(api);
  const w4 = platform.boot(document, window, { tokenValues: THEME });
  const originalRender = w4.router.onNavigate;
  let mounted = true, root = null, core = null, status = null, content = null;
  let form = 'AMBIENT', revealed = false, hidden = false, record = { freshness: 'UNKNOWN', status: 'unknown' };
  let disposeAttachment = null, pendingCommand = null;
  let statusFeedController = null, statusFeedTimer = null;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const snapshot = options.snapshot || (async ({ signal }) => {
    const result = await cache.fetch('presence.voice', async ({ signal }) => voiceStatusRecord(await readModel.snapshot('/api/v1/console/voice/status', { signal })), { force: true, signal });
    return result.data;
  });
  // Abortable low-frequency source refresh; one timer, no idle particle loop.
  async function* refreshStream({ signal }) {
    while (!signal.aborted) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = window.setTimeout(done, 30000); signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
      if (signal.aborted) return;
      yield await snapshot({ signal });
    }
  }
  function el(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; }
  function button(label, onClick) { return renderPrimitive(document, Button({ text: label, onClick })); }
  function handoff(type, id, label) {
    if (!id) return null;
    try { const path = deepLink(entityRef(type, id), { surface: 'web_dashboard' }).path; return button(label, () => w4.router.navigate(path)); } catch { return null; }
  }
  function update() {
    if (!mounted || !root) return;
    const view = project(record, { revealed, reducedMotion: media.matches });
    root.dataset.form = form; root.hidden = hidden;
    core.dataset.state = view.binding.visualState;
    core.setAttribute('aria-label', `Damar presence: ${view.binding.visualState.replaceAll('_', ' ').toLowerCase()}`);
    status.replaceChildren(renderPrimitive(document, StateIndicator({ state: view.binding.visualState, label: view.binding.visualState.replaceAll('_', ' '), icon: view.binding.visualState === 'UNKNOWN' ? '?' : view.binding.visualState === 'WAITING_FOR_AUTHORITY' ? '◇' : '•' })));
    content.replaceChildren();
    if (form === 'AMBIENT') return;
    if (form === 'COMPACT') { content.append(el('p', 'presence-glance', view.approval ? 'Approval required' : view.mission?.activity || view.voice.state)); return; }
    const context = el('div', 'presence-context');
    if (view.mission && ['EXPANDED', 'MISSION_FOCUS'].includes(form)) {
      const panel = el('section', 'presence-mission'); panel.setAttribute('aria-label', 'Mission');
      panel.append(el('h2', '', view.mission.title || 'Mission'), el('p', '', view.mission.state || 'Unknown'));
      if (view.mission.activity) panel.append(el('p', '', view.mission.activity));
      if (view.mission.progress != null) { const progress = document.createElement('progress'); progress.max = 1; progress.value = view.mission.progress; progress.setAttribute('aria-label', 'Canonical mission progress'); panel.append(progress); }
      const link = handoff('mission', view.mission.id, 'Inspect mission'); if (link) panel.append(link); context.append(panel);
    }
    if (view.approval && ['EXPANDED', 'APPROVAL_FOCUS'].includes(form)) {
      const panel = el('section', 'presence-approval'); panel.setAttribute('aria-label', 'Approval required');
      panel.append(el('h2', '', 'Approval required'), el('p', '', view.approval.effect || 'Action details unavailable'));
      if (view.approval.risk) panel.append(el('p', '', `Risk: ${view.approval.risk}`));
      // No backend ingress is invented. Controls only exist with explicit reachable capability.
      if (options.approvalDecisionsAvailable === true && view.approval.state === 'PENDING' && view.approval.approvalId) {
        for (const [label, decision] of [['Approve', 'approve'], ['Deny', 'reject']]) {
          const control = button(label, async () => {
            if (pendingCommand) return; pendingCommand = new AbortController(); update();
            try { await commands.decideApproval({ approvalId: view.approval.approvalId, decision, signal: pendingCommand.signal }); if (mounted) runtime.reconnect(); }
            catch { if (mounted) { runtime.commandStatus = 'Decision acknowledgement uncertain. Inspect canonical state before retrying.'; update(); } }
            finally { pendingCommand = null; if (mounted) update(); }
          }); control.disabled = Boolean(pendingCommand); panel.append(control);
        }
      } else panel.append(el('p', '', 'Decision control unavailable on this surface'));
      const link = handoff('approval', view.approval.approvalId, 'Inspect approval'); if (link) panel.append(link); context.append(panel);
    }
    if (view.security && ['EXPANDED', 'SECURITY_ATTENTION'].includes(form)) {
      const panel = el('section', 'presence-security'); panel.setAttribute('aria-label', 'Security attention');
      panel.append(el('h2', '', 'Security attention'), el('p', '', view.security.summary || 'Details unavailable'), el('p', '', view.security.severity || 'Severity unknown'), el('p', '', 'Detection does not authorize action.'));
      const link = handoff('security_incident', view.security.id, 'Inspect incident'); if (link) panel.append(link); context.append(panel);
    }
    for (const n of view.notifications) context.append(el('p', 'presence-notification', n.summary || 'Notification available'));
    if (view.privacy === 'SENSITIVE_REDACTED') context.append(button('Reveal details', () => { revealed = true; update(); }));
    if (runtime.commandStatus) context.append(el('p', '', runtime.commandStatus));
    content.append(context, el('p', 'presence-voice', `Voice: ${view.voice.state}`));
    const transcript = el('section', 'presence-conversation'); transcript.setAttribute('aria-label', 'Conversation');
    for (const m of view.messages) transcript.append(el('p', `message-${m.role}`, `${m.role === 'user' ? 'You' : 'Damar'}: ${m.content}`));
    if (view.messages.length) content.append(transcript);

    // Workstream B: read-only runtime indicators in Idle Presence.
    // Sourced exclusively from verified synthetic read models (CRV3 / Watchdog / SelfHealing).
    // Never live authority, never a production signal.
    const indicators = el('section', 'presence-indicators');
    indicators.setAttribute('aria-label', 'Simulated runtime indicators');
    indicators.setAttribute('role', 'status');
    indicators.setAttribute('aria-live', 'polite');
    const indicator = (label, value, note, component, eventId) => {
      const row = el('div', 'presence-indicator');
      row.dataset.component = component;
      if (eventId) row.dataset.eventId = eventId;
      row.append(el('p', 'presence-indicator-label', label), el('p', 'presence-indicator-value', value));
      if (note) row.append(el('p', 'presence-indicator-note', note));
      indicators.append(row);
    };
    const sim = 'SIMULATED • SHADOW • offline read-only';
    const readModels = w4.readModels || {};
    const crv3 = readModels.crv3 || { status: 'unknown', data: {} };
    const watchdog = readModels.watchdog || { status: 'unknown', data: {} };
    const selfHealing = readModels.selfHealing || { status: 'unknown', data: {} };
    const disconnected = runtime.connection === 'disconnected' || runtime.connection === 'failed';
    const stale = runtime.runtimeSnapshot?.stale === true;
    const freshness = disconnected ? 'disconnected' : stale ? 'stale' : null;
    indicators.dataset.runtimeRevision = String(runtime.runtimeSnapshot?.revision ?? '');
    indicator('Runtime health (CRV3)', freshness ? `${freshness} — ${crv3.data?.status || crv3.status || 'unknown'}` : crv3.status === 'ready' ? `${crv3.data.status}: ${crv3.data.summary ?? 'no summary'}` : `offline — ${crv3.status || 'unknown'}`, sim, 'CRV3', crv3.data?.eventId);
    indicator('Watchdog activity', freshness ? `${freshness} — ${watchdog.data?.status || watchdog.status || 'unknown'}` : watchdog.status === 'ready' ? `${watchdog.data.status} • ${(watchdog.data.checks || []).length} checks` : `offline — ${watchdog.status || 'unknown'}`, sim, 'Watchdog', watchdog.data?.eventId);
    const recoveryState = runtime.runtimeSnapshot?.recovery?.state;
    indicator('SelfHealing recovery', freshness ? `${freshness} — ${recoveryState || selfHealing.data?.status || selfHealing.status || 'unknown'}` : recoveryState && recoveryState !== 'IDLE' ? `${recoveryState} • ${selfHealing.data?.summary || 'bounded recovery simulation'}` : selfHealing.status === 'ready' ? `${selfHealing.data.status} • recovery ${selfHealing.data.outcome && selfHealing.data.outcome.ok === false ? 'failed' : 'ok'}` : `offline — ${selfHealing.status || 'unknown'}`, sim, 'SelfHealing', selfHealing.data?.eventId);
    const execution = runtime.runtimeSnapshot?.execution;
    indicator('AgentHub task', execution ? `${execution.status} • ${execution.taskId || 'no task'}` : 'IDLE • no task', sim, 'AgentHub', execution?.eventId);
    const shadowMethods = runtime.runtimeSnapshot?.shadowExecution?.runtimeMethods || [];
    if (shadowMethods.length) indicator('CRV3 shadow path', shadowMethods.join(' → '), sim, 'AgentHub', execution?.eventId);
    const transitions = Array.isArray(runtime.runtimeSnapshot?.timeline) ? runtime.runtimeSnapshot.timeline.slice(-8) : [];
    if (transitions.length) {
      const history = el('section', 'presence-transition-history');
      history.setAttribute('aria-label', 'Recent simulated runtime transitions');
      history.append(el('h2', '', 'Recent runtime transitions'));
      const list = document.createElement('ol');
      for (const event of transitions) {
        const item = document.createElement('li');
        item.textContent = `${event.component}: ${event.recoveryState || event.status} — ${event.summary || 'No summary'}${event.eventId ? ` · ${event.eventId}` : ''}`;
        list.append(item);
      }
      history.append(list); indicators.append(history);
    }
    content.append(indicators);

    content.append(el('p', 'presence-limitation', 'Conversation ingress is not yet connected to Presence.'));
  }
  function render() {
    if (!mounted || w4.router.current?.route.surface !== 'idle_presence') { root = core = status = content = null; return; }
    root = document.querySelector('.damar-shell-idle_presence'); root.classList.add('presence-shell'); root.dataset.surfaceId = 'damar.presence.primary'; root.setAttribute('aria-label', 'Damar Presence');
    root.replaceChildren();
    const heading = el('header', 'presence-heading'); heading.append(el('span', 'presence-brand', 'DAMAR'));
    const controls = el('nav', 'presence-controls'); controls.setAttribute('aria-label', 'Presence controls');
    controls.append(button('Glance', () => runtime.setForm('COMPACT')), button('Expand', () => runtime.setForm('EXPANDED')), button('Collapse', () => runtime.setForm('AMBIENT')), button('Hide', () => runtime.hide()), button('Exit Presence', () => runtime.unmount())); heading.append(controls);
    core = button('Summon Damar', () => runtime.setForm(form === 'AMBIENT' ? 'COMPACT' : 'EXPANDED')); core.classList.add('presence-core');
    core.append(el('span', 'core-fold fold-one'), el('span', 'core-fold fold-two'), el('span', 'core-fold fold-three'), el('span', 'core-light'));
    status = el('div', 'presence-state'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    content = el('div', 'presence-content'); root.append(heading, core, status, content); update();
  }
  const subscriptions = new SubscriptionManager({ readModelClient: readModel, onUpdate(value) { if (!mounted) return; record = value; update(); }, onStatus(value) {
    if (!mounted) return;
    runtime.connection = value;
    if (['disconnected', 'failed'].includes(value)) { record = { status: 'degraded', freshness: 'UNKNOWN' }; update(); }
  } });
  function attach() { disposeAttachment?.(); disposeAttachment = subscriptions.attach({ snapshot, stream: Object.prototype.hasOwnProperty.call(options, 'stream') ? options.stream : refreshStream }); }
  const key = event => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); runtime.show(); runtime.setForm('COMPACT'); core?.focus(); } if (event.key === 'Escape' && root?.contains(document.activeElement)) { runtime.setForm('AMBIENT'); core?.focus(); } };
  const motionChange = () => update();
  const runtime = { api, readModel, cache, commands, router: w4.router, connection: 'snapshot_loading', commandStatus: null, runtimeSnapshot: null,
    get mounted() { return mounted; }, get form() { return form; }, get projection() { return project(record, { revealed, reducedMotion: media.matches }); },
    setForm(value) { if (!FORMS.includes(value)) throw new TypeError('unknown Presence form'); if (!mounted) return; form = value; if (['AMBIENT', 'COMPACT'].includes(value)) revealed = false; update(); },
    hide() { if (!mounted) return; hidden = true; revealed = false; update(); },
    show() { if (!mounted) return; hidden = false; if (w4.router.current?.route.surface !== 'idle_presence') w4.router.navigate('/s/idle_presence'); update(); },
     reconnect() { if (!mounted) return; revealed = false; record = { freshness: 'UNKNOWN', status: 'unknown' }; update(); attach(); },
     applyRuntimeStatus(snapshot) {
       if (!mounted) return false;
        if (!snapshot || snapshot.schema !== 'damar.r9r2.shadow-status/1' || snapshot.runId !== 'DAMAR_R9R3_CANONICAL_INTEGRATION_20261111' || snapshot.simulated !== true || snapshot.shadow !== true || snapshot.provenance !== 'R9R2_OFFLINE_OWNER_BOUND_SHADOW' || snapshot.authorityRelevance !== 'none' || !snapshot.readModels || !snapshot.execution || !snapshot.recovery || !snapshot.shadowExecution) return false;
        if (snapshot.shadowExecution.provenance !== 'R9R2_OFFLINE_OWNER_BOUND_SHADOW' || snapshot.shadowExecution.grantObjectsExposed !== false || snapshot.shadowExecution.networkCalls !== 0 || snapshot.shadowExecution.credentialsUsed !== false || !Array.isArray(snapshot.shadowExecution.runtimeMethods)) return false;
        if (snapshot.execution.component !== 'AgentHub' || snapshot.execution.provenance !== 'R9R2_OFFLINE_BOUNDED_SIMULATION' || snapshot.execution.simulated !== true || snapshot.execution.authorityRelevance !== 'none' || !['IDLE', 'QUEUED', 'RUNNING', 'RECOVERING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED'].includes(snapshot.execution.status)) return false;
        if (snapshot.recovery.component !== 'SelfHealing' || snapshot.recovery.provenance !== 'R9R2_OFFLINE_BOUNDED_SIMULATION' || snapshot.recovery.simulated !== true || snapshot.recovery.authorityRelevance !== 'none' || !['IDLE', 'DETECTED', 'RECOVERING', 'RECOVERED', 'FAILED', 'REJECTED'].includes(snapshot.recovery.state)) return false;
       const models = snapshot.readModels;
       try { w4.setIntegratedReadModels(models); } catch { return false; }
       runtime.runtimeSnapshot = snapshot;
       if (root) root.dataset.runtimeRevision = String(snapshot.revision ?? '');
       runtime.connection = snapshot.connected === true ? 'connected' : 'disconnected';
       update();
       return true;
     },
      attachRuntimeStatusFeed({ url = '/__r9r2/runtime-status', intervalMs = 500, fetchImpl = window.fetch?.bind(window) } = {}) {
       if (!mounted || typeof fetchImpl !== 'function') return () => {};
       statusFeedController?.abort(); clearTimeout(statusFeedTimer);
       statusFeedController = new AbortController();
       const controller = statusFeedController;
       let active = true;
       const poll = async () => {
         if (!active || controller.signal.aborted || !mounted) return;
         try {
           const response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
           if (!response.ok) throw new Error('runtime status unavailable');
           const snapshot = await response.json();
           if (!runtime.applyRuntimeStatus(snapshot)) throw new Error('runtime status rejected');
         } catch (error) {
           if (controller.signal.aborted || !mounted) return;
           runtime.connection = 'disconnected'; update();
         }
         if (active && !controller.signal.aborted && mounted) statusFeedTimer = window.setTimeout(poll, intervalMs);
       };
       poll();
       return () => { if (!active) return; active = false; controller.abort(); clearTimeout(statusFeedTimer); statusFeedTimer = null; if (statusFeedController === controller) statusFeedController = null; };
     },
     unmount() { if (!mounted) return; mounted = false; disposeAttachment?.(); disposeAttachment = null; statusFeedController?.abort(); statusFeedController = null; clearTimeout(statusFeedTimer); statusFeedTimer = null; pendingCommand?.abort(); window.removeEventListener('keydown', key); media.removeEventListener('change', motionChange); w4.unmount(); record = { status: 'unknown', freshness: 'UNKNOWN' }; root = core = status = content = null; instances.delete(document); },
    syncIndicators() { if (mounted) update(); },
  };
  w4.router.onNavigate = current => { revealed = false; originalRender(current); render(); };
  window.addEventListener('keydown', key); media.addEventListener('change', motionChange);
  w4.router.navigate('/s/idle_presence', { replace: true }); attach(); instances.set(document, runtime); return runtime;
}
module.exports = { boot, FORMS, ApiClient, project };
