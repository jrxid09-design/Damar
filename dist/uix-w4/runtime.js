(function(){'use strict';
const modules={
"docs/uix-w3/SEMANTIC_DESIGN_TOKENS.json":function(module,exports,require){
module.exports = {"schema_version":"uix-w3.semantic-tokens.v1","value_policy":"semantic_records_only; production color/type/spacing values are intentionally deferred to W4","tokens":[{"token_id":"surface.void","semantic_role":"deepest background","category":"surface","lightness_relationship":"lowest","contrast_requirement":"text and focus must meet accessible contrast","surface_usage":["all"],"state_usage":["OFFLINE","IDLE"],"accessibility_requirement":"never encode state by background alone"},{"token_id":"surface.ambient","semantic_role":"contextual ambient layer","category":"surface","lightness_relationship":"above void","contrast_requirement":"supporting text remains readable","surface_usage":["idle_presence","web_dashboard"],"state_usage":["IDLE","LISTENING"],"accessibility_requirement":"nonessential decoration removable"},{"token_id":"surface.presence","semantic_role":"presence anchor surface","category":"surface","lightness_relationship":"focused lift","contrast_requirement":"presence label and state cue readable","surface_usage":["idle_presence","companion"],"state_usage":["LISTENING","THINKING","ACTING"],"accessibility_requirement":"state also exposed as text and live region when relevant"},{"token_id":"surface.interaction","semantic_role":"primary readable interaction plane","category":"surface","lightness_relationship":"high enough separation from ambient","contrast_requirement":"body and control contrast","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"focus ring remains visible"},{"token_id":"surface.floating","semantic_role":"temporary elevated control","category":"elevation","lightness_relationship":"above interaction","contrast_requirement":"edge and content separation","surface_usage":["idle_presence","web_dashboard"],"state_usage":["ATTENTION","WAITING_FOR_USER"],"accessibility_requirement":"not the only location of actionable content"},{"token_id":"surface.approval","semantic_role":"authority decision plane","category":"approval","lightness_relationship":"high semantic separation","contrast_requirement":"decision controls and risk readable","surface_usage":["all approval-capable"],"state_usage":["WAITING_FOR_AUTHORITY"],"accessibility_requirement":"risk, expiry, and target announced"},{"token_id":"surface.security","semantic_role":"security attention plane","category":"security","lightness_relationship":"highest attention contrast without panic","contrast_requirement":"critical content and focus meet enhanced contrast","surface_usage":["all policy-permitted"],"state_usage":["SECURITY_ALERT"],"accessibility_requirement":"shape, label, sound policy, and text redundancy"},{"token_id":"text.primary","semantic_role":"primary human-readable content","category":"text","lightness_relationship":"highest on active surface","contrast_requirement":"WCAG AA minimum; enhanced for critical text","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"scales with user text settings"},{"token_id":"text.secondary","semantic_role":"supporting explanation","category":"text","lightness_relationship":"lower than primary but readable","contrast_requirement":"WCAG AA for normal text","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"not used for sole status cue"},{"token_id":"text.metadata","semantic_role":"timestamp, provenance, identifiers","category":"text","lightness_relationship":"subordinate","contrast_requirement":"readable at compact size","surface_usage":["web_dashboard","cli","forensic"],"state_usage":["all"],"accessibility_requirement":"never truncate canonical IDs without inspect affordance"},{"token_id":"border.subtle","semantic_role":"layer boundary","category":"border","lightness_relationship":"low separation","contrast_requirement":"supplemental only","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"never sole focus/status cue"},{"token_id":"focus.visible","semantic_role":"keyboard and assistive focus","category":"focus","lightness_relationship":"highest local contrast","contrast_requirement":"visible in all themes and layers","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"persistent while focused"},{"token_id":"interactive.primary","semantic_role":"safe primary action","category":"interactive","lightness_relationship":"prominent but not alarm-like","contrast_requirement":"control and label contrast","surface_usage":["all"],"state_usage":["all"],"accessibility_requirement":"minimum target and name"},{"token_id":"status.neutral","semantic_role":"no special attention","category":"status","lightness_relationship":"quiet","contrast_requirement":"text and shape redundant","surface_usage":["all"],"state_usage":["DORMANT","IDLE"],"accessibility_requirement":"label required when ambiguous"},{"token_id":"status.information","semantic_role":"informational change","category":"status","lightness_relationship":"noticeable not urgent","contrast_requirement":"color plus icon plus text","surface_usage":["all"],"state_usage":["LISTENING","VERIFYING"],"accessibility_requirement":"live-region policy"},{"token_id":"status.active","semantic_role":"currently processing or acting","category":"status","lightness_relationship":"localized energy","contrast_requirement":"color plus motion alternative plus label","surface_usage":["all"],"state_usage":["THINKING","ACTING"],"accessibility_requirement":"no fabricated progress"},{"token_id":"status.success","semantic_role":"verified favorable outcome","category":"status","lightness_relationship":"calm confirmation","contrast_requirement":"icon and text redundancy","surface_usage":["all"],"state_usage":["COMPLETED"],"accessibility_requirement":"only after truth permits"},{"token_id":"status.warning","semantic_role":"risk or degraded attention","category":"status","lightness_relationship":"visible caution","contrast_requirement":"not color-only","surface_usage":["all"],"state_usage":["DEGRADED","ATTENTION"],"accessibility_requirement":"text label and alert semantics as needed"},{"token_id":"status.danger","semantic_role":"user-correctable or consequential failure","category":"degraded_error","lightness_relationship":"strong but scoped","contrast_requirement":"enhanced contrast","surface_usage":["all"],"state_usage":["DEGRADED"],"accessibility_requirement":"action and cause explicit"},{"token_id":"security.suspicious","semantic_role":"security signal requiring review","category":"security","lightness_relationship":"distinct from generic warning","contrast_requirement":"shape and evidence label","surface_usage":["dashboard","idle_presence"],"state_usage":["SECURITY_ALERT"],"accessibility_requirement":"uncertainty visible"},{"token_id":"security.confirmed","semantic_role":"confirmed security incident","category":"security","lightness_relationship":"high attention","contrast_requirement":"enhanced contrast and persistent cue","surface_usage":["all policy-permitted"],"state_usage":["SECURITY_ALERT"],"accessibility_requirement":"source evidence and response boundary visible"},{"token_id":"authority.requested","semantic_role":"consequential request proposed","category":"authority","lightness_relationship":"neutral attention","contrast_requirement":"scope and risk readable","surface_usage":["approval-capable"],"state_usage":["WAITING_FOR_AUTHORITY"],"accessibility_requirement":"not styled as allowed"},{"token_id":"authority.denied","semantic_role":"authority denied effect","category":"authority","lightness_relationship":"firm neutral/danger","contrast_requirement":"decision text explicit","surface_usage":["all"],"state_usage":["ATTENTION","DEGRADED"],"accessibility_requirement":"not confused with runtime failure"},{"token_id":"approval.pending","semantic_role":"awaiting user/authority decision","category":"approval","lightness_relationship":"focused","contrast_requirement":"decision controls clear","surface_usage":["all approval-capable"],"state_usage":["WAITING_FOR_AUTHORITY"],"accessibility_requirement":"expiry and consequence announced"},{"token_id":"awareness.fresh","semantic_role":"bounded recent observation","category":"awareness","lightness_relationship":"quiet information","contrast_requirement":"freshness label readable","surface_usage":["idle_presence","web_dashboard"],"state_usage":["IDLE","ATTENTION"],"accessibility_requirement":"source and timestamp exposed"},{"token_id":"awareness.stale","semantic_role":"observation past freshness bound","category":"awareness","lightness_relationship":"muted caution","contrast_requirement":"stale marker readable","surface_usage":["all"],"state_usage":["DEGRADED"],"accessibility_requirement":"never presented as current"},{"token_id":"provider.healthy","semantic_role":"provider instance health evidence","category":"provider","lightness_relationship":"calm positive","contrast_requirement":"instance label and timestamp","surface_usage":["dashboard","cli"],"state_usage":["IDLE","ACTING"],"accessibility_requirement":"distinct from model and authority"},{"token_id":"provider.degraded","semantic_role":"provider routing limitation","category":"provider","lightness_relationship":"caution","contrast_requirement":"reason and fallback evidence","surface_usage":["dashboard","cli","forensic"],"state_usage":["DEGRADED"],"accessibility_requirement":"no false healthy badge"},{"token_id":"device.trusted","semantic_role":"paired/trust evidence","category":"device","lightness_relationship":"calm","contrast_requirement":"trust label and icon","surface_usage":["all"],"state_usage":["IDLE","ACTING"],"accessibility_requirement":"not equivalent to online"},{"token_id":"device.unknown","semantic_role":"device state not established","category":"device","lightness_relationship":"muted caution","contrast_requirement":"unknown label visible","surface_usage":["all"],"state_usage":["DEGRADED","OFFLINE"],"accessibility_requirement":"unknown != offline"},{"token_id":"data.verified","semantic_role":"verified evidence/result","category":"data_visualization","lightness_relationship":"stable","contrast_requirement":"verification marker and text","surface_usage":["all"],"state_usage":["VERIFYING","COMPLETED"],"accessibility_requirement":"source reference available"},{"token_id":"data.uncertain","semantic_role":"incomplete/conflicting result","category":"data_visualization","lightness_relationship":"patterned caution","contrast_requirement":"uncertainty label","surface_usage":["all"],"state_usage":["DEGRADED","ATTENTION"],"accessibility_requirement":"never collapse into success"},{"token_id":"degraded.offline","semantic_role":"no current connection/read freshness","category":"degraded_error","lightness_relationship":"muted but explicit","contrast_requirement":"persistent text/shape cue","surface_usage":["all"],"state_usage":["OFFLINE"],"accessibility_requirement":"do not use indefinite loading"}]};
},
"docs/uix-w3/STATE_PRIORITY_MATRIX.json":function(module,exports,require){
module.exports = {"schema_version":"uix-w3.state-priority.v1","precedence_high_to_low":["SECURITY_ALERT","ATTENTION","WAITING_FOR_AUTHORITY","WAITING_FOR_USER","VERIFYING","ACTING","DEGRADED","OFFLINE","UNKNOWN","THINKING","LISTENING","COMPLETED","IDLE","DORMANT"],"resolution_rule":"highest applicable state controls primary presence treatment; secondary truth badges remain visible when they do not contradict it","conflicts":[{"when":["THINKING","SECURITY_ALERT"],"winner":"SECURITY_ALERT","treatment":"show security severity/evidence; retain processing as secondary context"},{"when":["ACTING","WAITING_FOR_AUTHORITY"],"winner":"WAITING_FOR_AUTHORITY","treatment":"execution must be shown paused/pending only if mission source says so; never imply acting past gate"},{"when":["DEGRADED","COMPLETED"],"winner":"DEGRADED","treatment":"show completion only with limitation/verification caveat; do not style healthy"},{"when":["LISTENING","SECURITY_ALERT"],"winner":"SECURITY_ALERT","treatment":"interrupt only per urgency/privacy policy; preserve listening transcript state"},{"when":["ACTING","VERIFYING"],"winner":"VERIFYING","treatment":"execution ended or is in verification phase; no progress animation"},{"when":["OFFLINE","COMPLETED"],"winner":"OFFLINE","treatment":"show last-known completion with timestamp, not current confirmation"}],"interruptibility":"priority affects presentation, never authority or state ownership"};
},
"docs/uix-w3/VISUAL_STATE_MODEL.json":function(module,exports,require){
module.exports = {"schema_version":"uix-w3.visual-state-model.v1","state_owner_rule":"all records are projections of W2 read models/signals; no component owns canonical state","states":[{"visual_state_id":"DORMANT","semantic_meaning":"presence is available but not actively engaged","source_state_refs":["presence_projection:standby","session_projection:LIVE"],"entry_condition":"no active attention, mission, approval, or notification requiring presentation","exit_condition":"wake, summon, relevant update, or policy-permitted alert","priority":10,"interruptibility":"fully_interruptible","motion_profile":"presence_breathing","surface_scope":["idle_presence","companion","voice"],"density_scope":["NORMAL"],"accessibility_fallback":"static presence label: Damar is available","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"IDLE","semantic_meaning":"available and not currently processing a user request","source_state_refs":["presence_projection:idle","session_projection:LIVE"],"entry_condition":"read model reports idle","exit_condition":"listen, mission, notification, or degraded signal","priority":20,"interruptibility":"fully_interruptible","motion_profile":"ambient","surface_scope":["all projected surfaces"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"text status: Idle","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"LISTENING","semantic_meaning":"input is being received or voice modality is listening","source_state_refs":["voice_runtime:VAD/listening","conversation_ingress:accepted_input"],"entry_condition":"canonical voice/input signal says listening","exit_condition":"input ends, timeout, error, or transition to another mapped state","priority":40,"interruptibility":"user_interruptible","motion_profile":"listening_response","surface_scope":["idle_presence","voice","companion"],"density_scope":["NORMAL"],"accessibility_fallback":"live text: Listening","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"THINKING","semantic_meaning":"canonical read model reports cognition/response processing; not proof of action","source_state_refs":["presence_projection:thinking","conversation_projection:processing"],"entry_condition":"source explicitly reports processing","exit_condition":"response available, failure, authority wait, acting, or unknown","priority":50,"interruptibility":"user_interruptible","motion_profile":"thinking_indeterminate","surface_scope":["idle_presence","voice","dashboard"],"density_scope":["NORMAL","POWER"],"accessibility_fallback":"text status: Processing; duration unknown","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"ACTING","semantic_meaning":"mission/task execution is active","source_state_refs":["mission_projection:RUNNING","task_projection:EXECUTING"],"entry_condition":"canonical execution signal exists","exit_condition":"wait, verify, complete, fail, cancel, or degrade","priority":60,"interruptibility":"policy_dependent","motion_profile":"acting_indeterminate_or_real_progress","surface_scope":["all mission surfaces"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"text status: Executing; progress shown only if sourced","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"WAITING_FOR_USER","semantic_meaning":"user input is required before continuation","source_state_refs":["mission_projection:WAITING_FOR_USER","task_projection:BLOCKED_USER_INPUT"],"entry_condition":"canonical mission/task wait reason is user","exit_condition":"input received, expired, cancelled, or failed","priority":70,"interruptibility":"user_action_required","motion_profile":"attention_request","surface_scope":["idle_presence","web_dashboard","cli","companion","telegram","whatsapp"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent labeled prompt with focus","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"WAITING_FOR_AUTHORITY","semantic_meaning":"consequential action is pending canonical authority/approval","source_state_refs":["approval_projection:decision=PENDING","authority_result=DEFER"],"entry_condition":"approval record exists and is pending/deferred","exit_condition":"approved, denied, expired, cancelled, or unknown","priority":80,"interruptibility":"user_action_required","motion_profile":"approval_request","surface_scope":["idle_presence","web_dashboard","cli","companion","voice","telegram","whatsapp"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent approval summary with risk, target, expiry, and controls","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"VERIFYING","semantic_meaning":"execution result is awaiting canonical verification","source_state_refs":["approval_projection:verification_result=NOT_STARTED","mission/task:verification_pending"],"entry_condition":"execution occurred and verification is required/pending","exit_condition":"PASS, FAIL, UNCERTAIN, or unavailable","priority":75,"interruptibility":"policy_dependent","motion_profile":"verification","surface_scope":["all mission surfaces"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"text status: Verifying result; result not yet confirmed","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"COMPLETED","semantic_meaning":"mission/task outcome is complete at the supported truth level","source_state_refs":["mission_projection:COMPLETED","verification_result=PASS when required"],"entry_condition":"completion and required verification permit completion","exit_condition":"new event, stale projection, or inspection only","priority":30,"interruptibility":"not_applicable","motion_profile":"success_completion","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"static completion label with verification summary","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"DEGRADED","semantic_meaning":"runtime/read model is limited, stale, partial, failed, or fallback is active","source_state_refs":["presence_projection:DEGRADED","provider_health:DEGRADED","device_projection:STALE","network:FAILED"],"entry_condition":"canonical limitation/failure signal","exit_condition":"fresh healthy read model or explicit offline/unknown state","priority":90,"interruptibility":"policy_dependent","motion_profile":"degraded_static_or_subtle","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent cause, impact, and next action text","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"ATTENTION","semantic_meaning":"important notification or user acknowledgement is required","source_state_refs":["notification_projection:IMPORTANT|URGENT","mission/task:blocked"],"entry_condition":"notification policy selects attention","exit_condition":"acknowledged, dismissed, resolved, expired, or escalated","priority":100,"interruptibility":"policy_dependent","motion_profile":"attention_request","surface_scope":["all policy-permitted"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent alert/live region with acknowledgement semantics","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"SECURITY_ALERT","semantic_meaning":"DCD/security signal or incident needs policy-permitted attention; it is not authorization","source_state_refs":["security_incident_projection:signal|detection|incident","notification_projection:CRITICAL"],"entry_condition":"policy permits presentation of security event","exit_condition":"acknowledged/resolved/escalated/expired per incident lifecycle","priority":110,"interruptibility":"policy_dependent","motion_profile":"security_escalation","surface_scope":["all policy-permitted"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"persistent labeled security alert with severity, evidence, uncertainty, and response boundary","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"OFFLINE","semantic_meaning":"surface or relevant source is disconnected; current truth may not be available","source_state_refs":["session_projection:EXPIRED","device_projection:OFFLINE","network:UNREACHABLE"],"entry_condition":"explicit offline/disconnected signal","exit_condition":"fresh authenticated connection/read model","priority":95,"interruptibility":"policy_dependent","motion_profile":"offline_static","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"offline label, last-known timestamp, disabled mutation explanation","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"},{"visual_state_id":"UNKNOWN","semantic_meaning":"source cannot establish a trustworthy state","source_state_refs":["any read model:freshness=UNKNOWN","observation:unknown"],"entry_condition":"missing/conflicting/untrusted source","exit_condition":"fresh authoritative projection or explicit failure/offline","priority":85,"interruptibility":"policy_dependent","motion_profile":"unknown_static","surface_scope":["all"],"density_scope":["NORMAL","POWER","FORENSIC"],"accessibility_fallback":"explicit Unknown label with source and age","current_future_classification":"CURRENTLY_SOURCE_MAPPABLE"}],"truth_rules":["THINKING is not ACTING","WAITING_FOR_AUTHORITY is not generic loading","VERIFYING is not COMPLETED","determinate progress requires a real value","unknown is never styled healthy","future is never styled available"]};
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

}
};
const cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
globalThis.DamarUIRuntime=require("src/ui-platform/browser/runtime.js");
})();
