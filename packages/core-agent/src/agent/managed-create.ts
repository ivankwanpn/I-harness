import type { PluginContext } from '@i-harness/core-plugin';
import { isExecutionHookChannel } from '@i-harness/core-plugin';
import { isManagedExecutionDomain, assertManagedActionCurrent } from '@i-harness/core-session/internal/execution';
import { isManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts';
import type { CapturedActionFact, FactOutcome, ManagedAction, SettlementFacts } from '@i-harness/core-session';
import { committedFactSeqs } from '@i-harness/core-session';
import type { ManagedAgent, ManagedAgentHost, ManagedGenerationLifecycle, ManagedGenerationAction, ManagedInputPreparation } from './managed-types.ts';
import { createManagedAgentContext } from './managed-context.ts';
import { consumeManagedAgentModelOrigin, createManagedModelInvocation, type ManagedFactWitness } from '../tool-batch/managed-model-origin.ts';
import { createManagedTurnRunner } from './managed-turn.ts';
import { savingFailure } from './saving-failure.ts';
const managedAgents = new WeakMap<object, {
    execution: ManagedAgentHost['execution'];
    domain: ManagedAgentHost['domain'];
}>();
export function assertManagedAgentCurrent(execution: ManagedAgentHost['execution'], agent: object) {
    const original = managedAgents.get(agent);
    if (!original || original.execution !== execution || !isManagedExecutionAttachment(execution) || !isManagedExecutionDomain(original.domain))
        throw TypeError('Original private Agent/execution pair required');
    original.domain.assertCurrent();
}
export interface ManagedRun {
    readonly action: ManagedAction<FactOutcome>;
    readonly source: SettlementFacts<FactOutcome>;
    lifecycle?: ManagedGenerationLifecycle;
    readonly preparation?: ManagedInputPreparation;
    readonly invocation: ReturnType<typeof createManagedModelInvocation>;
    generation?: ManagedGenerationAction;
    register(drain: () => Promise<void>): SettlementFacts<FactOutcome>;
    admit(capture: CapturedActionFact<FactOutcome>, onCommitted?: (witness: ManagedFactWitness) => void | Promise<void>): Promise<ManagedFactWitness>;
    failureCleanup?: () => Promise<void>;
}
function captureDependencies(host: ManagedAgentHost): ManagedAgentHost {
    const deps = {} as ManagedAgentHost;
    for (const key of ['execution', 'domain', 'hooks', 'modelCallOrigin', 'tools', 'requestContext', 'generationFactory', 'inputPreparationFactory', 'summaryFactory', 'maxTurns', 'maxParallelToolCalls'] as const) {
        const value = host[key];
        Object.defineProperty(deps, key, { enumerable: true, value: typeof value === 'function' ? value.bind(host) : value });
    }
    Object.defineProperty(deps, 'sessionId', { enumerable: true, value: host.domain.sessionId });
    for (const key of ['model', 'systemPrompt', 'signal', 'budget', 'compact', 'reasoningEffort', 'maxOutputTokens', 'modelActionTimeoutMs', 'modelActionMaxAttempts', 'autoCompactionEnabled', 'executionIdentity', 'bindingForStep', 'modelBindingIdentity', 'budgetBinding', 'contextMetadata', 'modelToolSchemas', 'modelOverheadTokens', 'isSubagent', 'telemetry', 'flush', 'stepInputs'] as const)
        Object.defineProperty(deps, key, { enumerable: true, get() { const value = host[key]; return typeof value === 'function' ? value.bind(host) : value; } });
    return deps;
}
/** Closed private constructor. Public createAgent remains the complete-view
 * SDK/compatibility path and provider executionIdentity keeps its old meaning. */
export function createManagedAgent(ctx: PluginContext, originalHost: ManagedAgentHost): ManagedAgent {
    const host = originalHost;
    for (const key of ['execution', 'domain', 'hooks', 'modelCallOrigin', 'tools']) {
        const field = Object.getOwnPropertyDescriptor(host, key);
        if (!field || !('value' in field))
            throw TypeError('Private construction identities must be own data');
    }
    if (!isManagedExecutionAttachment(host.execution) || !isManagedExecutionDomain(host.domain, ctx) || host.domain.identity !== host.execution.identity || host.domain.owner !== host.execution.owner || !isExecutionHookChannel(host.hooks, ctx))
        throw TypeError('Original matching execution/domain/hook construction required');
    if (Object.hasOwn(host, 'session') || Object.hasOwn(host, 'factOwner') || Object.hasOwn(host, 'ensureWritableContext'))
        throw TypeError('Private Agent requires original private readiness');
    if (typeof host.generationFactory !== 'function')
        throw Object.assign(Error('Original generation lifecycle factory required'), { code: 'GENERATION_UNSUPPORTED' });
    host.domain.assertCurrent();
    host.hooks.capture();
    const deps = captureDependencies(host);
    return constructManagedAgent(ctx, deps);
}
function constructManagedAgent(ctx: PluginContext, host: ManagedAgentHost): ManagedAgent {
    const origin = consumeManagedAgentModelOrigin(host.modelCallOrigin, host.domain, host.tools), context = createManagedAgentContext(host);
    const maxParallel = host.maxParallelToolCalls ?? 10;
    if (!Number.isInteger(maxParallel) || maxParallel < 1)
        throw RangeError('maxParallelToolCalls must be positive');
    let busy = false;
    const turn = createManagedTurnRunner(ctx, host, context, maxParallel);
    async function operate<T>(signal: AbortSignal | undefined, operation: (run: ManagedRun) => Promise<T>): Promise<T> {
        if (busy)
            throw Object.assign(Error('Agent invocation is already active'), { code: 'AGENT_BUSY' });
        busy = true;
        let action: ManagedAction<FactOutcome> | undefined, source: SettlementFacts<FactOutcome> | undefined, run: ManagedRun | undefined, value: T | undefined, primary: unknown, failed = false, operationDone = false, failureClosed = false;
        const done = Promise.withResolvers<void>(), delegates = new Set<SettlementFacts<FactOutcome>>(), pending = new Map<CapturedActionFact<FactOutcome>, {
            notify?: (witness: ManagedFactWitness) => void | Promise<void>;
            notified: boolean;
        }>();
        const drainDelegates = async () => {
            const errors: unknown[] = [];
            for (const delegate of [...delegates].reverse())
                try {
                    await delegate.close();
                    delegates.delete(delegate);
                }
                catch (error) {
                    errors.push(error);
                }
            if (errors.length)
                throw new AggregateError(errors, 'Original delegated sources require recovery');
        };
        const drainPending = async () => {
            for (const [capture, entry] of pending) {
                let outcome = await capture.observe();
                if (outcome.kind === 'unknown' || outcome.kind === 'conflict' || outcome.kind === 'recovery-required')
                    outcome = await capture.reconcile();
                if (outcome.kind === 'committed') {
                    if (!entry.notified) {
                        entry.notified = true;
                        await entry.notify?.({ capture, outcome });
                    }
                    pending.delete(capture);
                }
                else if (outcome.kind === 'not-issued' || outcome.kind === 'absent')
                    pending.delete(capture);
                else
                    throw Object.assign(Error('Original action capture requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' });
            }
        };
        try {
            host.domain.assertCurrent();
            host.hooks.capture();
            action = host.execution.owner.beginAction(signal ?? host.signal);
            assertManagedActionCurrent(host.domain, action);
            const original = action, register = original.registerSettlementSource.bind(original);
            source = register(async () => {
                await done.promise;
                try {
                    await drainPending();
                    await drainDelegates();
                    await run?.preparation?.close();
                    if (run?.failureCleanup && !failureClosed) {
                        failureClosed = true;
                        await run.failureCleanup();
                    }
                    await run?.lifecycle?.drain();
                    await context.close();
                    original.finish();
                }
                catch (error) {
                    source!.holdRecovery();
                    throw error;
                }
            });
            const root = source;
            const managed: ManagedRun = { action: original, source: root, invocation: createManagedModelInvocation(origin, original), register(drain) { assertManagedActionCurrent(host.domain, original); const delegated = register(drain); delegates.add(delegated); return delegated; }, async admit(capture, notify) {
                    const entry = { notify, notified: false };
                    pending.set(capture, entry);
                    const outcome = await capture.admit();
                    committedFactSeqs(outcome);
                    if (outcome.kind !== 'committed')
                        throw TypeError('Original durable fact required');
                    const witness = { capture, outcome };
                    entry.notified = true;
                    await notify?.(witness);
                    pending.delete(capture);
                    return witness;
                } };
            run = managed;
            managed.lifecycle = host.generationFactory(original, { async beforeDrain() { await done.promise; await drainPending(); await drainDelegates(); } });
            assertManagedActionCurrent(host.domain, original);
            const preparation = host.inputPreparationFactory?.(original);
            if (preparation)
                Object.defineProperty(managed, 'preparation', { value: preparation, enumerable: true });
            context.bindAction(original.facts, root);
            value = await operation(managed);
        }
        catch (error) {
            primary = error;
            failed = true;
        }
        finally {
            operationDone = true;
            done.resolve();
            run?.invocation.invalidate();
        }
        try {
            if (source)
                await source.close();
            else
                await context.close();
            action?.finish();
        }
        catch (cleanup) {
            if (failed)
                primary = savingFailure(primary, [cleanup], 'Private Agent original settlement requires recovery');
            else {
                primary = cleanup;
                failed = true;
            }
        }
        finally {
            if (operationDone)
                busy = false;
        }
        if (failed)
            throw primary;
        return value!;
    }
    const run: ManagedAgent['run'] = (task, signal, images, inputId, options) => operate(signal, state => turn.run(state, task, images, inputId, options));
    const agent: ManagedAgent = Object.freeze({ run, runAdmitted: run, followup: (message: string, signal?: AbortSignal, options?: import('./managed-types.ts').ManagedAgentInputOptions) => run(message, signal, undefined, undefined, options), compact: (instructions?: string, options?: Parameters<ManagedAgent['compact']>[1]) => operate(options?.signal, state => turn.compact(state, instructions, options)), contextBudget: () => context.readBudget(), updateContext(config: Parameters<NonNullable<ManagedAgent['updateContext']>>[0]) {
            if (busy)
                throw Error('agent is busy');
            context.update(config);
        } });
    managedAgents.set(agent, { execution: host.execution, domain: host.domain });
    return agent;
}
