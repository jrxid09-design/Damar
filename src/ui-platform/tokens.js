'use strict';
const contract = require('../../docs/uix-w3/SEMANTIC_DESIGN_TOKENS.json');
const TOKEN_VALUES = Object.freeze({
  'surface.void': '#090b10', 'surface.ambient': '#10151d', 'surface.presence': '#152333', 'surface.interaction': '#1b2430', 'surface.floating': '#222e3c', 'surface.approval': '#26333d', 'surface.security': '#35242b',
  'text.primary': '#f3f5f7', 'text.secondary': '#b8c2cc', 'text.metadata': '#8794a1', 'border.subtle': '#33404d', 'focus.visible': '#83d7ff', 'interactive.primary': '#6bd6b0',
  'status.neutral': '#9aa7b3', 'status.information': '#72b7ed', 'status.active': '#c6a7ff', 'status.success': '#6bd6b0', 'status.warning': '#efc266', 'status.danger': '#f07878',
  'security.suspicious': '#efc266', 'security.confirmed': '#f07878', 'authority.requested': '#efc266', 'authority.denied': '#f07878', 'approval.pending': '#efc266',
  'awareness.fresh': '#6bd6b0', 'awareness.stale': '#efc266', 'provider.healthy': '#6bd6b0', 'provider.degraded': '#efc266', 'device.trusted': '#6bd6b0', 'device.unknown': '#9aa7b3', 'data.verified': '#6bd6b0', 'data.uncertain': '#efc266', 'degraded.offline': '#9aa7b3'
});
const TOKEN_IDS = Object.freeze(contract.tokens.map((token) => token.token_id));
function token(name) { if (!TOKEN_IDS.includes(name)) throw new Error(`unknown semantic token: ${name}`); return `var(--damar-${name.replaceAll('.', '-')})`; }
function tokenStyle(theme = 'dark') { return Object.fromEntries(TOKEN_IDS.map((id) => [`--damar-${id.replaceAll('.', '-')}`, TOKEN_VALUES[id] ?? 'currentColor'])); }
module.exports = { TOKEN_IDS, TOKEN_VALUES, token, tokenStyle, contract };
