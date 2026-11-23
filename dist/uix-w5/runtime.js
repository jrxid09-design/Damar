(function(){'use strict';const modules={
"docs/uix-w3/SEMANTIC_DESIGN_TOKENS.json":function(module,exports,require){
module.exports={"schema_version":"uix-w3.semantic-tokens.v1","value_policy":"semantic_records_only; production color/type/spacing values are intentionally deferred to W4","tokens":[{"token_id":"surface.void","semantic_role":"deepest background","category":"surface","lightness_relationship":"lowest","contrast_requirement":"text and focus must meet accessible contrast","surface_usage":["all"],"state_usage":["OFFLINE","IDLE"],"accessibility_requirement":"never encode state by background alone"},{"token_id":"surface.ambient","semantic_role":"contextual ambient layer","category":"surface","lightness_relationship":"above void","contrast_requirement":"supporting text remains readable","surface_usage":["idle_presence","web_dashboard"],"state_usage":["IDLE","LISTENING"],"accessibility_requirement":"nonessential decoration removable"},{"token_id":"surface.presence","semantic_role":"presence anchor surface","category":"surface","lightness_relationship":"focused lift","contrast_requirement":"presence label and state cue readable","surface_usage":["idle_presence","companion"],"state_usage":["LISTENING","THINKING","ACTING"],"accessibility_requirement":"state also exposed as text and live region when relevant"},{"token_id":"surface.interaction","semantic_role":"primary readable interaction plane","category":"surface","lightness_relationship":"high enough separation from ambient","contrast_requirement":"body and control contrast","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"focus ring remains visible"},{"token_id":"surface.floating","semantic_role":"temporary elevated control","category":"elevation","lightness_relationship":"above interaction","contrast_requirement":"edge and content separation","surface_usage":["idle_presence","web_dashboard"],"state_usage":["ATTENTION","WAITING_FOR_USER"],"accessibility_requirement":"not the only location of actionable content"},{"token_id":"surface.approval","semantic_role":"authority decision plane","category":"approval","lightness_relationship":"high semantic separation","contrast_requirement":"decision controls and risk readable","surface_usage":["all approval-capable"],"state_usage":["WAITING_FOR_AUTHORITY"],"accessibility_requirement":"risk, expiry, and target announced"},{"token_id":"surface.security","semantic_role":"security attention plane","category":"security","lightness_relationship":"highest attention contrast without panic","contrast_requirement":"critical content and focus meet enhanced contrast","surface_usage":["all policy-permitted"],"state_usage":["SECURITY_ALERT"],"accessibility_requirement":"shape, label, sound policy, and text redundancy"},{"token_id":"text.primary","semantic_role":"primary human-readable content","category":"text","lightness_relationship":"highest on active surface","contrast_requirement":"WCAG AA minimum; enhanced for critical text","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"scales with user text settings"},{"token_id":"text.secondary","semantic_role":"supporting explanation","category":"text","lightness_relationship":"lower than primary but readable","contrast_requirement":"WCAG AA for normal text","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"not used for sole status cue"},{"token_id":"text.metadata","semantic_role":"timestamp, provenance, identifiers","category":"text","lightness_relationship":"subordinate","contrast_requirement":"readable at compact size","surface_usage":["web_dashboard","cli","forensic"],"state_usage":["all"],"accessibility_requirement":"never truncate canonical IDs without inspect affordance"},{"token_id":"border.subtle","semantic_role":"layer boundary","category":"border","lightness_relationship":"low separation","contrast_requirement":"supplemental only","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"never sole focus/status cue"},{"token_id":"focus.visible","semantic_role":"keyboard and assistive focus","category":"focus","lightness_relationship":"highest local contrast","contrast_requirement":"visible in all themes and layers","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"persistent while focused"},{"token_id":"interactive.primary","semantic_role":"safe primary action","category":"interactive","lightness_relationship":"prominent but not alarm-like","contrast_requirement":"control and label contrast","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"minimum target and name"},{"token_id":"status.neutral","semantic_role":"no special attention","category":"status","lightness_relationship":"quiet","contrast_requirement":"text and shape redundant","surface_usage":["all"],"state_usage":["DORMANT","IDLE"],"accessibility_requirement":"label required when ambiguous"},{"token_id":"status.information","semantic_role":"informational change","category":"status","lightness_relationship":"noticeable not urgent","contrast_requirement":"color plus icon plus text","surface_usage":["all"],"state_usage":["LISTENING","VERIFYING"],"accessibility_requirement":"live-region policy"},{"token_id":"status.active","semantic_role":"currently processing or acting","category":"status","lightness_relationship":"localized energy","contrast_requirement":"color plus motion alternative plus label","surface_usage":["all"],"state_usage":["THINKING","ACTING"],"accessibility_requirement":"no fabricated progress"},{"token_id":"status.success","semantic_role":"verified favorable outcome","category":"status","lightness_relationship":"calm confirmation","contrast_requirement":"icon and text redundancy","surface_usage":["all"],"state_usage":["COMPLETED"],"accessibility_requirement":"only after truth permits"},{"token_id":"status.warning","semantic_role":"risk or degraded attention","category":"status","lightness_relationship":"visible caution","contrast_requirement":"not color-only","surface_usage":["all"],"state_usage":["DEGRADED","ATTENTION"],"accessibility_requirement":"text label and alert semantics as needed"},{"token_id":"status.danger","semantic_role":"user-correctable or consequential failure","category":"degraded_error","lightness_relationship":"strong but scoped","contrast_requirement":"enhanced contrast","surface_usage":["all"],"state_usage":["DEGRADED"],"accessibility_requirement":"action and cause explicit"},{"token_id":"security.suspicious","semantic_role":"security signal requiring review","category":"security","lightness_relationship":"distinct from generic warning","contrast_requirement":"shape and evidence label","surface_usage":["dashboard","idle_presence"],"state_usage":["SECURITY_ALERT"],"accessibility_requirement":"uncertainty visible"},{"token_id":"security.confirmed","semantic_role":"confirmed security incident","category":"security","lightness_relationship":"high attention","contrast_requirement":"enhanced contrast and persistent cue","surface_usage":["all policy-permitted"],"state_usage":["SECURITY_ALERT"],"accessibility_requirement":"source evidence and response boundary visible"},{"token_id":"authority.requested","semantic_role":"consequential request proposed","category":"authority","lightness_relationship":"neutral attention","contrast_requirement":"scope and risk readable","surface_usage":["approval-capable"],"state_usage":["WAITING_FOR_AUTHORITY"],"accessibility_requirement":"not styled as allowed"},{"token_id":"authority.denied","semantic_role":"authority denied effect","category":"authority","lightness_relationship":"firm neutral/danger","contrast_requirement":"decision text explicit","surface_usage":["all"],"state_usage":["ATTENTION","DEGRADED"],"accessibility_requirement":"not confused with runtime failure"},{"token_id":"approval.pending","semantic_role":"awaiting user/authority decision","category":"approval","lightness_relationship":"focused","contrast_requirement":"decision controls clear","surface_usage":["all approval-capable"],"state_usage":["WAITING_FOR_AUTHORITY"],"accessibility_requirement":"expiry and consequence announced"},{"token_id":"awareness.fresh","semantic_role":"bounded recent observation","category":"awareness","lightness_relationship":"quiet information","contrast_requirement":"freshness label readable","surface_usage":["idle_presence","web_dashboard"],"state_usage":["IDLE","ATTENTION"],"accessibility_requirement":"source and timestamp exposed"},{"token_id":"awareness.stale","semantic_role":"observation past freshness bound","category":"awareness","lightness_relationship":"muted caution","contrast_requirement":"stale marker readable","surface_usage":["all"],"state_usage":["DEGRADED"],"accessibility_requirement":"never presented as current"},{"token_id":"provider.healthy","semantic_role":"provider instance health evidence","category":"provider","lightness_relationship":"calm positive","contrast_requirement":"instance label and timestamp","surface_usage":["dashboard","cli"],"state_usage":["IDLE","ACTING"],"accessibility_requirement":"distinct from model and authority"},{"token_id":"provider.degraded","semantic_role":"provider routing limitation","category":"provider","lightness_relationship":"caution","contrast_requirement":"reason and fallback evidence","surface_usage":["dashboard","cli","forensic"],"state_usage":["DEGRADED"],"accessibility_requirement":"no false healthy badge"},{"token_id":"device.trusted","semantic_role":"paired/trust evidence","category":"device","lightness_relationship":"calm","contrast_requirement":"trust label and icon","surface_usage":["all"],"state_usage":["IDLE","ACTING"],"accessibility_requirement":"not equivalent to online"},{"token_id":"device.unknown","semantic_role":"device state not established","category":"device","lightness_relationship":"muted caution","contrast_requirement":"unknown label visible","surface_usage":["all"],"state_usage":["DEGRADED","OFFLINE"],"accessibility_requirement":"unknown != offline"},{"token_id":"data.verified","semantic_role":"verified evidence/result","category":"data_visualization","lightness_relationship":"stable","contrast_requirement":"verification marker and text","surface_usage":["all"],"state_usage":["VERIFYING","COMPLETED"],"accessibility_requirement":"source reference available"},{"token_id":"data.uncertain","semantic_role":"incomplete/conflicting result","category":"data_visualization","lightness_relationship":"patterned caution","contrast_requirement":"uncertainty label","surface_usage":["all"],"state_usage":["DEGRADED","ATTENTION"],"accessibility_requirement":"never collapse into success"},{"token_id":"degraded.offline","semantic_role":"no current connection/read freshness","category":"degraded_error","lightness_relationship":"muted but explicit","contrast_requirement":"persistent text/shape cue","surface_usage":["all"],"state_usage":["OFFLINE"],"accessibility_requirement":"do not use indefinite loading"}]};
},
"docs/uix-w3/STATE_PRIORITY_MATRIX.json":function(module,exports,require){
module.exports={"schema_version":"uix-w3.state-priority.v1","precedence_high_to_low":["SECURITY_ALERT","ATTENTION","WAITING_FOR_AUTHORITY","WAITING_FOR_USER","VERIFYING","ACTING","DEGRADED","OFFLINE","UNKNOWN","THINKING","LISTENING","COMPLETED","IDLE","DORMANT"],"resolution_rule":"highest applicable state controls primary presence treatment; secondary truth badges remain visible when they do not contradict it","conflicts":[{"when":["THINKING","SECURITY_ALERT"],"winner":"SECURITY_ALERT","treatment":"show security severity/evidence; retain processing as secondary context"},{"when":["ACTING","WAITING_FOR_AUTHORITY"],"winner":"WAITING_FOR_AUTHORITY","treatment":"execution must be shown paused/pending only if mission source says so; never imply acting past gate"},{"when":["DEGRADED","COMPLETED"],"winner":"DEGRADED","treatment":"show completion only with limitation/verification caveat; do not style healthy"},{"when":["LISTENING","SECURITY_ALERT"],"winner":"SECURITY_ALERT","treatment":"interrupt only per urgency/privacy policy; preserve listening transcript state"},{"when":["ACTING","VERIFYING"],"winner":"VERIFYING","treatment":"execution ended or is in verification phase; no progress animation"},{"when":["OFFLINE","COMPLETED"],"winner":"OFFLINE","treatment":"show last-known completion with timestamp, not current confirmation"}],"interruptibility":"priority affects presentation, never authority or state ownership"};
},
"docs/uix-w3/VISUAL_STATE_MODEL.json":function(module,exports,require){
module.exports={"schema_version":"uix-w3.visual-state-model.v1","state_owner_rule":"all records are projections of W2 read models/signals; no component owns canonical state","states":[{"visual_state_id":"DORMANT","semantic_meaning":"presence is available but not actively engaged","source_state_refs":["presence_projection:standby","session_projection:LIVE"],"entry_condition":"no active attention, mission, approval, or notification requiring presentation","exit_condition":"wake, summon, relevant update, or policy-permitted alert","priority":10,"interruptibility":"fully_interruptible","motion_profile":"presence_breathing","surface_scope":["idle_presence","companion","voice"],"density_scope":["NORMAL"],"accessibility_fallback":"static presence label: Damar is available","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"IDLE","semantic_meaning":"available and not currently processing a user request","source_state_refs":["presence_projection:idle","session_projection:LIVE"],"entry_condition":"read model reports idle","exit_condition":"listen, mission, notification, or degraded signal","priority":20,"interruptibility":"fully_interruptible","motion_profile":"ambient","surface_scope":["all projected surfaces"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"text status: Idle","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"LISTENING","semantic_meaning":"input is being received or voice modality is listening","source_state_refs":["voice_runtime:VAD/listening","conversation_ingress:accepted_input"],"entry_condition":"canonical voice/input signal says listening","exit_condition":"input ends, timeout, error, or transition to another mapped state","priority":40,"interruptibility":"user_interruptible","motion_profile":"listening_response","surface_scope":["idle_presence","voice","companion"],"density_scope":["NORMAL"],"accessibility_fallback":"live text: Listening","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"THINKING","semantic_meaning":"canonical read model reports cognition/response processing; not proof of action","source_state_refs":["presence_projection:thinking","conversation_projection:processing"],"entry_condition":"source explicitly reports processing","exit_condition":"response available, failure, authority wait, acting, or unknown","priority":50,"interruptibility":"user_interruptible","motion_profile":"thinking_indeterminate","surface_scope":["idle_presence","voice","dashboard"],"density_scope":["NORMAL","POWER"],"accessibility_fallback":"text status: Processing; duration unknown","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"ACTING","semantic_meaning":"mission/task execution is active","source_state_refs":["mission_projection:RUNNING","task_projection:EXECUTING"],"entry_condition":"canonical execution signal exists","exit_condition":"wait, verify, complete, fail, cancel, or degrade","priority":60,"interruptibility":"policy_dependent","motion_profile":"acting_indeterminate_or_real_progress","surface_scope":["all mission surfaces"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"text status: Executing; progress shown only if sourced","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"WAITING_FOR_USER","semantic_meaning":"user input is required before continuation","source_state_refs":["mission_projection:WAITING_FOR_USER","task_projection:BLOCKED_USER_INPUT"],"entry_condition":"canonical mission/task wait reason is user","exit_condition":"input received, expired, cancelled, or failed","priority":70,"interruptibility":"user_action_required","motion_profile":"attention_request","surface_scope":["idle_presence","web_dashboard","cli","companion","telegram","whatsapp"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent labeled prompt with focus","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"WAITING_FOR_AUTHORITY","semantic_meaning":"consequential action is pending canonical authority/approval","source_state_refs":["approval_projection:decision=PENDING","authority_result=DEFER"],"entry_condition":"approval record exists and is pending/deferred","exit_condition":"approved, denied, expired, cancelled, or unknown","priority":80,"interruptibility":"user_action_required","motion_profile":"approval_request","surface_scope":["idle_presence","web_dashboard","cli","companion","voice","telegram","whatsapp"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent approval summary with risk, target, expiry, and controls","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"VERIFYING","semantic_meaning":"execution result is awaiting canonical verification","source_state_refs":["approval_projection:verification_result=NOT_STARTED","mission/task:verification_pending"],"entry_condition":"execution occurred and verification is required/pending","exit_condition":"PASS, FAIL, UNCERTAIN, or unavailable","priority":75,"interruptibility":"policy_dependent","motion_profile":"verification","surface_scope":["all mission surfaces"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"text status: Verifying result; result not yet confirmed","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"COMPLETED","semantic_meaning":"mission/task outcome is complete at the supported truth level","source_state_refs":["mission_projection:COMPLETED","verification_result=PASS when required"],"entry_condition":"completion and required verification permit completion","exit_condition":"new event, stale projection, or inspection only","priority":30,"interruptibility":"not_applicable","motion_profile":"success_completion","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"static completion label with verification summary","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"DEGRADED","semantic_meaning":"runtime/read model is limited, stale, partial, failed, or fallback is active","source_state_refs":["presence_projection:DEGRADED","provider_health:DEGRADED","device_projection:STALE","network:FAILED"],"entry_condition":"canonical limitation/failure signal","exit_condition":"fresh healthy read model or explicit offline/unknown state","priority":90,"interruptibility":"policy_dependent","motion_profile":"degraded_static_or_subtle","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent cause, impact, and next action text","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"ATTENTION","semantic_meaning":"important notification or user acknowledgement is required","source_state_refs":["notification_projection:IMPORTANT|URGENT","mission/task:blocked"],"entry_condition":"notification policy selects attention","exit_condition":"acknowledged, dismissed, resolved, expired, or escalated","priority":100,"interruptibility":"policy_dependent","motion_profile":"attention_request","surface_scope":["all policy-permitted"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent alert/live region with acknowledgement semantics","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"SECURITY_ALERT","semantic_meaning":"DCD/security signal or incident needs policy-permitted attention; it is not authorization","source_state_refs":["security_incident_projection:signal|detection|incident","notification_projection:CRITICAL"],"entry_condition":"policy permits presentation of security event","exit_condition":"acknowledged/resolved/escalated/expired per incident lifecycle","priority":110,"interruptibility":"policy_dependent","motion_profile":"security_escalation","surface_scope":["all policy-permitted"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent labeled security alert with severity, evidence, uncertainty, and response boundary","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"OFFLINE","semantic_meaning":"surface or relevant source is disconnected; current truth may not be available","source_state_refs":["session_projection:EXPIRED","device_projection:OFFLINE","network:UNREACHABLE"],"entry_condition":"explicit offline/disconnected signal","exit_condition":"fresh authenticated connection/read model","priority":95,"interruptibility":"policy_dependent","motion_profile":"offline_static","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"offline label, last-known timestamp, disabled mutation explanation","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"UNKNOWN","semantic_meaning":"source cannot establish a trustworthy state","source_state_refs":["any read model:freshness=UNKNOWN","observation:unknown"],"entry_condition":"missing/conflicting/untrusted source","exit_condition":"fresh authoritative projection or explicit failure/offline","priority":85,"interruptibility":"policy_dependent","motion_profile":"unknown_static","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"explicit Unknown label with source and age","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"}],"truth_rules":["THINKING is not ACTING","WAITING_FOR_AUTHORITY is not generic loading","VERIFYING is not COMPLETED","determinate progress requires a real value","unknown is never styled healthy","future is never styled available"]};
},
"src/presence-ui/browser/runtime.js":function(module,exports,require){
'use strict';
const platform = require("src/ui-platform/browser/runtime.js");
const { ApiClient } = require("src/ui-platform/apiClient.js");
const { ReadModelClient } = require("src/ui-platform/readModelClient.js");
const { QueryCache } = require("src/ui-platform/queryCache.js");
const { SubscriptionManager } = require("src/ui-platform/subscriptions.js");
const { CommandClient } = require("src/ui-platform/commandClient.js");
const { renderPrimitive, Button, StateIndicator } = require("src/ui-platform/components.js");
const { entityRef, deepLink } = require("src/ui-platform/entityRefs.js");
const { project, voiceStatusRecord } = require("src/presence-ui/projection.js");
const { THEME } = require("src/presence-ui/theme.js");
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
  function attach() { disposeAttachment?.(); disposeAttachment = subscriptions.attach({ snapshot, stream: options.stream || refreshStream }); }
  const key = event => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); runtime.show(); runtime.setForm('COMPACT'); core?.focus(); } if (event.key === 'Escape' && root?.contains(document.activeElement)) { runtime.setForm('AMBIENT'); core?.focus(); } };
  const motionChange = () => update();
  const runtime = { api, readModel, cache, commands, router: w4.router, connection: 'snapshot_loading', commandStatus: null,
    get mounted() { return mounted; }, get form() { return form; }, get projection() { return project(record, { revealed, reducedMotion: media.matches }); },
    setForm(value) { if (!FORMS.includes(value)) throw new TypeError('unknown Presence form'); if (!mounted) return; form = value; if (['AMBIENT', 'COMPACT'].includes(value)) revealed = false; update(); },
    hide() { if (!mounted) return; hidden = true; revealed = false; update(); },
    show() { if (!mounted) return; hidden = false; if (w4.router.current?.route.surface !== 'idle_presence') w4.router.navigate('/s/idle_presence'); update(); },
    reconnect() { if (!mounted) return; revealed = false; record = { freshness: 'UNKNOWN', status: 'unknown' }; update(); attach(); },
    unmount() { if (!mounted) return; mounted = false; disposeAttachment?.(); disposeAttachment = null; pendingCommand?.abort(); window.removeEventListener('keydown', key); media.removeEventListener('change', motionChange); w4.unmount(); record = { status: 'unknown', freshness: 'UNKNOWN' }; root = core = status = content = null; instances.delete(document); },
  };
  w4.router.onNavigate = current => { revealed = false; originalRender(current); render(); };
  window.addEventListener('keydown', key); media.addEventListener('change', motionChange);
  w4.router.navigate('/s/idle_presence', { replace: true }); attach(); instances.set(document, runtime); return runtime;
}
module.exports = { boot, FORMS, ApiClient, project };

},
"src/presence-ui/projection.js":function(module,exports,require){
'use strict';
const { bindVisualState, motionFor } = require("src/ui-platform/stateBinding.js");
const { approvalProjection, notificationProjection } = require("src/ui-platform/projections.js");
const { STATES: VOICE_STATES } = require("src/voice/stateMachine.js");

// A projection adapter, never a state engine. Missing source remains UNKNOWN.
// All display data is allowlisted before it can reach DOM or presentation cache.
function text(value, limit = 500) { return typeof value === 'string' ? value.slice(0, limit) : null; }
function project(record = {}, { revealed = false, reducedMotion = false } = {}) {
  const source = record.data || {};
  const fresh = ['LIVE', 'EVENTUAL'].includes(record.freshness) && record.status === 'ready';
  const sensitive = source.privacy_sensitivity && source.privacy_sensitivity !== 'NORMAL';
  const redact = sensitive && !revealed;
  const safe = fresh ? source : { freshness: record.freshness === 'STALE' ? 'STALE' : 'UNKNOWN' };
  const binding = bindVisualState(safe);
  const approval = fresh && source.approval ? approvalProjection(source.approval) : null;
  const notifications = fresh ? (source.notifications || []).filter(n => n.target_surfaces?.includes('idle_presence')).map(n => ({
    ...notificationProjection(n),
    summary: n.privacy_sensitivity && n.privacy_sensitivity !== 'NORMAL' && !revealed ? 'Sensitive notification' : text(n.summary),
  })) : [];
  return Object.freeze({ binding, motion: motionFor(binding.visualState, reducedMotion),
    freshness: record.freshness || 'UNKNOWN', asOf: record.asOf || null,
    privacy: redact ? 'SENSITIVE_REDACTED' : revealed ? 'USER_REVEALED' : 'NORMAL_DISPLAY',
    mission: fresh && source.mission ? { id: text(source.mission.mission_id), title: redact ? 'Sensitive mission' : text(source.mission.title), state: text(source.mission.state), activity: redact ? null : text(source.mission.activity), verification: text(source.verificationResult), progress: binding.progress } : null,
    approval: approval ? { ...approval, effect: redact ? 'Sensitive action requires approval' : text(approval.effect), risk: text(approval.risk) } : null,
    notifications,
    security: fresh && source.securityAlert ? { id: text(source.security?.incident_id), summary: redact ? 'Security attention required' : text(source.security?.summary), severity: text(source.security?.severity) } : null,
    voice: fresh ? { available: source.voice?.available === true, state: text(source.voice?.state) || 'Unknown' } : { available: false, state: 'Unknown' },
    messages: fresh && !redact ? (source.messages || []).filter(m => ['user', 'assistant'].includes(m.role)).slice(-100).map(m => ({ role: m.role, content: text(m.content, 12000) || '' })) : [],
  });
}

// Existing status API describes voice, not global Presence health or authority.
// A stopped microphone must never set offline=true on Damar.
function voiceStatusRecord(record) {
  if (record.status !== 'ready' || record.data?.success !== true) return { ...record, error: null, data: null, freshness: 'UNKNOWN', status: 'unknown' };
  const runtime = record.data.data?.runtime;
  const state = Object.values(VOICE_STATES).includes(runtime?.state) ? runtime.state : 'UNKNOWN';
  const running = runtime?.running === true;
  return { ...record, error: null, data: { freshness: 'UNKNOWN',
    ...(running && state === VOICE_STATES.LISTENING ? { listening: true, freshness: record.freshness } : {}),
    ...(running && state === VOICE_STATES.THINKING ? { presence: 'thinking', freshness: record.freshness } : {}),
    voice: { available: running, state: running ? state : 'Unavailable' },
  } };
}
module.exports = { project, voiceStatusRecord };

},
"src/presence-ui/theme.js":function(module,exports,require){
'use strict';
const { TOKEN_VALUES } = require("src/ui-platform/tokens.js");
// Explicit W5 delta; frozen W3 semantic roles and W4 defaults are untouched.
const THEME = Object.freeze({ ...TOKEN_VALUES,
  'surface.void': '#080808', 'surface.ambient': '#101010', 'surface.presence': '#171614',
  'surface.interaction': '#20201e', 'surface.floating': '#252422', 'surface.approval': '#28251f',
  'surface.security': '#2b1e20', 'text.primary': '#f4efe5', 'text.secondary': '#c6c1b7',
  'text.metadata': '#a49f95', 'border.subtle': '#504b40', 'focus.visible': '#f5dcaa',
  'interactive.primary': '#ddc18a',
});
module.exports = { THEME };

},
"src/ui-platform/accessibility.js":function(module,exports,require){
'use strict';
function reducedMotionPreference({ matchMedia = globalThis.matchMedia } = {}) { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
function visuallyHiddenProps() { return { className: 'damar-visually-hidden', style: { position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 } }; }
function liveRegionProps(kind = 'polite') { if (!['polite', 'assertive', 'off'].includes(kind)) throw new TypeError('invalid live region'); return { role: kind === 'assertive' ? 'alert' : 'status', 'aria-live': kind, 'aria-atomic': 'true' }; }
function focusRingProps() { return { className: 'damar-focusable', 'data-focus-ring': 'visible' }; }
function accessibleStatus({ label, icon = '•', tone = 'neutral' }) { return Object.freeze({ label, icon, tone, text: `${icon} ${label}`, redundantCue: true }); }
module.exports = { reducedMotionPreference, visuallyHiddenProps, liveRegionProps, focusRingProps, accessibleStatus };

},
"src/ui-platform/apiClient.js":function(module,exports,require){
'use strict';

class ApiError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ApiError'; Object.assign(this, details); }
}

class ApiClient {
  constructor({ baseUrl = 'http://127.0.0.1:3000', fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 10000, session = null, correlationId = () => `ui-${Date.now()}-${Math.random().toString(16).slice(2)}` } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.session = session; this.correlationId = correlationId;
  }
  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new ApiError('fetch unavailable', { kind: 'configuration' });
    const requestId = this.correlationId();
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const auth = this.session?.authorizationHeader?.() ?? {};
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': requestId, ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!response.ok) throw new ApiError(data?.message ?? `HTTP ${response.status}`, { status: response.status, kind: response.status === 401 ? 'authentication' : response.status === 403 ? 'authority_denial' : 'network', requestId, data });
      return { data, status: response.status, requestId, headers: response.headers };
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('request cancelled or timed out', { kind: 'network', requestId, cause: error });
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.message, { kind: 'network', requestId, cause: error });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort); }
  }
}

