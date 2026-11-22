'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const agentHubTemplate = require('../services/agentHub');
const watchdogModule = require('../autonomy/watchdog');

const PROVENANCE = 'R9R2_OFFLINE_BOUNDED_SIMULATION';
const TASK_CAPABILITY = 'r9r2.shadow.task.execute';
const RECOVERY_CAPABILITY = 'r9r2.shadow.recovery.noop';
const TASK_PRINCIPAL = 'r9r2-shadow-agenthub';
const WATCHDOG_PRINCIPAL = 'r9r2-shadow-watchdog';
const RECOVERY_PRINCIPAL = 'r9r2-shadow-selfhealing';
const SCENARIOS = Object.freeze(['echo', 'recover', 'recovery-failure', 'recovery-timeout', 'recovery-cancel', 'cancel', 'timeout', 'replay', 'expired-grant', 'cross-domain', 'wrong-scope', 'unknown-task', 'unauthorized']);

class ManualScheduler {
    constructor({ startAt = Date.now() } = {}) { this.now = startAt; this.sequence = 0; this.jobs = new Map(); }
    setInterval(fn, delay) { return this.add(fn, delay, delay); }
    setTimeout(fn, delay) { return this.add(fn, delay, 0); }
    add(fn, delay, interval) {
        if (typeof fn !== 'function' || !Number.isFinite(delay) || delay < 0) throw new TypeError('invalid scheduler job');
        const job = { id: ++this.sequence, fn, due: this.now + delay, interval };
        this.jobs.set(job.id, job); return job.id;
    }
    clearInterval(id) { this.clearTimeout(id); }
    clearTimeout(id) { this.jobs.delete(id); }
    async advanceBy(milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError('advance must be non-negative');
        const target = this.now + milliseconds;
        for (;;) {
            const due = [...this.jobs.values()].filter(job => job.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
            if (!due) break;
            this.now = due.due;
            if (due.interval) due.due += due.interval; else this.jobs.delete(due.id);
            await due.fn();
        }
        this.now = target;
    }
    clearAll() { this.jobs.clear(); }
    reset() { this.jobs.clear(); this.now = Date.now(); this.sequence = 0; }
    get pendingCount() { return this.jobs.size; }
}

function createDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function boundedString(value, max = 160) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function createBoundedAutonomyCycle({
    onEvent = () => {}, scheduler = new ManualScheduler(), watchdogIntervalMs = 10,
    heartbeatTimeoutMs = 40, taskTimeoutMs = 160, grantTtlMs = 1000,
    maxEvents = 200, maxTasks = 1, agentHubExecutionPort = null, isolatedSelfHealingEngine = null
} = {}) {
    for (const [name, value] of Object.entries({ watchdogIntervalMs, heartbeatTimeoutMs, taskTimeoutMs, grantTtlMs, maxEvents, maxTasks })) {
        if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
    if (agentHubExecutionPort !== null && (typeof agentHubExecutionPort.executeTask !== 'function' || typeof agentHubExecutionPort.onRecovery !== 'function')) {
        throw new TypeError('invalid injected AgentHub shadow execution port');
    }
    if (isolatedSelfHealingEngine !== null) {
        const { isIsolatedSelfHealingEngine } = require('../autonomy/SelfHealingEngine');
        if (!isIsolatedSelfHealingEngine(isolatedSelfHealingEngine)) throw new TypeError('SelfHealingEngine must be created by the isolated adapter factory');
    }

    const taskTickets = new WeakMap();
    const recoveryTickets = new WeakMap();
    const taskContext = new AsyncLocalStorage();
    const tasks = new Map();
    const incidents = new Map();
    const incidentEventIds = new Map();
    const detectedTaskIds = new Set();
    const usedRecoveryIds = new Set();
    const eventHistory = [];
    let eventCounter = 0, running = false, generation = 0, activeTask = null, lastTask = null;
    let lastRecovery = Object.freeze({ state: 'IDLE', incidentId: null, taskId: null, handler: null, outcome: null, eventId: null });
    let recoveryHandlerCalls = 0, agentHubRunCalls = 0, watchdogTimer = null;

    function emit(component, type, fields = {}) {
        const taskCorrelation = fields.taskId ? tasks.get(fields.taskId)?.correlationId : null;
        const event = Object.freeze({ eventId: `r9r2-${component.toLowerCase()}-${++eventCounter}`, component, type,
            at: new Date(scheduler.now).toISOString(), simulated: true, provenance: PROVENANCE,
            authorityRelevance: 'none', ...fields, correlationId: fields.correlationId ?? taskCorrelation ?? null });
        if (eventHistory.length >= maxEvents) eventHistory.shift();
        eventHistory.push(event);
        try { onEvent(event); } catch { /* projections cannot interrupt shadow execution */ }
        return event;
    }

    function issueTaskTicket(taskId, correlationId, capability = TASK_CAPABILITY, ttlMs = grantTtlMs) {
        const ticket = Object.freeze({});
        taskTickets.set(ticket, { taskId, correlationId, principalId: TASK_PRINCIPAL, capability, expiresAt: scheduler.now + ttlMs, consumed: false });
        return ticket;
    }

    function validateTaskGrant(request, grant) {
        const ticket = grant && taskTickets.get(grant);
        if (!ticket) return 'untrusted_ticket';
        if (ticket.taskId !== request.taskId || ticket.correlationId !== request.correlationId || request.principalId !== TASK_PRINCIPAL) return 'principal_or_task_mismatch';
        if (scheduler.now > ticket.expiresAt) return 'expired_grant';
        if (ticket.consumed) return 'grant_replay';
        if (ticket.capability !== TASK_CAPABILITY) return 'scope_denied';
        ticket.consumed = true;
        return null;
    }

    async function noOpRecoveryHandler({ task, incident, error }) {
        recoveryHandlerCalls += 1;
        // Compatibility seam for an isolated engine port. The production
        // SelfHealingEngine binds ToolBus and durable logging, so this candidate
        // deliberately does not load it or invoke recover().
        return Object.freeze({ ok: true, handler: 'simulation-noop', classification: 'transient', taskId: task.taskId,
            incidentId: incident.id, detail: 'no-op: synthetic in-memory checkpoint released' });
    }

    async function controlledFailureRecoveryHandler({ task, incident, error }) {
        recoveryHandlerCalls += 1;
        return Object.freeze({ ok: false, handler: 'simulation-noop-failure-fixture',
            classification: 'transient', taskId: task.taskId,
            incidentId: incident.id, detail: 'controlled simulation recovery failure' });
    }

    const disposableAgentHub = new agentHubTemplate.constructor();
    disposableAgentHub.runDamar = async (envelope, { exec = null } = {}) => {
        const context = taskContext.getStore();
        if (!context || context.agentHub !== disposableAgentHub || context.taskId !== envelope.taskId ||
            context.correlationId !== envelope.correlationId || exec !== null ||
            !taskTickets.has(context.ticket) || context.ticket !== context.task.ticket) throw new Error('shadow AgentHub context mismatch');
        return agentHubExecutionPort ? agentHubExecutionPort.executeTask(envelope, context) : executeInMemoryTask(envelope, context);
    };
    disposableAgentHub.runWorker = async () => { throw new Error('worker execution disabled in bounded shadow mode'); };

    function executeInMemoryTask(envelope, context) {
        if (envelope.taskType === 'damar.synthetic.echo') return Promise.resolve(Object.freeze({ taskId: context.taskId, correlationId: context.correlationId, result: 'synthetic task completed in memory' }));
        if (envelope.taskType !== 'damar.synthetic.await-recovery') throw new Error('synthetic task type not allowed');
        const deferred = createDeferred(); context.task.pending = deferred;
        const abort = () => deferred.reject(Object.assign(new Error('synthetic task cancelled'), { code: 'CANCELLED' }));
        if (context.signal.aborted) abort(); else context.signal.addEventListener('abort', abort, { once: true });
        return deferred.promise.finally(() => context.signal.removeEventListener('abort', abort));
    }

    function issueRecoveryTicket(incident, { capability = RECOVERY_CAPABILITY, ttlMs = grantTtlMs } = {}) {
        const ticket = Object.freeze({});
        recoveryTickets.set(ticket, { incidentId: incident.id, taskId: incident.taskId, principalId: RECOVERY_PRINCIPAL,
            capability, expiresAt: scheduler.now + ttlMs, consumed: false });
        return ticket;
    }

    async function runRecovery(incident, ticketKey, scenario, watchdogEventId) {
        const ticket = ticketKey && recoveryTickets.get(ticketKey);
        if (!ticket || incidents.get(incident?.id) !== incident) {
            emit('SelfHealing', 'RECOVERY_REJECTED', { taskId: incident?.taskId ?? null, state: 'REJECTED', reason: 'untrusted_incident_or_ticket', incidentId: incident?.id ?? null, watchdogEventId });
            return Object.freeze({ accepted: false, reason: 'untrusted_incident_or_ticket' });
        }
        if (ticket.principalId !== RECOVERY_PRINCIPAL || ticket.taskId !== incident.taskId || ticket.incidentId !== incident.id) {
            emit('SelfHealing', 'RECOVERY_REJECTED', { taskId: incident.taskId, state: 'REJECTED', reason: 'principal_incident_mismatch', incidentId: incident.id, watchdogEventId });
            return Object.freeze({ accepted: false, reason: 'principal_incident_mismatch' });
        }
        if (scheduler.now > ticket.expiresAt) return Object.freeze({ accepted: false, reason: 'expired_grant' });
        if (ticket.consumed || usedRecoveryIds.has(incident.id)) return Object.freeze({ accepted: false, reason: 'incident_replay' });
        if (ticket.capability !== RECOVERY_CAPABILITY) return Object.freeze({ accepted: false, reason: 'scope_denied' });
        ticket.consumed = true; usedRecoveryIds.add(incident.id);
        const task = tasks.get(incident.taskId);
        if (!task || task !== activeTask || task.state !== 'RUNNING') return Object.freeze({ accepted: false, reason: 'task_not_recoverable' });

        task.recoveryState = 'DETECTED';
        lastRecovery = Object.freeze({ state: 'DETECTED', incidentId: incident.id, watchdogEventId, taskId: task.taskId,
            eventId: emit('SelfHealing', 'DETECTED', { taskId: task.taskId, incidentId: incident.id, watchdogEventId, recoveryState: 'DETECTED', summary: 'Verified synthetic Watchdog incident admitted for bounded recovery.' }).eventId, handler: null, outcome: null });
        task.recoveryState = 'RECOVERING'; task.state = 'RECOVERING';
        lastRecovery = Object.freeze({ state: 'RECOVERING', incidentId: incident.id, watchdogEventId, taskId: task.taskId,
            eventId: emit('SelfHealing', 'RECOVERING', { taskId: task.taskId, incidentId: incident.id, watchdogEventId, recoveryState: 'RECOVERING',
                summary: isolatedSelfHealingEngine ? 'SelfHealingEngine.recover invoked with injected isolated adapters.' : 'Simulation-only recovery adapter invoked.' }).eventId,
            handler: isolatedSelfHealingEngine ? 'isolated-self-healing-engine' : 'simulation-noop' });
        const recoveryError = new Error('synthetic timeout: bounded task heartbeat expired');
        let outcome;
        if (isolatedSelfHealingEngine) {
            const engineResult = await isolatedSelfHealingEngine.recover({
                tool: 'r9r3.synthetic.recovery', args: { taskId: task.taskId, incidentId: incident.id, scenario },
                error: scenario === 'recovery-timeout' ? new Error('synthetic recovery timeout') : recoveryError,
                goalId: incident.id, exec: null, internal: false, capabilitySet: [], signal: task.controller.signal
            });
            const engineOutcome = engineResult.outcome || { ok: false, error: 'SelfHealingEngine returned no outcome' };
            outcome = Object.freeze({ ok: engineOutcome.ok === true, handler: 'isolated-self-healing-engine',
                classification: engineResult.klass, attempts: engineResult.attempts,
                result: engineOutcome.result ?? null, error: engineOutcome.error ?? null,
                cancelled: engineOutcome.cancelled === true, timedOut: engineOutcome.timedOut === true,
                taskId: task.taskId, incidentId: incident.id,
                detail: engineOutcome.result?.detail || engineOutcome.error || 'isolated SelfHealingEngine recovery completed' });
        } else {
            const handler = scenario === 'recovery-failure' || scenario === 'recovery-timeout' ? controlledFailureRecoveryHandler : noOpRecoveryHandler;
            outcome = await handler({ task, incident, error: recoveryError });
        }
        task.recoveryOutcome = outcome;
        if (task.controller.signal.aborted || task.state === 'CANCELLED' || outcome.cancelled === true) {
            task.recoveryState = 'REJECTED'; task.state = 'CANCELLED';
            lastRecovery = Object.freeze({ state: 'REJECTED', incidentId: incident.id, watchdogEventId, taskId: task.taskId,
                eventId: emit('SelfHealing', 'RECOVERY_REJECTED', { taskId: task.taskId, incidentId: incident.id, watchdogEventId,
                    recoveryState: 'REJECTED', outcome: Object.freeze({ ...outcome, ok: false, cancelled: true }),
                    summary: 'Isolated SelfHealingEngine recovery cancelled.' }).eventId,
                handler: outcome.handler, outcome: Object.freeze({ ...outcome, ok: false, cancelled: true }) });
            return Object.freeze({ accepted: false, reason: 'cancelled', outcome });
        }
        if (agentHubExecutionPort) await agentHubExecutionPort.onRecovery(task.taskId, outcome);
        if (outcome.ok) {
            task.recoveryState = 'RECOVERED'; task.state = 'RUNNING';
            lastRecovery = Object.freeze({ state: 'RECOVERED', incidentId: incident.id, watchdogEventId, taskId: task.taskId,
                eventId: emit('SelfHealing', 'RECOVERED', { taskId: task.taskId, incidentId: incident.id, watchdogEventId, recoveryState: 'RECOVERED', outcome, summary: outcome.detail }).eventId, handler: outcome.handler, outcome });
            task.pending?.resolve(Object.freeze({ taskId: task.taskId, correlationId: task.correlationId, result: 'synthetic task resumed after shadow checkpoint release' }));
        } else {
            task.recoveryState = 'FAILED'; task.state = 'FAILED';
            lastRecovery = Object.freeze({ state: 'FAILED', incidentId: incident.id, watchdogEventId, taskId: task.taskId,
                eventId: emit('SelfHealing', 'FAILED', { taskId: task.taskId, incidentId: incident.id, watchdogEventId, recoveryState: 'FAILED', outcome, summary: outcome.detail }).eventId, handler: outcome.handler, outcome });
            task.pending?.reject(new Error(outcome.detail));
        }
        task.pending = null;
        if (scenario === 'replay' && outcome.ok) {
            const replay = await runRecovery(incident, ticketKey, 'replay', watchdogEventId);
            task.replayRejected = replay.accepted === false && replay.reason === 'incident_replay';
        }
        return Object.freeze({ accepted: true, outcome });
    }

    async function detectSyntheticIncident() {
        const task = activeTask;
        if (!running || !task || task.state !== 'RUNNING' || scheduler.now - task.lastHeartbeatAt < heartbeatTimeoutMs ||
            detectedTaskIds.has(task.taskId) || ['timeout', 'expired-grant', 'wrong-scope', 'unknown-task', 'unauthorized'].includes(task.scenario)) return;
        const watchdogActions = watchdogModule.decide(
            { voiceFailStreak: 0, mcpOffline: 0, loopLagMs: 0 },
            { voiceFailStreak: 3, mcpOffline: 0, loopLagMs: 0 }
        );
        if (!watchdogActions.includes('restart_voice')) return;
        detectedTaskIds.add(task.taskId);
        const incident = Object.freeze({ id: `r9r2-incident-${task.taskId}`, taskId: task.taskId, correlationId: task.correlationId,
            principalId: WATCHDOG_PRINCIPAL, severity: 'DEGRADED', detectedAt: scheduler.now, watchdogActions, provenance: PROVENANCE });
        incidents.set(incident.id, incident);
        // The production Watchdog timer/tick can perform real remediation. Shadow
        // mode uses its deterministic clock and emits detection only; no action runs.
        const detection = emit('Watchdog', 'INCIDENT_DETECTED', { taskId: task.taskId, incidentId: incident.id,
            principalId: WATCHDOG_PRINCIPAL, status: 'DEGRADED', severity: incident.severity,
            watchdogPolicyActions: Object.freeze(watchdogActions.slice()),
            summary: 'Shadow Watchdog detected the synthetic heartbeat threshold; live remediation was suppressed.' });
        incidentEventIds.set(incident.id, detection.eventId);
        const recoveryTicket = task.scenario === 'cross-domain'
            ? Object.freeze({})
            : issueRecoveryTicket(incident, {
                capability: task.scenario === 'wrong-scope' ? 'r9r2.shadow.recovery.other' : RECOVERY_CAPABILITY,
                ttlMs: task.scenario === 'expired-grant' ? -1 : grantTtlMs
            });
        const result = await runRecovery(incident, recoveryTicket, task.scenario, detection.eventId);
        if (!result.accepted && result.reason !== 'cancelled' && agentHubExecutionPort) {
            await agentHubExecutionPort.onRecovery(task.taskId, { ok: false, detail: `shadow recovery denied: ${result.reason}` });
        }
        if (!result.accepted && task.scenario === 'replay') task.replayRejected = result.reason === 'incident_replay';
    }

    const watchdog = Object.freeze({
        get running() { return running; },
        start() { if (watchdogTimer === null) watchdogTimer = scheduler.setInterval(detectSyntheticIncident, watchdogIntervalMs); },
        stop() { if (watchdogTimer !== null) scheduler.clearInterval(watchdogTimer); watchdogTimer = null; }
    });

    function currentTaskSnapshot(task = lastTask) {
        if (!task) return Object.freeze({ component: 'AgentHub', taskId: null, correlationId: null, agent: null, status: 'IDLE', eventId: null,
            summary: 'No shadow task dispatched.', output: null, error: null, simulated: true, provenance: PROVENANCE, authorityRelevance: 'none' });
        return Object.freeze({ component: 'AgentHub', taskId: task.taskId, correlationId: task.correlationId, agent: task.agentId,
            taskType: task.taskType, status: task.state, eventId: task.lastEventId, summary: task.summary || null,
            output: task.output ?? null, error: task.error ?? null, simulated: true, provenance: PROVENANCE, authorityRelevance: 'none' });
    }

    function snapshot() {
        return Object.freeze({ lifecycle: running ? 'running' : 'stopped', execution: currentTaskSnapshot(), recovery: lastRecovery,
            incidents: Object.freeze([...incidents.values()]), events: Object.freeze(eventHistory.slice()), handlerCalls: recoveryHandlerCalls,
            agentHubRunCalls, pendingTimers: scheduler.pendingCount, watchdogRunning: watchdog.running,
            agentHubDispatch: 'canonical AgentHub.run on a disposable instance; runDamar bound to private R9R2 AIRuntime shadow port',
            watchdogMode: 'synthetic heartbeat detection only; canonical Watchdog timer/tick not started',
            selfHealingMode: isolatedSelfHealingEngine ? 'SelfHealingEngine.recover invoked with branded fake ToolBus and in-memory log adapters' : 'isolated no-op recovery adapter; production SelfHealingEngine not loaded or invoked',
            productionRecoveryInvoked: false, realProviderUsed: false });
    }

    function dispatchWithTicket(request, ticketKey) {
        if (!request || !['damar.synthetic.echo', 'damar.synthetic.await-recovery'].includes(request.taskType)) return Object.freeze({ accepted: false, reason: 'unknown_task' });
        if (request.agentId !== 'damar') return Object.freeze({ accepted: false, reason: 'agent_not_allowed' });
        const denial = validateTaskGrant(request, ticketKey);
        if (denial) return Object.freeze({ accepted: false, reason: denial });
        if (tasks.size >= maxTasks) return Object.freeze({ accepted: false, reason: 'task_limit' });
        const task = { taskId: request.taskId, correlationId: request.correlationId, agentId: request.agentId, taskType: request.taskType,
            scenario: request.scenario, state: 'QUEUED', lastHeartbeatAt: scheduler.now, generation, ticket: ticketKey,
            controller: new AbortController(), pending: null, shadowToolPending: createDeferred(), timeoutHandle: null, output: null, error: null,
            recoveryState: 'IDLE', recoveryOutcome: null, replayRejected: false, summary: 'Synthetic task accepted.' };
        tasks.set(task.taskId, task); activeTask = lastTask = task;
        task.lastEventId = emit('AgentHub', 'TASK_QUEUED', { taskId: task.taskId, correlationId: task.correlationId, status: 'UNKNOWN', taskState: 'QUEUED', summary: task.summary }).eventId;
        task.state = 'RUNNING'; task.summary = 'Canonical AgentHub dispatched one bounded shadow task.';
        task.lastEventId = emit('AgentHub', 'TASK_STARTED', { taskId: task.taskId, correlationId: task.correlationId, status: 'DEGRADED', taskState: 'RUNNING', summary: task.summary }).eventId;
        task.timeoutHandle = scheduler.setTimeout(() => {
            if (!['RUNNING', 'RECOVERING'].includes(task.state)) return;
            task.state = 'TIMED_OUT'; task.error = 'bounded synthetic task timeout'; task.summary = task.error;
            task.controller.abort('r9r2-task-timeout');
        }, taskTimeoutMs);
        const context = { agentHub: disposableAgentHub, task, taskId: task.taskId, correlationId: task.correlationId,
            ticket: ticketKey, signal: task.controller.signal };
        const envelope = Object.freeze({ taskId: task.taskId, correlationId: task.correlationId, taskType: task.taskType, simulated: true });
        agentHubRunCalls += 1;
        const runPromise = taskContext.run(context, () => disposableAgentHub.run('damar', envelope, { signal: task.controller.signal, exec: null }));
        const completion = runPromise.then(result => {
            scheduler.clearTimeout(task.timeoutHandle); task.timeoutHandle = null;
            if (task.generation !== generation || tasks.get(task.taskId) !== task) return Object.freeze({ ...result, taskState: task.state, output: null, error: task.error || 'shadow runtime stopped' });
            if (task.state === 'TIMED_OUT' || task.state === 'CANCELLED') task.summary = task.error || task.state.toLowerCase();
            else if (result.ok) { task.state = 'COMPLETED'; task.output = result.output; task.summary = 'AgentHub shadow task completed.'; }
            else { task.state = 'FAILED'; task.error = boundedString(result.error) || 'shadow task failed'; task.summary = task.error; }
            task.lastEventId = emit('AgentHub', `TASK_${task.state}`, { taskId: task.taskId, correlationId: task.correlationId,
                status: task.state === 'COMPLETED' ? 'HEALTHY' : task.state === 'TIMED_OUT' ? 'OFFLINE' : task.state === 'CANCELLED' ? 'UNKNOWN' : 'DEGRADED',
                taskState: task.state, output: result.ok ? result.output : null, error: result.error ?? task.error, summary: task.summary }).eventId;
            return Object.freeze({ ...result, taskId: task.taskId, correlationId: task.correlationId, taskState: task.state, output: task.output, error: task.error });
        });
        return Object.freeze({ accepted: true, taskId: task.taskId, correlationId: task.correlationId, completion, task });
    }

    function attemptTask(request) { return dispatchWithTicket(request, request?.ticket); }
    function cancelTask(taskId) {
        const task = tasks.get(taskId);
        if (!task || !['RUNNING', 'RECOVERING'].includes(task.state)) return Object.freeze({ accepted: false, reason: 'task_not_active' });
        task.state = 'CANCELLED'; task.error = 'synthetic task cancelled'; task.summary = task.error;
        task.controller.abort('r9r2-task-cancelled');
        emit('AgentHub', 'TASK_CANCELLED', { taskId, correlationId: task.correlationId, status: 'UNKNOWN', taskState: 'CANCELLED', summary: task.summary });
        return Object.freeze({ accepted: true, taskId });
    }

    async function runScenario(scenario = 'recover') {
        if (!SCENARIOS.includes(scenario)) return Object.freeze({ accepted: false, reason: 'scenario_not_allowed', scenario, snapshot: snapshot() });
        if (activeTask && ['RUNNING', 'RECOVERING'].includes(activeTask.state)) return Object.freeze({ accepted: false, reason: 'cycle_busy', snapshot: snapshot() });
        if (tasks.size >= maxTasks) return Object.freeze({ accepted: false, reason: 'task_limit', snapshot: snapshot() });
        if (!running) start();
        const runGeneration = generation, taskId = `r9r2-task-${tasks.size + 1}`, correlationId = `r9r2-correlation-${tasks.size + 1}`;
        if (scenario === 'unauthorized') {
            const denied = attemptTask({ taskId, correlationId, agentId: 'damar', taskType: 'damar.synthetic.await-recovery', principalId: TASK_PRINCIPAL });
            emit('AgentHub', 'TASK_REJECTED', { taskId, correlationId, status: 'UNKNOWN', taskState: 'REJECTED', summary: denied.reason });
            return Object.freeze({ accepted: false, reason: denied.reason, snapshot: snapshot() });
        }
        const taskType = scenario === 'echo' ? 'damar.synthetic.echo' : scenario === 'unknown-task' ? 'damar.synthetic.privileged' : 'damar.synthetic.await-recovery';
        const ticket = issueTaskTicket(taskId, correlationId, scenario === 'wrong-scope' ? 'r9r2.shadow.task.other' : TASK_CAPABILITY,
            scenario === 'expired-grant' ? -1 : grantTtlMs);
        const request = Object.freeze({ taskId, correlationId, agentId: 'damar', taskType, principalId: TASK_PRINCIPAL, scenario });
        const dispatch = dispatchWithTicket(request, ticket);
        if (!dispatch.accepted) {
            emit('AgentHub', 'TASK_REJECTED', { taskId, correlationId, status: 'UNKNOWN', taskState: 'REJECTED', summary: dispatch.reason });
            return Object.freeze({ accepted: false, reason: dispatch.reason, snapshot: snapshot() });
        }
        const waitsForRecovery = ['recover', 'recovery-failure', 'recovery-timeout', 'recovery-cancel', 'replay', 'cross-domain'].includes(scenario);
        const waitsForTool = agentHubExecutionPort && (waitsForRecovery || scenario === 'cancel' || scenario === 'timeout');
        if (waitsForTool) await Promise.race([dispatch.task.shadowToolPending.promise, dispatch.completion.then(() => { throw new Error('shadow task completed before its pending-tool boundary'); })]);
        if (scenario === 'cancel') cancelTask(taskId);
        else if (waitsForRecovery) await scheduler.advanceBy(heartbeatTimeoutMs + watchdogIntervalMs);
        else if (scenario === 'timeout') await scheduler.advanceBy(taskTimeoutMs);
        if (generation !== runGeneration) { await dispatch.completion; return Object.freeze({ accepted: false, reason: 'cycle_stopped', scenario, snapshot: snapshot() }); }
        const result = await dispatch.completion;
        return Object.freeze({ accepted: true, scenario, result: scenario === 'replay' ? Object.freeze({ ...result, replayRejected: activeTask.replayRejected }) : result, snapshot: snapshot() });
    }

    function start() {
        if (running) return snapshot();
        running = true; watchdog.start();
        emit('Runtime', 'STARTED', { status: 'HEALTHY', summary: 'R9R2 bounded shadow runtime started.' });
        return snapshot();
    }

    function stop() {
        generation += 1;
        for (const task of tasks.values()) {
            if (['RUNNING', 'RECOVERING'].includes(task.state)) cancelTask(task.taskId);
            if (task.timeoutHandle) scheduler.clearTimeout(task.timeoutHandle);
        }
        watchdog.stop(); scheduler.clearAll(); running = false;
        tasks.clear(); incidents.clear(); incidentEventIds.clear(); detectedTaskIds.clear(); usedRecoveryIds.clear(); eventHistory.length = 0;
        activeTask = lastTask = null; recoveryHandlerCalls = 0; agentHubRunCalls = 0;
        lastRecovery = Object.freeze({ state: 'IDLE', incidentId: null, taskId: null, handler: null, outcome: null, eventId: null });
        scheduler.reset();
        return snapshot();
    }

    return Object.freeze({ start, stop, runScenario, attemptTask, attemptRecovery: (incident, ticket) => runRecovery(incident, ticket, 'recover', incidentEventIds.get(incident?.id) ?? null), cancelTask, snapshot,
        metadata: Object.freeze({ agentHubDispatch: 'canonical AgentHub.run() on disposable instance', executionPort: 'private AIRuntime shadow bridge',
            watchdogClass: 'canonical Watchdog module; synthetic clock/detection adapter only',
            selfHealing: isolatedSelfHealingEngine ? 'real SelfHealingEngine.recover with branded isolated adapters' : 'isolated no-op handler; production SelfHealingEngine not invoked',
            taskCapability: TASK_CAPABILITY, recoveryCapability: RECOVERY_CAPABILITY, taskGrantScope: Object.freeze([TASK_CAPABILITY]),
            recoveryGrantScope: Object.freeze([RECOVERY_CAPABILITY]), productionToolsEnabled: false, liveSelfHealingEnabled: false,
            isolatedSelfHealingEngine: Boolean(isolatedSelfHealingEngine) }) });
}

module.exports = { createBoundedAutonomyCycle, ManualScheduler, PROVENANCE, TASK_CAPABILITY, RECOVERY_CAPABILITY, SCENARIOS };
