'use strict';

const { createIsolatedSelfHealingEngine } = require('../autonomy/SelfHealingEngine');

const TOOL = 'r9r3.synthetic.recovery';

function createR9R3SelfHealingFixture({ onToolCall = null } = {}) {
    if (onToolCall !== null && typeof onToolCall !== 'function') throw new TypeError('onToolCall must be a function');
    const calls = [], denials = [];
    const journal = [];
    const fakeToolBus = Object.freeze({
        async execute(request) {
            const scope = request?.context?.exec?.capabilitySet;
            const exec = request?.context?.exec;
            if (request?.name !== TOOL || !Array.isArray(scope) || scope.length !== 0 ||
                exec?.role === 'system' || exec?.internal === true ||
                (typeof exec?.source === 'string' && exec.source.startsWith('autonomous:'))) {
                denials.push(Object.freeze({ name: request?.name ?? null, capabilityCount: Array.isArray(scope) ? scope.length : null }));
                return Object.freeze({ ok: false, error: 'isolated recovery adapter rejected tool or scope', authorityLimit: true });
            }
            calls.push(Object.freeze({ name: request.name, scenario: request.args?.scenario ?? null,
                taskId: request.args?.taskId ?? null, incidentId: request.args?.incidentId ?? null,
                capabilityCount: scope.length, signalPresent: Boolean(request.signal),
                role: exec?.role ?? null, internal: exec?.internal === true,
                source: typeof exec?.source === 'string' ? exec.source : null }));
            onToolCall?.(request);
            const scenario = request.args?.scenario;
            if (request.signal?.aborted) return Object.freeze({ ok: false, error: 'synthetic recovery cancelled', cancelled: true });
            if (scenario === 'recovery-failure') return Object.freeze({ ok: false, error: 'synthetic isolated recovery failure' });
            if (scenario === 'recovery-timeout') return Object.freeze({ ok: false, error: 'synthetic isolated recovery timeout', timedOut: true });
            if (scenario === 'recovery-cancel') {
                return new Promise(resolve => {
                    const finish = () => resolve(Object.freeze({ ok: false, error: 'synthetic recovery cancelled', cancelled: true }));
                    if (request.signal?.aborted) finish();
                    else request.signal?.addEventListener('abort', finish, { once: true });
                });
            }
            return Object.freeze({ ok: true, result: Object.freeze({ detail: 'synthetic in-memory checkpoint released', target: request.args?.taskId ?? null }) });
        }
    });
    const fakeCapabilities = Object.freeze({
        async discover() { return Object.freeze({ capabilities: Object.freeze([]), packages: Object.freeze([]) }); }
    });
    const inMemoryDatabase = Object.freeze({
        async run(statement, parameters) {
            journal.push(Object.freeze({ statement: String(statement), parameters: Object.freeze([...(parameters || [])]) }));
            return Object.freeze({ changes: 1 });
        }
    });
    const inMemoryInitializer = async () => undefined;
    const engine = createIsolatedSelfHealingEngine({ toolBus: fakeToolBus, capabilities: fakeCapabilities,
        database: inMemoryDatabase, initialize: inMemoryInitializer });
    return Object.freeze({ engine, toolName: TOOL, toolBusAdapter: fakeToolBus,
        capabilitiesAdapter: fakeCapabilities, databaseAdapter: inMemoryDatabase, initializeAdapter: inMemoryInitializer,
        getCalls: () => Object.freeze(calls.slice()), getJournal: () => Object.freeze(journal.slice()), getDenials: () => Object.freeze(denials.slice()),
        snapshot: () => Object.freeze({ calls: calls.length, denials: denials.length, journalWrites: journal.length, toolName: TOOL, externalEffects: false }) });
}

module.exports = { createR9R3SelfHealingFixture, R9R3_SYNTHETIC_RECOVERY_TOOL: TOOL };
