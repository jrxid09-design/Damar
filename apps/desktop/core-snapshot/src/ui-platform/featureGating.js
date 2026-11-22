'use strict';
const { FEATURE_CLASSES } = require('./contracts');

function classify(feature, { enabled = false } = {}) {
  if (!FEATURE_CLASSES.includes(feature)) throw new TypeError(`unknown feature class: ${feature}`);
  return Object.freeze({ classification: feature, enabled: Boolean(enabled) && feature === 'CURRENT_IMPLEMENTED', truthful: feature !== 'CURRENT_IMPLEMENTED' || Boolean(enabled) });
}

function gate(feature, { label = feature, enabled = false } = {}) {
  const state = classify(feature, { enabled });
  return Object.freeze({ ...state, label, presentation: state.enabled ? 'available' : feature === 'CURRENT_PARTIAL' ? 'partial' : feature === 'FUTURE_CAPABILITY_DEPENDENT' ? 'future' : 'not_available' });
}

module.exports = { classify, gate };
