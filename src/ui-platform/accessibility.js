'use strict';
function reducedMotionPreference({ matchMedia = globalThis.matchMedia } = {}) { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
function visuallyHiddenProps() { return { className: 'damar-visually-hidden', style: { position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 } }; }
function liveRegionProps(kind = 'polite') { if (!['polite', 'assertive', 'off'].includes(kind)) throw new TypeError('invalid live region'); return { role: kind === 'assertive' ? 'alert' : 'status', 'aria-live': kind, 'aria-atomic': 'true' }; }
function focusRingProps() { return { className: 'damar-focusable', 'data-focus-ring': 'visible' }; }
function accessibleStatus({ label, icon = '•', tone = 'neutral' }) { return Object.freeze({ label, icon, tone, text: `${icon} ${label}`, redundantCue: true }); }
module.exports = { reducedMotionPreference, visuallyHiddenProps, liveRegionProps, focusRingProps, accessibleStatus };
