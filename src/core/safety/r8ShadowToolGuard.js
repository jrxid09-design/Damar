'use strict';

// This guard brands only the fixed, single-tool offline shadow profile.
// It does not replace ToolGuard and cannot authorize a capability.
const TOOL_NAME = 'r9r2.shadow.noop';
const guards = new WeakSet();

function denied(message, code = 'PERMISSION_DENIED') {
    return Object.assign(new Error(message), { code });
}

function createR8ShadowToolGuard() {
    const guard = Object.freeze({
        before(name, args, tool) {
            if (name !== TOOL_NAME || tool?.meta?.r9ShadowOnly !== true ||
                tool.meta.sideEffects !== false || tool.meta.destructive !== false) {
                throw denied('R9 shadow guard denied a non-shadow tool');
            }
            if (!args || typeof args.taskId !== 'string' || typeof args.correlationId !== 'string' ||
                !['complete', 'await-recovery'].includes(args.mode) ||
                Object.keys(args).some(key => !['taskId', 'correlationId', 'mode'].includes(key))) {
                throw denied('R9 shadow guard rejected tool arguments', 'VALIDATION_ERROR');
            }
            return false;
        },
        after(name, _args, result) {
            if (name !== TOOL_NAME || !result ||
                result.provenance !== 'R9R2_OFFLINE_OWNER_BOUND_SHADOW' ||
                result.authorityRelevance !== 'none') {
                throw denied('R9 shadow guard rejected result provenance', 'POLICY_DENIED');
            }
            return Object.freeze({ state: 'verified-shadow-result' });
        }
    });
    guards.add(guard);
    return guard;
}

function isR8ShadowToolGuard(value) {
    return Boolean(value && typeof value === 'object' && guards.has(value));
}

module.exports = { createR8ShadowToolGuard, isR8ShadowToolGuard, R8_SHADOW_TOOL_NAME: TOOL_NAME };
