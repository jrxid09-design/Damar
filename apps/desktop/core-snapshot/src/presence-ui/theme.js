'use strict';
const { TOKEN_VALUES } = require('../ui-platform/tokens');
// Explicit W5 delta; frozen W3 semantic roles and W4 defaults are untouched.
const THEME = Object.freeze({ ...TOKEN_VALUES,
  'surface.void': '#080808', 'surface.ambient': '#101010', 'surface.presence': '#171614',
  'surface.interaction': '#20201e', 'surface.floating': '#252422', 'surface.approval': '#28251f',
  'surface.security': '#2b1e20', 'text.primary': '#f4efe5', 'text.secondary': '#c6c1b7',
  'text.metadata': '#a49f95', 'border.subtle': '#504b40', 'focus.visible': '#f5dcaa',
  'interactive.primary': '#ddc18a',
});
module.exports = { THEME };
