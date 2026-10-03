'use strict';
const { accessibleStatus, focusRingProps, liveRegionProps } = require('./accessibility');
const { token } = require('./tokens');

function primitive(component, props = {}, children = []) { return Object.freeze({ component, props, children: Array.isArray(children) ? children : [children] }); }
function Button(props = {}, children = []) { return primitive('Button', { type: 'button', ...focusRingProps(), ...props }, children); }
function IconButton(props = {}) { return Button({ 'aria-label': props.label, ...props, iconOnly: true }); }
function TextInput(props = {}) { return primitive('TextInput', { type: 'text', ...focusRingProps(), ...props }); }
function StateIndicator({ state, label = state, icon = '•', tone = 'neutral', ...props }) { return primitive('StateIndicator', { ...accessibleStatus({ label, icon, tone }), 'data-state': state, ...props }); }
function HealthIndicator({ state = 'UNKNOWN', label = state, ...props }) { return StateIndicator({ state, label, icon: state === 'HEALTHY' ? '✓' : state === 'UNKNOWN' ? '?' : '!', tone: state === 'HEALTHY' ? 'success' : 'warning', ...props }); }
function Stack(props = {}, children = []) { return primitive('Stack', { role: 'group', ...props }, children); }
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
const CONTRACT_STUBS = Object.freeze(['PresenceCore', 'PresenceShell', 'MissionCard', 'ApprovalCard', 'NotificationItem', 'EntityHeader', 'CapabilityStateStack', 'ProviderCard', 'ModelCard', 'DeviceCard', 'GatewayCard', 'SecurityIncidentCard', 'ObservationCard', 'EvidencePanel', 'Timeline', 'Inspector', 'CommandPalette', 'DataTable']);
module.exports = { primitive, Button, IconButton, TextInput, StateIndicator, HealthIndicator, Stack, Panel, Dialog, Drawer, Progress, Skeleton, EmptyState, ErrorState, DegradedState, Code, VisuallyHidden, CONTRACT_STUBS };
