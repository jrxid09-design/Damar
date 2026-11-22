'use strict';

const AIRuntime = require('../ai/runtime/AIRuntime');
const RuntimeOptions = require('../ai/runtime/RuntimeOptions');
const AITool = require('../ai/tools/AITool');
const AIToolRegistry = require('../ai/tools/AIToolRegistry');
const internalGrant = require('../ai/tools/internalGrant');
const RuntimeExecutor = require('../ai/executors/RuntimeExecutor');
const { createR8ShadowToolGuard } = require('../core/safety/r8ShadowToolGuard');

const PROVENANCE = 'R9R2_OFFLINE_OWNER_BOUND_SHADOW';
const PRINCIPAL = 'r9r2-shadow-agenthub';
const TOOL_NAME = 'r9r2.shadow.noop';
const CAPABILITY = TOOL_NAME;

function createOwnerBoundShadowBridge({ now = () => Date.now(), ticketTtlMs = 10000 } = {}) {
    if (typeof now !== 'function' || !Number.isFinite(ticketTtlMs) || ticketTtlMs < 1) {
        throw new TypeError('invalid shadow bridge clock/TTL');
    }

    const tickets = new WeakMap();
    const bridgeGrants = new WeakSet();
    const contexts = new Map();
    const stats = { providerCalls: 0, toolInvocations: 0, deniedRequests: 0, providerPayloadsWithoutAuthority: 0 };
    let providerContext = null;
    let sequence = 0;

    const registry = new AIToolRegistry();
    registry.register(new AITool({
        name: TOOL_NAME,
        description: 'One-tool in-memory R9R2 shadow checkpoint; no external action',
        parameters: {
            type: 'object',
            properties: {
                taskId: { type: 'string', minLength: 1, maxLength: 96 },
                correlationId: { type: 'string', minLength: 1, maxLength: 96 },
                mode: { type: 'string', enum: ['complete', 'await-recovery'] }
            },
            required: ['taskId', 'correlationId', 'mode'],
            additionalProperties: false
        },
        meta: { readOnly: true, sideEffects: false, destructive: false, r9ShadowOnly: true, capabilities: [CAPABILITY], provenance: PROVENANCE },
        execute: async (args, { exec } = {}) => {
            const context = contexts.get(args.taskId);
            if (!context || context.correlationId !== args.correlationId || exec?.role !== 'system' ||
                exec?.sessionId !== context.grantSessionId || context.ticket.principalId !== PRINCIPAL) {
                stats.deniedRequests += 1;
                throw Object.assign(new Error('R9R2 shadow identity/resource denied'), { code: 'PERMISSION_DENIED' });
            }
            const denial = ticketDenial(context.grant, context.taskId, context.correlationId);
            if (denial) {
                stats.deniedRequests += 1;
                throw Object.assign(new Error(denial), { code: 'PERMISSION_DENIED' });
            }
            const ticket = tickets.get(context.grant);
            ticket.used = true;
            stats.toolInvocations += 1;
            context.toolInvocations += 1;
            if (args.mode === 'complete') {
                context.toolResult = Object.freeze({ taskId: args.taskId, correlationId: args.correlationId,
                    result: 'R9R2 in-memory shadow task completed', provenance: PROVENANCE, authorityRelevance: 'none' });
                return context.toolResult;
            }
            return new Promise((resolve, reject) => {
                context.pendingTool = {
                    resolve(value) { context.pendingTool = null; context.toolResult = value; resolve(value); },
                    reject(error) { context.pendingTool = null; reject(error); }
                };
                context.onToolPending?.();
                const cancel = () => context.pendingTool?.reject(Object.assign(new Error('R9R2 shadow task cancelled'), { code: 'CANCELLED' }));
                if (context.signal?.aborted) cancel();
                else context.signal?.addEventListener('abort', cancel, { once: true });
            });
        }
    }));

    const runtime = new AIRuntime({}, new RuntimeOptions({
        defaultModel: 'r9r2-shadow-model', timeout: 5000,
        retry: { enabled: false, attempts: 1, delay: 0 },
        logging: { enabled: false }, metrics: { enabled: false }, events: { enabled: false },
        shadowToolGuard: createR8ShadowToolGuard()
    }));
    runtime.setToolRegistry(registry);

    function issueTicket(taskId, correlationId, { scope = [CAPABILITY], ttlMs = ticketTtlMs, principalId = PRINCIPAL } = {}) {
        const grant = runtime.executor.mintGrant({
            authorizedTools: scope,
            provenance: `r9r2-shadow:${taskId}:${correlationId}:${++sequence}`
        });
        bridgeGrants.add(grant);
        tickets.set(grant, { taskId, correlationId, principalId, expiresAt: now() + ttlMs, revoked: false, used: false });
        return grant;
    }

    function ticketDenial(grant, taskId, correlationId) {
        if (!grant || !bridgeGrants.has(grant) || !internalGrant.isCanonicalInternalGrant(grant)) return 'untrusted_grant';
        const ticket = tickets.get(grant);
        if (!ticket || ticket.taskId !== taskId || ticket.correlationId !== correlationId || ticket.principalId !== PRINCIPAL) return 'principal_or_resource_mismatch';
        if (ticket.revoked) return 'revoked_grant';
        if (now() > ticket.expiresAt) return 'expired_grant';
        if (ticket.used) return 'grant_replay';
        if (!internalGrant.isToolAuthorizedByGrant(grant, CAPABILITY)) return 'scope_denied';
        return null;
    }

    const fakeProvider = Object.freeze({
        async chat(request) {
            const context = providerContext;
            if (!context) throw new Error('R9R2 fake model received an unbound request');
            stats.providerCalls += 1;
            const authorityFields = ['exec', 'grantConsumer', 'principalId', 'capabilitySet', 'source', 'internalGrant', 'internal'];
            if (!authorityFields.some(key => Object.prototype.hasOwnProperty.call(request, key))) stats.providerPayloadsWithoutAuthority += 1;
            if (context.modelCalls++ === 0) {
                return { toolCalls: [{ id: `r9r2-call-${context.taskId}`, name: TOOL_NAME, arguments: {
                    taskId: context.taskId, correlationId: context.correlationId,
                    mode: context.mode === 'complete' ? 'complete' : 'await-recovery'
                } }], content: null, finishReason: 'tool_calls' };
            }
            const result = [...(request.messages || [])].reverse().find(message => message.role === 'tool');
            context.providerToolResult = result?.content ?? null;
            return { content: `R9R2 shadow runtime completed ${context.taskId}; result-present=${context.providerToolResult !== null}`, toolCalls: [], finishReason: 'stop' };
        }
    });
    runtime.registerProvider('r9r2-shadow-provider', fakeProvider).use('r9r2-shadow-provider');

    async function invoke({ taskId, correlationId, grant, signal = null, mode = 'await-recovery', onToolPending = null }) {
        const ticket = tickets.get(grant);
        const context = { taskId, correlationId, grant, ticket, grantSessionId: grant?.sessionId,
            signal, mode, onToolPending, modelCalls: 0, toolInvocations: 0, toolResult: null, providerToolResult: null, pendingTool: null };
        contexts.set(taskId, context);
        providerContext = context;
        try {
            const response = await runtime.chat({
                messages: [{ role: 'user', content: `R9R2 isolated synthetic task ${taskId}; use the bounded shadow tool once.` }],
                model: 'r9r2-shadow-model', exec: grant, signal
            });
            if (signal?.aborted) throw Object.assign(new Error('R9R2 shadow task cancelled or timed out'), { code: 'CANCELLED' });
            if (!context.toolInvocations || !context.toolResult) throw Object.assign(new Error('shadow tool produced no verified result'), { code: 'EXECUTION_ERROR' });
            return Object.freeze({ taskId, correlationId, provider: 'r9r2-shadow-provider', model: 'r9r2-shadow-model',
                runtimeMethods: ['AgentHub.run', 'AIRuntime.chat', 'RuntimeExecutor.execute', 'RuntimeExecutor.runOne', 'ToolExecutor.execute'],
                providerCalls: context.modelCalls, toolInvocations: context.toolInvocations, toolResult: context.toolResult,
                providerResponse: response.content, provenance: PROVENANCE, simulated: true, authorityRelevance: 'none' });
        } finally {
            contexts.delete(taskId);
            if (providerContext === context) providerContext = null;
        }
    }

    const executionPort = Object.freeze({
        async executeTask(envelope, context) {
            if (!envelope || !['damar.synthetic.echo', 'damar.synthetic.await-recovery'].includes(envelope.taskType)) throw new TypeError('R9R2 task type denied');
            if (!context?.task || context.task.taskId !== envelope.taskId || context.task.correlationId !== envelope.correlationId) throw new Error('R9R2 task identity mismatch');
            const grant = issueTicket(envelope.taskId, envelope.correlationId);
            const denial = ticketDenial(grant, envelope.taskId, envelope.correlationId);
            if (denial) throw new Error(denial);
            const mode = envelope.taskType === 'damar.synthetic.echo' ? 'complete' : 'await-recovery';
            return invoke({ taskId: envelope.taskId, correlationId: envelope.correlationId, grant, signal: context.signal, mode,
                onToolPending: context.task.shadowToolPending?.resolve });
        },
        async onRecovery(taskId, outcome) {
            const context = contexts.get(taskId);
            if (!context?.pendingTool) throw new Error('R9R2 runtime has no held shadow call for recovery outcome');
            if (outcome?.ok === true) context.pendingTool.resolve(Object.freeze({ taskId, correlationId: context.correlationId,
                result: 'R9R2 shadow checkpoint released', provenance: PROVENANCE, authorityRelevance: 'none' }));
            else context.pendingTool.reject(Object.assign(new Error(outcome?.detail || 'R9R2 shadow recovery failed'), { code: 'EXECUTION_ERROR' }));
        }
    });

    async function probeAuthorization(kind) {
        if (!['cross-domain', 'wrong-scope', 'forged', 'expired', 'revoked', 'replay', 'principal'].includes(kind)) {
            return Object.freeze({ accepted: false, reason: 'probe_not_allowed' });
        }
        const taskId = `r9r2-probe-${++sequence}`;
        const correlationId = `${taskId}-corr`;
        const grant = issueTicket(taskId, correlationId, kind === 'wrong-scope' ? { scope: ['r9r2.shadow.other'] } : {});
        const ticket = tickets.get(grant);
        if (kind === 'expired') ticket.expiresAt = now() - 1;
        if (kind === 'revoked') ticket.revoked = true;
        if (kind === 'principal') ticket.principalId = 'untrusted-principal';
        if (kind === 'cross-domain') {
            const foreignExecutor = new RuntimeExecutor({});
            const foreignGrant = foreignExecutor.mintGrant({ authorizedTools: [CAPABILITY], provenance: `foreign:${taskId}` });
            return Object.freeze({ accepted: false, reason: ticketDenial(foreignGrant, taskId, correlationId), providerCalls: 0, toolInvocations: 0 });
        }
        if (kind === 'forged') return Object.freeze({ accepted: false, reason: ticketDenial(Object.freeze({ ...grant }), taskId, correlationId), providerCalls: 0, toolInvocations: 0 });
        if (kind === 'expired' || kind === 'revoked' || kind === 'wrong-scope' || kind === 'principal') {
            return Object.freeze({ accepted: false, reason: ticketDenial(grant, taskId, correlationId), providerCalls: 0, toolInvocations: 0 });
        }
        const result = await invoke({ taskId, correlationId, grant, mode: 'complete' });
        return Object.freeze({ accepted: false, reason: ticketDenial(grant, taskId, correlationId), firstCallToolInvocations: result.toolInvocations, providerCalls: result.providerCalls });
    }

    function snapshot() {
        return Object.freeze({ provenance: PROVENANCE, runtime: 'DAMAR AIRuntime + RuntimeExecutor + ToolExecutor',
            runtimeMethods: Object.freeze(['AgentHub.run', 'AIRuntime.chat', 'RuntimeExecutor.execute', 'RuntimeExecutor.runOne', 'ToolExecutor.execute', 'R8ShadowToolGuard.before/after']),
            provider: 'R9R2 fake provider', tool: TOOL_NAME, allowedCapability: CAPABILITY, canonicalToolGuardUsed: true,
            ...stats, activeShadowRequests: contexts.size, grantObjectsExposed: false, networkCalls: 0, credentialsUsed: false });
    }

    return Object.freeze({ executionPort, probeAuthorization, snapshot, privateRuntimeMethod: 'AIRuntime.chat' });
}

module.exports = { createOwnerBoundShadowBridge, PROVENANCE, TOOL_NAME, CAPABILITY };