module.exports = { ApiClient, ApiError };

},
"src/ui-platform/browser/runtime.js":function(module,exports,require){
'use strict';
const { Router, routeFor } = require("src/ui-platform/routing.js");
const { tokenStyle } = require("src/ui-platform/tokens.js");
const { bindVisualState } = require("src/ui-platform/stateBinding.js");
const { mountShell } = require("src/ui-platform/shells.js");
const { ApiClient } = require("src/ui-platform/apiClient.js");

// Own only browser event attachment. Matching, registry, history and current state
// belong to the shared Router. Public navigation after unmount is a safe no-op.
function createRouter(window, render, options = {}) {
  const router = new Router({ ...options, history: window.history, onNavigate: render });
  const navigate = router.navigate.bind(router);
  let mounted = false;
  router.navigate = (path, options = {}) => mounted ? navigate(path, typeof options === 'boolean' ? { replace: options } : options) : router.current;
  const handlePopState = () => router.navigate(window.location.pathname, { replace: true });
  router.mount = () => { if (mounted) return; mounted = true; window.addEventListener('popstate', handlePopState); };
  router.unmount = () => { if (!mounted) return; mounted = false; window.removeEventListener('popstate', handlePopState); };
  Object.defineProperty(router, 'mounted', { get: () => mounted });
  return router;
}
function boot(document = globalThis.document, window = globalThis.window, options = {}) {
  if (!document || !window) throw new Error('browser globals required');
  const app = document.querySelector('#app'); if (!app) throw new Error('missing #app root');
  let shell = null; let disposeShell = null;
  const runtime = {
    visualState: bindVisualState({}).visualState, router: null, mounted: false,
    applyTokens(values) {
      if (!runtime.mounted) return;
      for (const [name, value] of Object.entries(tokenStyle('dark', values))) document.documentElement.style.setProperty(name, value);
    },
    setState(projection) {
      if (!runtime.mounted) return;
      const binding = bindVisualState(projection);
      runtime.visualState = binding.visualState;
      const live = shell?.querySelector('.damar-state'); if (live) live.textContent = binding.visualState;
      return binding;
    }
  };
  const removeShell = () => { disposeShell?.(); disposeShell = null; shell = null; };
  const render = ({ route }) => {
    if (!runtime.mounted) return; removeShell();
    disposeShell = mountShell(app, { kind: route.surface, router: runtime.router, route, state: { label: runtime.visualState }, onNavigate: ({ root }) => { shell = root; } });
  };
  runtime.router = createRouter(window, render, options);
  runtime.mount = () => {
    if (runtime.mounted) return;
    runtime.mounted = true; runtime.applyTokens(options.tokenValues); runtime.router.mount();
    const path = window.location.pathname;
    runtime.router.navigate(routeFor(path, runtime.router.routes) ? path : '/s/web_dashboard', { replace: true });
  };
  runtime.unmount = () => { if (!runtime.mounted) return; runtime.mounted = false; runtime.router.unmount(); removeShell(); };
  runtime.mount(); return runtime;
}
module.exports = { boot, route: routeFor, semanticTokens: tokenStyle, ApiClient };

},
"src/ui-platform/commandClient.js":function(module,exports,require){
'use strict';
const { COMMAND_KINDS, requiredString } = require("src/ui-platform/contracts.js");

class CommandClient {
  constructor(api) { this.api = api; }
  async send({ kind, operation, target, payload = {}, idempotencyKey = null, signal } = {}) {
    if (!COMMAND_KINDS.includes(kind)) throw new TypeError(`invalid command kind: ${kind}`);
    requiredString(operation, 'operation');
    const request = { kind, operation, target: target ?? null, payload, idempotencyKey };
    return this.api.request('/api/ui/commands', { method: 'POST', body: request, signal });
  }
  async decideApproval({ approvalId, decision, reason = null, signal }) { return this.send({ kind: 'APPROVAL_DECISION', operation: 'approval.decide', target: { approval_id: requiredString(approvalId, 'approvalId') }, payload: { decision, reason }, signal }); }
}

module.exports = { CommandClient };

},
"src/ui-platform/components.js":function(module,exports,require){
'use strict';
const { accessibleStatus, focusRingProps, liveRegionProps } = require("src/ui-platform/accessibility.js");
const { token } = require("src/ui-platform/tokens.js");

function primitive(component, props = {}, children = []) { return Object.freeze({ component, props, children: Array.isArray(children) ? children : [children] }); }
function Button(props = {}, children = []) { return primitive('Button', { type: 'button', ...focusRingProps(), ...props }, children); }
function IconButton(props = {}) { return Button({ 'aria-label': props.label, ...props, iconOnly: true }); }
function TextInput(props = {}) { return primitive('TextInput', { type: 'text', ...focusRingProps(), ...props }); }
function StateIndicator({ state, label = state, icon = '•', tone = 'neutral', ...props }) { return primitive('StateIndicator', { ...accessibleStatus({ label, icon, tone }), 'data-state': state, ...props }); }
function HealthIndicator({ state = 'UNKNOWN', label = state, ...props }) { return StateIndicator({ state, label, icon: state === 'HEALTHY' ? '✓' : state === 'UNKNOWN' ? '?' : '!', tone: state === 'HEALTHY' ? 'success' : 'warning', ...props }); }
function Stack(props = {}, children = []) { return primitive('Stack', { role: 'group', ...props }, children); }
function Inline(props = {}, children = []) { return primitive('Inline', { role: 'group', ...props }, children); }
function Panel(props = {}, children = []) { return primitive('Panel', { style: { background: token('surface.interaction') }, ...props }, children); }
function Dialog(props = {}, children = []) { return primitive('Dialog', { role: 'dialog', 'aria-modal': 'true', ...props }, children); }
function Drawer(props = {}, children = []) { return primitive('Drawer', { role: 'complementary', ...props }, children); }
function Progress({ value = null, label = 'Progress', ...props } = {}) { return primitive('Progress', { role: 'progressbar', 'aria-label': label, ...(value == null ? { 'aria-valuetext': 'Progress indeterminate; duration unknown' } : { 'aria-valuenow': value }), ...props }); }
function Skeleton(props = {}) { return primitive('Skeleton', { 'aria-hidden': 'true', ...props }); }
function EmptyState(props = {}, children = []) { return primitive('EmptyState', props, children); }
function ErrorState({ kind = 'unknown', message = 'Something went wrong', ...props } = {}) { return primitive('ErrorState', { ...liveRegionProps('polite'), 'data-error-kind': kind, message, ...props }); }
function DegradedState(props = {}) { return primitive('DegradedState', { ...liveRegionProps('polite'), ...props }); }
function Code(props = {}, children = []) { return primitive('Code', { ...props, 'data-monospace': 'true' }, children); }
function VisuallyHidden(props = {}, children = []) { return primitive('VisuallyHidden', props, children); }
function setAttributes(element, props = {}) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || key === 'children' || key === 'style') continue;
    const name = key === 'className' ? 'class' : key;
    if (name === 'onClick' || name.startsWith('on')) { element.addEventListener(name.slice(2).toLowerCase(), value); continue; }
    if (name === 'text') { element.textContent = String(value); continue; }
    if (name === 'message') { element.textContent = String(value); continue; }
    if (value === true) element.setAttribute(name, ''); else if (value !== false) element.setAttribute(name, String(value));
  }
  if (props.style) Object.assign(element.style, props.style);
  return element;
}
function renderPrimitive(document, descriptor) {
  const tag = ({ Button: 'button', IconButton: 'button', TextInput: 'input', Dialog: 'dialog', Drawer: 'aside', Progress: 'progress', Code: 'code', VisuallyHidden: 'span', Stack: 'div', Panel: 'section', EmptyState: 'section', ErrorState: 'div', DegradedState: 'div', StateIndicator: 'span', HealthIndicator: 'span', Skeleton: 'span' })[descriptor.component] || 'div';
  const element = document.createElement(tag); element.dataset.component = descriptor.component;
  setAttributes(element, descriptor.props);
  if (descriptor.component === 'TextInput') element.type = descriptor.props.type || 'text';
  if (descriptor.component === 'Progress' && descriptor.props['aria-valuenow'] != null) element.value = descriptor.props['aria-valuenow'];
  for (const child of descriptor.children || []) element.append(child?.component ? renderPrimitive(document, child) : document.createTextNode(String(child ?? '')));
  return element;
}
function mountPrimitive(container, descriptor) { if (!container?.ownerDocument) throw new TypeError('container must be a DOM element'); const element = renderPrimitive(container.ownerDocument, descriptor); container.append(element); return () => element.remove(); }
const CONTRACT_STUBS = Object.freeze(['PresenceCore', 'PresenceShell', 'MissionCard', 'ApprovalCard', 'NotificationItem', 'EntityHeader', 'CapabilityStateStack', 'ProviderCard', 'ModelCard', 'DeviceCard', 'GatewayCard', 'SecurityIncidentCard', 'ObservationCard', 'EvidencePanel', 'Timeline', 'Inspector', 'CommandPalette', 'DataTable']);
module.exports = { primitive, Button, IconButton, TextInput, StateIndicator, HealthIndicator, Stack, Inline, Panel, Dialog, Drawer, Progress, Skeleton, EmptyState, ErrorState, DegradedState, Code, VisuallyHidden, renderPrimitive, mountPrimitive, CONTRACT_STUBS };

},
"src/ui-platform/contracts.js":function(module,exports,require){
'use strict';

const DENSITIES = Object.freeze(['NORMAL', 'POWER', 'FORENSIC']);
const FEATURE_CLASSES = Object.freeze([
  'CURRENT_IMPLEMENTED', 'CURRENT_PARTIAL', 'CURRENT_INTERNAL',
  'DESIGNED_FOR_IMPLEMENTATION', 'FUTURE_CAPABILITY_DEPENDENT'
]);
const COMMAND_KINDS = Object.freeze([
  'READ', 'NONCONSEQUENTIAL_COMMAND', 'CONSEQUENTIAL_COMMAND',
  'APPROVAL_DECISION', 'CONFIGURATION', 'ADMINISTRATION', 'FORENSIC'
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function assertOneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of ${values.join(', ')}`);
  return value;
}

function normalizeFreshness(value) {
  return assertOneOf(value ?? 'UNKNOWN', ['LIVE', 'EVENTUAL', 'STALE', 'UNKNOWN'], 'freshness');
}

function normalizeReadModel(record = {}) {
  return Object.freeze({
    data: record.data,
    status: assertOneOf(record.status ?? 'unknown', ['loading', 'ready', 'empty', 'stale', 'unknown', 'degraded', 'failed'], 'status'),
    freshness: normalizeFreshness(record.freshness),
    asOf: record.asOf ?? null,
    revision: record.revision ?? null,
    cursor: record.cursor ?? null,
    provenance: record.provenance ?? null,
    redaction: record.redaction ?? null,
    requestId: record.requestId ?? null,
    error: record.error ?? null
  });
}

function assertDensity(value) { return assertOneOf(value, DENSITIES, 'density'); }
function assertFeatureClass(value) { return assertOneOf(value, FEATURE_CLASSES, 'current_future_classification'); }

function assertNoCanonicalOwnership(moduleRecord) {
  if (moduleRecord.state_ownership === 'canonical backend state') {
    throw new Error(`UI module ${moduleRecord.module_id} cannot own canonical backend state`);
  }
  return true;
}

module.exports = {
  DENSITIES, FEATURE_CLASSES, COMMAND_KINDS,
  requiredString, assertOneOf, assertDensity, assertFeatureClass,
  normalizeReadModel, assertNoCanonicalOwnership
};

},
"src/ui-platform/entityRefs.js":function(module,exports,require){
'use strict';

const ENTITY_TYPES = Object.freeze([
  'mission', 'approval', 'device', 'capability', 'provider', 'model', 'model_gateway',
  'agent_gateway', 'security_incident', 'audit_event', 'memory_item', 'notification',
  'project', 'repository', 'workspace', 'coding_mission', 'diff', 'review'
]);

function entityRef(entityType, entityId, options = {}) {
  if (!ENTITY_TYPES.includes(entityType)) throw new TypeError(`unknown entity type: ${entityType}`);
  if (typeof entityId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(entityId)) throw new TypeError('entity_id must be a safe canonical identifier');
  return Object.freeze({ entity_type: entityType, entity_id: entityId, context: options.context ?? null, source_surface: options.sourceSurface ?? null });
}

function deepLink(ref, options = {}) {
  const value = typeof ref === 'string' ? JSON.parse(ref) : ref;
  const normalized = entityRef(value.entity_type, value.entity_id, value);
  const surface = options.surface ?? value.source_surface ?? 'web_dashboard';
  if (!['idle_presence', 'web_dashboard', 'cli', 'companion', 'voice'].includes(surface)) throw new TypeError('unsupported handoff surface');
  const path = `/s/${encodeURIComponent(surface)}/entity/${encodeURIComponent(normalized.entity_type)}/${encodeURIComponent(normalized.entity_id)}`;
  return Object.freeze({ ...normalized, surface, path, query: options.query ?? null });
}

function parseDeepLink(url, base = 'http://localhost') {
  const parsed = new URL(url, base);
  const match = parsed.pathname.match(/^\/s\/([^/]+)\/entity\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return deepLink(entityRef(decodeURIComponent(match[2]), decodeURIComponent(match[3]), { sourceSurface: decodeURIComponent(match[1]) }));
}

module.exports = { ENTITY_TYPES, entityRef, deepLink, parseDeepLink };

},
"src/ui-platform/projections.js":function(module,exports,require){
'use strict';

function approvalProjection(record = {}) { return Object.freeze({ approvalId: record.approval_id ?? record.approvalId, state: record.state ?? 'UNKNOWN', expiresAt: record.expires_at ?? null, risk: record.risk ?? null, effect: record.effect ?? null, authorityResult: record.authority_result ?? 'UNKNOWN', verificationResult: record.verification_result ?? 'UNKNOWN', source: 'canonical_approval_projection' }); }
function notificationProjection(record = {}) { return Object.freeze({ notificationId: record.notification_id ?? record.notificationId, deliveryState: record.delivery_state ?? 'UNKNOWN', acknowledgementState: record.acknowledgement_state ?? 'UNACKNOWLEDGED', urgency: record.urgency ?? 'NORMAL', privacySensitivity: record.privacy_sensitivity ?? 'NORMAL', sourceEvent: record.source_event ?? null, targetSurfaces: record.target_surfaces ?? [], source: 'canonical_notification_projection' }); }

module.exports = { approvalProjection, notificationProjection };

},
"src/ui-platform/queryCache.js":function(module,exports,require){
'use strict';
class QueryCache {
  constructor({ now = () => Date.now(), staleAfterMs = 30000, maxEntries = 100, failedTtlMs = 5000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(failedTtlMs) || failedTtlMs < 0) throw new TypeError('invalid cache bounds');
    Object.assign(this, { now, staleAfterMs, maxEntries, failedTtlMs }); this.records = new Map(); this.inflight = new Map();
  }
  key(query) { return typeof query === 'string' ? query : JSON.stringify(query); }
  prune() { for (const [key, record] of this.records) if (record.error && this.now() - record.updatedAt >= this.failedTtlMs) this.records.delete(key); }
  store(key, record) {
    this.prune(); this.records.delete(key); this.records.set(key, record);
    while (this.records.size > this.maxEntries) {
      // Prefer evicting failures so a failure storm cannot displace successes.
      const failed = [...this.records].find(([, value]) => value.error);
      this.records.delete(failed ? failed[0] : this.records.keys().next().value);
    }
  }
  get(query) { this.prune(); const record = this.records.get(this.key(query)); if (!record) return null; return { ...record, stale: record.stale || this.now() - record.updatedAt > this.staleAfterMs }; }
  invalidate(query) { if (query === undefined) this.records.clear(); else this.records.delete(this.key(query)); }
  async fetch(query, loader, { force = false, signal } = {}) {
    const key = this.key(query); const cached = this.get(query); if (!force && cached && !cached.stale) return { ...cached, cacheHit: true };
    if (signal?.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' });
    if (this.inflight.has(key)) return this.consume(key, this.inflight.get(key), signal);
    const controller = new AbortController();
    const eligible = () => !controller.signal.aborted && this.inflight.get(key) === work;
    const work = Promise.resolve().then(() => { if (controller.signal.aborted) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' }); return loader({ signal: controller.signal }); }).then((data) => {
      if (!eligible()) throw Object.assign(new Error('query cancelled'), { name: 'AbortError' });
      const record = { key, data, updatedAt: this.now(), stale: false }; this.store(key, record); return { ...record, cacheHit: false };
    }).catch((error) => { if (eligible() && error.name !== 'AbortError') this.store(key, { key, data: null, updatedAt: this.now(), stale: true, error }); throw error; }).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); });
    work.controller = controller; work.consumers = new Set(); this.inflight.set(key, work); return this.consume(key, work, signal);
  }
  consume(key, work, signal) {
    // Caller cancellation releases only this consumer. The final consumer ends
    // shared commit authority; cancel(query) explicitly ends all consumers.
    return new Promise((resolve, reject) => {
      let active = true;
      const cleanup = () => { active = false; signal?.removeEventListener('abort', cancel); work.consumers.delete(cancel); };
      const cancel = () => {
        if (!active) return;
        cleanup(); reject(Object.assign(new Error('query cancelled'), { name: 'AbortError' }));
        if (!work.consumers.size) { work.controller.abort(); if (this.inflight.get(key) === work) this.inflight.delete(key); }
      };
      work.consumers.add(cancel); signal?.addEventListener('abort', cancel, { once: true });
      work.then(value => { if (active) { cleanup(); resolve(value); } }, error => { if (active) { cleanup(); reject(error); } });
    });
  }
  cancel(query) {
    const key = this.key(query), work = this.inflight.get(key);
    if (work) { work.controller.abort(); this.inflight.delete(key); for (const cancel of [...work.consumers]) cancel(); }
    return Boolean(work);
  }
}
module.exports = { QueryCache };

},
"src/ui-platform/readModelClient.js":function(module,exports,require){
'use strict';
const { normalizeReadModel } = require("src/ui-platform/contracts.js");

class ReadModelClient {
  constructor(api) { this.api = api; }
  async snapshot(path, options = {}) { try { const result = await this.api.request(path, options); return normalizeReadModel({ data: result.data, status: Array.isArray(result.data) && result.data.length === 0 ? 'empty' : result.data?.degraded ? 'degraded' : 'ready', freshness: result.data?.freshness ?? 'LIVE', asOf: result.data?.as_of ?? new Date().toISOString(), revision: result.data?.revision ?? null, provenance: result.data?.provenance ?? null, requestId: result.requestId }); } catch (error) { return normalizeReadModel({ status: error.kind === 'network' ? 'degraded' : 'failed', freshness: 'UNKNOWN', error: { message: error.message, kind: error.kind } }); } }
}

module.exports = { ReadModelClient };

},
"src/ui-platform/responsive.js":function(module,exports,require){
'use strict';
const BREAKPOINTS = Object.freeze({ phone: 0, tablet: 640, compactDesktop: 960, wideDesktop: 1280 });
function responsiveMode(width) { if (width < BREAKPOINTS.tablet) return 'phone'; if (width < BREAKPOINTS.compactDesktop) return 'tablet'; if (width < BREAKPOINTS.wideDesktop) return 'compactDesktop'; return 'wideDesktop'; }
function responsiveProps({ stackAt = 'tablet', drawerAt = 'tablet', tableFallbackAt = 'phone' } = {}) { return Object.freeze({ stackAt, drawerAt, tableFallbackAt, breakpoints: BREAKPOINTS }); }
module.exports = { BREAKPOINTS, responsiveMode, responsiveProps };

},
"src/ui-platform/routing.js":function(module,exports,require){
'use strict';

const { deepLink } = require("src/ui-platform/entityRefs.js");

const ROUTES = Object.freeze([
  { route_id: 'idle.home', surface: 'idle_presence', path_pattern: '/s/idle_presence', entity_type: null, implementation_state: 'shell', auth_requirement: 'session', density_modes: ['NORMAL'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  { route_id: 'dashboard.home', surface: 'web_dashboard', path_pattern: '/s/web_dashboard', entity_type: null, implementation_state: 'shell', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  { route_id: 'entity.generic', surface: 'web_dashboard', path_pattern: '/s/web_dashboard/entity/:entity_type/:entity_id', entity_type: '*', implementation_state: 'contract', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: 'CURRENT_IMPLEMENTED' },
  ...['mission', 'approval', 'device', 'capability', 'provider', 'model', 'model_gateway', 'agent_gateway', 'security_incident', 'audit_event', 'memory_item', 'notification', 'project', 'repository', 'workspace', 'coding_mission'].map((type) => ({ route_id: `entity.${type}`, surface: 'web_dashboard', path_pattern: `/s/web_dashboard/entity/${type}/:entity_id`, entity_type: type, implementation_state: 'contract', auth_requirement: 'session', density_modes: ['NORMAL', 'POWER', 'FORENSIC'], current_future_classification: type === 'project' || type === 'repository' || type === 'workspace' || type === 'coding_mission' ? 'DESIGNED_FOR_IMPLEMENTATION' : 'CURRENT_IMPLEMENTED' }))
]);

function routeFor(path, routes = ROUTES) {
  const match = routes.find((route) => {
    const pattern = route.path_pattern.replace(/:[^/]+/g, '[^/]+').replace('*', '[^/]+');
    return new RegExp(`^${pattern}$`).test(path);
  });
  return match ?? null;
}

class Router {
  constructor({ routes = ROUTES, history = globalThis.history, onNavigate = () => {} } = {}) { this.routes = routes; this.history = history; this.onNavigate = onNavigate; this.current = null; }
  navigate(path, { replace = false, state = null } = {}) { const route = routeFor(path, this.routes); if (!route) throw new Error(`unknown route: ${path}`); (replace ? this.history?.replaceState : this.history?.pushState)?.call(this.history, state, '', path); this.current = { route, path, state }; this.onNavigate(this.current); return this.current; }
  navigateEntity(ref, options) { return this.navigate(deepLink(ref, options).path); }
}

module.exports = { ROUTES, routeFor, Router };

},
"src/ui-platform/shells.js":function(module,exports,require){
'use strict';
const { responsiveProps } = require("src/ui-platform/responsive.js");
const { Button, renderPrimitive } = require("src/ui-platform/components.js");
function shell(id, { children = [], density = 'NORMAL', handoff = null } = {}) { return Object.freeze({ shell_id: id, density, children, responsive: responsiveProps(), handoff, canonical_state_owner: 'none', boundary: true }); }
function idlePresenceShell(options) { return shell('idle_presence', options); }
function dashboardShell(options) { return shell('web_dashboard', options); }
function entityInspector(ref, { density = 'POWER' } = {}) { return Object.freeze({ type: 'entity_inspector', entity_ref: ref, density, state_owner: 'projection_only' }); }
function commandPalette({ entries = [] } = {}) { return Object.freeze({ type: 'command_palette', entries, authority: 'canonical_command_client_only' }); }
function mountShell(container, { kind = 'idle_presence', density = 'NORMAL', router = null, onNavigate = () => {}, state = {}, route = null } = {}) {
  if (!container?.ownerDocument) throw new TypeError('container must be a DOM element');
  const doc = container.ownerDocument; const root = doc.createElement('main'); root.className = `damar-shell damar-shell-${kind}`; root.dataset.density = density; root.tabIndex = -1; root.setAttribute('aria-label', kind === 'idle_presence' ? 'Damar Idle foundation' : 'Damar Dashboard foundation');
  const status = doc.createElement('div'); status.className = 'damar-status damar-state'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.textContent = state.label || 'Ready';
  if (kind === 'idle_presence') { const presence = doc.createElement('section'); presence.className = 'damar-presence-slot'; presence.setAttribute('aria-label', 'Presence core slot'); presence.textContent = 'Presence foundation'; const overlay = doc.createElement('aside'); overlay.className = 'damar-overlay-slot'; overlay.setAttribute('aria-label', 'Overlay layer slot'); overlay.hidden = true; root.append(presence, overlay); }
  else { const nav = doc.createElement('nav'); nav.className = 'damar-navigation'; nav.setAttribute('aria-label', 'Dashboard navigation'); for (const [label, path] of [['Idle', '/s/idle_presence'], ['Overview', '/s/web_dashboard']]) { const button = renderPrimitive(doc, Button({ text: label, onClick: () => router?.navigate(path) })); nav.append(button); } const outlet = doc.createElement('section'); outlet.className = 'damar-route-outlet'; outlet.setAttribute('aria-label', 'Route outlet'); if (route) { outlet.setAttribute('data-route-id', route.route_id); outlet.textContent = route.route_id === 'dashboard.home' ? 'Dashboard foundation' : `Route foundation: ${route.route_id}`; } const entity = doc.createElement('section'); entity.className = 'damar-entity-outlet'; entity.setAttribute('aria-label', 'Entity view outlet'); const inspector = doc.createElement('aside'); inspector.className = 'damar-inspector'; inspector.setAttribute('aria-label', 'Inspector and drawer region'); root.append(nav, outlet, entity, inspector); }
  root.append(status); container.replaceChildren(root); onNavigate({ root, status }); return () => { root.replaceChildren(); root.remove(); };
}
module.exports = { idlePresenceShell, dashboardShell, entityInspector, commandPalette, mountShell };

},
"src/ui-platform/stateBinding.js":function(module,exports,require){
'use strict';
const w3States = require("docs/uix-w3/VISUAL_STATE_MODEL.json");
const priority = require("docs/uix-w3/STATE_PRIORITY_MATRIX.json");

const VISUAL_STATES = Object.freeze(w3States.states.map((state) => state.visual_state_id));
const PRIORITY = Object.freeze(priority.precedence_high_to_low);

function mapSource(source = {}) {
  if (source.securityAlert) return 'SECURITY_ALERT';
  if (source.attention) return 'ATTENTION';
  if (source.approval?.state === 'PENDING' || source.authorityResult === 'DEFER') return 'WAITING_FOR_AUTHORITY';
  if (source.mission?.state === 'WAITING_FOR_USER' || source.task?.state === 'BLOCKED_USER_INPUT') return 'WAITING_FOR_USER';
  if (source.verificationPending) return 'VERIFYING';
  if (source.mission?.state === 'RUNNING' || source.task?.state === 'EXECUTING') return 'ACTING';
  if (source.degraded || source.freshness === 'STALE') return 'DEGRADED';
  if (source.offline) return 'OFFLINE';
  if (source.freshness === 'UNKNOWN') return 'UNKNOWN';
  if (source.presence === 'thinking' || source.conversation === 'processing') return 'THINKING';
  if (source.listening) return 'LISTENING';
  if (source.mission?.state === 'COMPLETED' && (!source.verificationRequired || source.verificationResult === 'PASS')) return 'COMPLETED';
  if (source.presence === 'dormant') return 'DORMANT';
  return 'IDLE';
}

function resolveVisualState(candidates) { const values = candidates.filter((state) => VISUAL_STATES.includes(state)); return PRIORITY.find((state) => values.includes(state)) ?? 'UNKNOWN'; }
function bindVisualState(source) { const base = mapSource(source); const candidates = [base]; if (source.securityAlert) candidates.push('SECURITY_ALERT'); if (source.attention) candidates.push('ATTENTION'); return Object.freeze({ visualState: resolveVisualState(candidates), baseState: base, progress: typeof source.progress === 'number' && source.progress >= 0 && source.progress <= 1 ? source.progress : null, source: 'read_model_projection', isCanonical: false }); }
function motionFor(visualState, reducedMotion = false) { const record = w3States.states.find((state) => state.visual_state_id === visualState); return Object.freeze({ profile: record?.motion_profile ?? 'unknown_static', reducedMotion: Boolean(reducedMotion), mode: reducedMotion ? 'static_semantic_fallback' : 'semantic_motion' }); }

module.exports = { VISUAL_STATES, PRIORITY, mapSource, resolveVisualState, bindVisualState, motionFor };

},
"src/ui-platform/subscriptions.js":function(module,exports,require){
'use strict';
class SubscriptionManager {
  constructor({ readModelClient, onUpdate = () => {}, onStatus = () => {}, maxReconnects = 3 } = {}) {
    Object.assign(this, { readModelClient, onUpdate, onStatus, maxReconnects });
    this.closed = true; this.lastRevision = null; this.disposeActive = null;
  }
  attach({ snapshot, stream, apply = (value) => value } = {}) {
    this.disposeActive?.();
    const controller = new AbortController(); let active = true; let timer = null; let finishDelay = null; let revision = null;
    this.closed = false;
    const status = (...args) => { if (active) this.onStatus(...args); };
    const publish = (value, source) => { if (!active) return; revision = value.revision ?? revision; this.lastRevision = revision; this.onUpdate(value, { source }); };
    const dispose = () => {
      if (!active) return;
      active = false; controller.abort(); clearTimeout(timer); finishDelay?.();
      if (this.disposeActive === dispose) { this.closed = true; this.disposeActive = null; }
    };
    this.disposeActive = dispose;
    const start = async () => {
      status('snapshot_loading'); if (!active) return;
      const initial = await snapshot({ signal: controller.signal }); if (!active) return;
      publish(initial, 'snapshot'); status('connected'); if (!active || !stream) return;
      let reconnects = 0;
      while (active) {
        try {
          for await (const event of stream({ signal: controller.signal, after: revision })) {
            if (!active) break;
            if (event.revision && revision && event.revision <= revision) continue;
            if (event.gap) {
              status('resync_required'); if (!active) break;
              const fresh = await snapshot({ signal: controller.signal }); if (!active) break;
              publish(fresh, 'resync'); continue;
            }
            const next = event.revision ?? revision;
            const value = apply(event, next); if (!active) break;
            revision = next; this.lastRevision = next; publish(value, 'stream');
          }
          break;
        } catch (error) {
          if (!active) break;
          status('disconnected', error); if (!active) break;
          if (++reconnects > this.maxReconnects) { status('failed', error); break; }
          status('reconnecting', { attempt: reconnects }); if (!active) break;
          await new Promise((resolve) => { finishDelay = resolve; timer = setTimeout(resolve, Math.min(1000 * reconnects, 3000)); });
          timer = null; finishDelay = null;
        }
      }
    };
    start().catch((error) => status('failed', error));
    return dispose;
  }
}
module.exports = { SubscriptionManager };

},
"src/ui-platform/tokens.js":function(module,exports,require){
'use strict';
const contract = require("docs/uix-w3/SEMANTIC_DESIGN_TOKENS.json");
const TOKEN_VALUES = Object.freeze({
  'surface.void': '#090b10', 'surface.ambient': '#10151d', 'surface.presence': '#152333', 'surface.interaction': '#1b2430', 'surface.floating': '#222e3c', 'surface.approval': '#26333d', 'surface.security': '#35242b',
  'text.primary': '#f3f5f7', 'text.secondary': '#b8c2cc', 'text.metadata': '#8794a1', 'border.subtle': '#33404d', 'focus.visible': '#83d7ff', 'interactive.primary': '#6bd6b0',
  'status.neutral': '#9aa7b3', 'status.information': '#72b7ed', 'status.active': '#c6a7ff', 'status.success': '#6bd6b0', 'status.warning': '#efc266', 'status.danger': '#f07878',
  'security.suspicious': '#efc266', 'security.confirmed': '#f07878', 'authority.requested': '#efc266', 'authority.denied': '#f07878', 'approval.pending': '#efc266',
  'awareness.fresh': '#6bd6b0', 'awareness.stale': '#efc266', 'provider.healthy': '#6bd6b0', 'provider.degraded': '#efc266', 'device.trusted': '#6bd6b0', 'device.unknown': '#9aa7b3', 'data.verified': '#6bd6b0', 'data.uncertain': '#efc266', 'degraded.offline': '#9aa7b3'
});
const TOKEN_IDS = Object.freeze(contract.tokens.map((token) => token.token_id));
function token(name) { if (!TOKEN_IDS.includes(name)) throw new Error(`unknown semantic token: ${name}`); return `var(--damar-${name.replaceAll('.', '-')})`; }
function tokenStyle(theme = 'dark', values = TOKEN_VALUES) { return Object.fromEntries(TOKEN_IDS.map((id) => [`--damar-${id.replaceAll('.', '-')}`, values[id] ?? TOKEN_VALUES[id] ?? 'currentColor'])); }
module.exports = { TOKEN_IDS, TOKEN_VALUES, token, tokenStyle, contract };

},
"src/voice/stateMachine.js":function(module,exports,require){
/**
 * Mesin status sesi suara — lifecycle eksplisit.
 *
 *   IDLE → WAKE_DETECTED → LISTENING → TRANSCRIBING → THINKING
 *        → EXECUTING → SPEAKING → IDLE
 *
 * Sifatnya adalah otoritas tunggal atas "di mana Damar sekarang".
 * Semua transisi lewat `transit()`, yang memvalidasi agar tidak ada
 * lompatan ilegal (mis. dari IDLE langsung ke SPEAKING) dan mencatat
 * waktu masuk tiap status — dasar timeout & cancellation.
 */

const STATES = Object.freeze({
    IDLE: "idle",
    WAKE_DETECTED: "wake_detected",
    LISTENING: "listening",
    TRANSCRIBING: "transcribing",
    THINKING: "thinking",
    EXECUTING: "executing",
    SPEAKING: "speaking"
});

// Peta transisi sah. Kunci = asal, nilai = himpunan tujuan.
const TRANSISI = Object.freeze({
    [STATES.IDLE]: new Set([STATES.WAKE_DETECTED]),
    [STATES.WAKE_DETECTED]: new Set([STATES.LISTENING, STATES.SPEAKING, STATES.IDLE]),
    [STATES.LISTENING]: new Set([STATES.TRANSCRIBING, STATES.IDLE]),
    [STATES.TRANSCRIBING]: new Set([STATES.THINKING, STATES.IDLE]),
    [STATES.THINKING]: new Set([STATES.EXECUTING, STATES.SPEAKING, STATES.IDLE]),
    [STATES.EXECUTING]: new Set([STATES.SPEAKING, STATES.IDLE]),
    [STATES.SPEAKING]: new Set([STATES.IDLE, STATES.LISTENING]) // barge-in: kembali dengar
});

class StateMachine {

    constructor(onTransition = null) {

        this.state = STATES.IDLE;
        this.enteredAt = Date.now();
        this.onTransition = onTransition; // dipanggil (from, to)

    }

    get current() {
        return this.state;
    }

    /** Berapa ms sejak masuk status sekarang. */
    elapsed(now = Date.now()) {
        return now - this.enteredAt;
    }

    /**
     * Pindah status bila sah.
     * @returns {boolean} true bila pindah, false bila transisi ditolak.
     */
    transit(ke) {

        const from = this.state;

        if (ke === from) return true; // no-op legal

        const sah = TRANSISI[from]?.has(ke);

        if (!sah) return false;

        const lama = this.state;

        this.state = ke;
        this.enteredAt = Date.now();

        if (this.onTransition) {
            try { this.onTransition(lama, ke); }
            catch { /* observer tidak boleh merusak mesin */ }
        }

        return true;

    }

    /** Paksa kembali ke IDLE (reset paksa, mis. cancellation). */
    reset() {
        const lama = this.state;
        this.state = STATES.IDLE;
        this.enteredAt = Date.now();
        if (this.onTransition) {
            try { this.onTransition(lama, STATES.IDLE); }
            catch { /* abaikan */ }
        }
        return this;
    }

    potret() {
        return {
            state: this.state,
            enteredAt: new Date(this.enteredAt).toISOString(),
            elapsedMs: this.elapsed()
        };
    }

}

module.exports = { StateMachine, STATES, TRANSISI };

}
};const cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}globalThis.DamarPresenceRuntime=require("src/presence-ui/browser/runtime.js");})();
