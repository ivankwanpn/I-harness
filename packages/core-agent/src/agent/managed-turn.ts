import type { PluginContext } from '@i-harness/core-plugin';
import { randomUUID } from 'node:crypto';
import { committedFactSeqs, SYSTEM_INPUT_PLUGIN, type ImageInput, type SessionEventView, type FactOutcome, type GenerationOrigin, type CapturedActionFact } from '@i-harness/core-session';
import { assertManagedActionCurrent, readManagedActionMembers, publishManagedExecutionTransient } from '@i-harness/core-session/internal/execution';
import { assertExecutionGeneration } from '../../../session-executor/src/lifecycle/generation-actions.ts';
import { receivedExecutionInputsFor } from '../../../session-executor/src/lifecycle/execution-inputs.ts';
import { modelFailureFacts, type LLMStreamEvent } from '@i-harness/llm-seam';
import type { ManagedAgentHost, ManagedAgentInputOptions, ManagedGenerationAction } from './managed-types.ts';
import type { createManagedAgentContext } from './managed-context.ts';
import type { ManagedRun } from './managed-create.ts';
import type { AgentResult, TurnLifecycle } from './types.ts';
import { createModelStep } from './model-step.ts';
import { createStepInput, feedbackText } from './step-input.ts';
import { openStepBoundary, closeStepBoundary, closeTurnBoundary } from './boundaries.ts';
import { completeModelStep, settleFailedTurn, reportModelUsage } from './finalization.ts';
import { acceptModelExchange } from './exchange.ts';
import { createUnstartedCallSettlement } from './unstarted-call-settlement.ts';
import { createAcceptanceSettlement } from './acceptance-settlement.ts';
import { createManagedReduction } from './context-reduction/managed.ts';
import { createManagedAdmission } from './managed-admission.ts';
import { createManagedBatchSource } from '../tool-batch/managed-source.ts';
import type { ManagedFactWitness } from '../tool-batch/managed-model-origin.ts';
import { managedToolGenerationFactory } from './tool-generation.ts';
import { executeToolCalls, type BatchCall } from '../execute-tool-calls.ts';
import { savingFailure } from './saving-failure.ts';
type Call = {
    capture: CapturedActionFact<FactOutcome>;
    witness?: ManagedFactWitness;
    call?: BatchCall;
    handled: boolean;
    cancel?: ReturnType<ManagedRun['source']['tools']['captureResult']>;
};
const lifetime = (): TurnLifecycle => ({ turnOpen: false, stepOpen: false, providerCompleted: false, stepFailed: false });
export function createManagedTurnRunner(_ctx: PluginContext, host: ManagedAgentHost, context: ReturnType<typeof createManagedAgentContext>, maxParallel: number) {
    let steps = 0, callOrdinal = 0;
    const inputOwner = receivedExecutionInputsFor(host.execution), closed = new WeakSet<object>(), reasoning: string[] = [];
    const prepareRequest = createStepInput({ sessionId: host.domain.sessionId, get telemetry() { return host.telemetry; }, rewriteObservation: () => ({ ...host.execution.observe().rewrite() }) });
    const assertGeneration = (run: ManagedRun) => {
        const generation = run.generation;
        if (!generation)
            throw TypeError('Original generation required');
        assertExecutionGeneration(host.execution, generation);
        return generation;
    };
    const closeGeneration = async (generation: ManagedGenerationAction | undefined, disposition: Parameters<ManagedGenerationAction['close']>[0]) => {
        if (!generation || closed.has(generation))
            return;
        if (generation.originalCloseInvoked?.()) {
            if (!generation.recoverClose)
                throw TypeError('Original generation close recovery missing');
            await generation.recoverClose();
        }
        else
            await generation.close(disposition);
        closed.add(generation);
    };
    async function runTurn(run: ManagedRun, message: string, images?: ImageInput[], inputId?: string, options?: ManagedAgentInputOptions): Promise<AgentResult> {
        const { action, source, invocation } = run, signal = action.signal, lifecycle = lifetime(), calls = new Set<Call>();
        let failure: unknown, failed = false;
        const owned = { facts: action.facts, sourceFacts: source, flush: host.flush };
        run.failureCleanup = async () => {
            const errors: unknown[] = [];
            for (const call of calls)
                if (!call.handled && call.witness) {
                    try {
                        const event = readManagedActionMembers(host.domain, action, call.witness.capture, call.witness.outcome)[0];
                        if (event?.type === 'tool/call') {
                            call.cancel ??= source.tools.captureResult({ type: 'tool/result', callId: event.callId, name: event.name, isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH', error: 'Original response did not dispatch this call' } });
                            committedFactSeqs(await call.cancel.admit());
                            call.handled = true;
                        }
                    }
                    catch (error) {
                        errors.push(error);
                    }
                }
            if (lifecycle.deferredFailure) {
                try {
                    await lifecycle.deferredFailure(failure);
                }
                catch (error) {
                    errors.push(error);
                }
            }
            else {
                try {
                    await closeGeneration(run.generation, signal.aborted ? 'stopped' : 'failed');
                }
                catch (error) {
                    errors.push(error);
                }
                try {
                    await settleFailedTurn(owned, lifecycle, failure);
                }
                catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length)
                throw savingFailure(failure, errors, 'Original turn cleanup requires recovery');
        };
        try {
            if (!run.lifecycle)
                throw TypeError('Original generation lifecycle required');
            const start = { wall: Date.now(), monotonic: performance.now() }, provenance = options?.provenance ?? { kind: 'unknown' as const, authority: 'unknown' as const, scope: 'turn' as const, producer: 'agent.run' };
            if (!inputId) {
                inputId = randomUUID();
                await inputOwner.inbox.admit({ inputId, text: message, intent: 'user', delivery: 'queue', provenance, ...images?.length ? { images } : {} }, signal);
            }
            const observation = host.execution.observe(), admission = observation.inbox.pending(observation.header?.seedLength ?? 0).find(input => input.inputId === inputId);
            if (!admission || admission.text !== message || !observation.inbox.isExecutable(inputId))
                throw Object.assign(Error('Original pending input required'), { code: 'GENERATION_STALE' });
            if (admission.provenance && options?.provenance && (['kind', 'authority', 'scope', 'producer', 'originSessionId'] as const).some(key => admission.provenance![key] !== options.provenance[key]))
                throw Error('Input provenance conflicts with original admission');
            let origin: GenerationOrigin = admission.intent === 'system' ? { kind: 'observation-input', seq: admission.admittedSeq, inputId } : admission.provenance?.kind === 'inherited' ? { kind: 'delegated-input', ref: 'admitted', seq: admission.admittedSeq, inputId } : { kind: 'input', seq: admission.admittedSeq };
            run.generation = options?.generation ?? await run.lifecycle.open('main', origin, { signal, start, timeoutMs: host.modelActionTimeoutMs, maxAttempts: host.modelActionMaxAttempts });
            assertGeneration(run);
            if (options?.generation) {
                if (options.delegatedOrigin)
                    options.generation.adoptDelegatedExecution(host.execution.identity, options.delegatedOrigin, signal);
                else {
                    if (!options.preparation)
                        throw Object.assign(Error('Original input preparation required'), { code: 'GENERATION_STALE' });
                    options.generation.adoptExecution(host.execution.identity, inputId, options.preparation, signal);
                }
            }
            if (host.execution.observe().semanticsStartSeq() === undefined)
                await run.admit(action.captureLifecycle!({ type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' }));
            const input = await run.admit(action.captureInputPromotion({ kind: 'input-start', promoted: { type: 'agent/input/promoted', version: 1, inputId }, turn: { type: 'turn/start' }, message: { type: 'user/message', text: message, ...admission.provenance ? { provenance: { ...admission.provenance } } : {}, input: { inputId, intent: admission.intent, ...admission.provenance ? { provenance: { ...admission.provenance } } : {}, ...admission.synthetic ? { synthetic: structuredClone(admission.synthetic) } : {} }, ...admission.images?.length ? { imageInputId: inputId } : {}, ...admission.intent === 'system' ? { source: { kind: 'plugin', plugin: SYSTEM_INPUT_PLUGIN } } : {} }, ...options?.preparation ? { preparation: options.preparation } : {} }, () => {
                try {
                    assertManagedActionCurrent(host.domain, action);
                    assertGeneration(run);
                    return true;
                }
                catch {
                    return false;
                }
            }), () => { lifecycle.turnOpen = true; });
            invocation.input(input);
            if (admission.provenance?.kind === 'human' && admission.provenance.authority === 'request' && admission.intent === 'user')
                host.requestContext?.promotedHumanRequest();
            host.telemetry?.emit({ type: 'turn/start', ts: Date.now(), data: { message } });
            let first = true, stopContinuations = 0, finalText = '';
            for (;;) {
                signal.throwIfAborted();
                if (!first)
                    run.generation = await run.lifecycle.open('main', origin, { signal, timeoutMs: host.modelActionTimeoutMs, maxAttempts: host.modelActionMaxAttempts });
                const generation = assertGeneration(run), parentActionId = generation.actionId;
                steps++;
                if (host.maxTurns !== undefined && steps > host.maxTurns)
                    throw Error(`maxTurns exceeded: ${host.maxTurns}`);
                await host.stepInputs?.claimAtStepBoundary(action.facts.inputs, run.preparation ? input => run.preparation!.prepare(input, generation) : undefined, async (promoted, text, preparation) => (await run.admit(action.captureInputPromotion({ kind: 'steer-claim', promoted, message: text, ...preparation ? { preparation } : {} }, () => {
                    try {
                        assertManagedActionCurrent(host.domain, action);
                        assertGeneration(run);
                        return true;
                    }
                    catch {
                        return false;
                    }
                }))).outcome);
                let startWitness = await run.admit(action.captureLifecycle!({ type: 'step/start', actionId: generation.actionId, attemptId: randomUUID() }));
                openStepBoundary(lifecycle);
                const hookSurface = host.hooks.capture();
                await host.hooks.emit('agent/pre-step', { task: message, domain: host.domain, sessionId: host.domain.sessionId, signal, promptSubmission: first }, hookSurface);
                assertManagedActionCurrent(host.domain, action);
                first = false;
                const scope = Object.freeze({ sessionId: host.domain.sessionId, turnId: randomUUID(), ...host.isSubagent ? { isSubagent: true } : {} }), reduction = createManagedReduction(host, context, action, () => run.generation, run.register), admissionOwner = createManagedAdmission(host, context, action, () => assertGeneration(run), reduction, run.register, prepareRequest, scope);
                const callWitnesses = new Map<BatchCall, ManagedFactWitness>(), unstarted = createUnstartedCallSettlement({ registerFactSource: run.register, readOriginalCall(call) {
                        const witness = callWitnesses.get(call);
                        if (!witness)
                            throw TypeError('Original call capture required');
                        const event = readManagedActionMembers(host.domain, action, witness.capture, witness.outcome)[0];
                        if (event?.type !== 'tool/call')
                            throw TypeError('Original call member required');
                        return event;
                    } }), acceptance = createAcceptanceSettlement({ registerFactSource: run.register, flush: host.flush }, unstarted.close);
                const state: import('./execution.ts').CandidateExecutionState & import('./recovery.ts').RecoveryAdmissionState = { epochRebuilds: 0, hasStartedSend: false, hasObservedOutput: false, reductionAttempts: { count: 0, staleRebuilds: 0 } };
                let step: ReturnType<ReturnType<typeof createModelStep>['result']> | undefined, acceptedCapture: CapturedActionFact<FactOutcome> | undefined, acceptedEvent: Extract<SessionEventView, {
                    type: 'model/exchange-accepted';
                }> | undefined, candidate: Awaited<ReturnType<typeof admissionOwner.admit>> | undefined, instructions: import('@i-harness/core-tools').AcceptedInstructionBatch | undefined, accepted = false;
                let responseFailed = false, responseFailure: unknown;
                try {
                    for (;;) {
                        candidate = await admissionOwner.admit(signal, state, () => steps);
                        const firstEvent = readManagedActionMembers(host.domain, action, startWitness.capture, startWitness.outcome)[0];
                        if (firstEvent?.type !== 'step/start')
                            throw TypeError('Original physical step required');
                        const stream = createModelStep({ facts: action.facts, sourceFacts: source, telemetry: host.telemetry, streamSource: { eventCount: () => host.execution.observe().eventCount, publish: event => publishManagedExecutionTransient(host.domain, source, event) } }, reasoning, async (event: Extract<LLMStreamEvent, {
                            type: 'tool_call';
                        }>) => {
                            let callId = event.call.id ?? `call_${++callOrdinal}`;
                            if (event.call.id && host.execution.observe().hasToolCallId(callId))
                                throw Error(`duplicate provider tool call id: ${callId}`);
                            while (!event.call.id && host.execution.observe().hasToolCallId(callId))
                                callId = `call_${++callOrdinal}`;
                            const capture = action.captureToolCall!({ type: 'tool/call', callId, name: event.call.name, args: event.call.args }), record: Call = { capture, handled: false };
                            calls.add(record);
                            const witness = await run.admit(capture, received => { record.witness = received; });
                            const member = readManagedActionMembers(host.domain, action, capture, witness.outcome)[0];
                            if (member?.type !== 'tool/call')
                                throw TypeError('Original captured call required');
                            const call = { callId: member.callId, name: member.name, args: member.args, eventSeq: member.seq };
                            record.call = call;
                            callWitnesses.set(call, witness);
                            return call;
                        }, lifecycle, firstEvent.seq!, signal, () => steps, firstEvent);
                        let rebuild = false, streamFailed = false, streamFailure: unknown;
                        try {
                            for await (const event of candidate.prepared.stream({ generation: candidate.control, confirmExecution: confirmation => {
                                    const receipt = candidate!.execution.confirm(confirmation);
                                    if (receipt)
                                        stream.confirm(receipt);
                                }, validateBeforeTransport: candidate.validateBeforeTransport, onTransportIssue() { state.hasStartedSend = true; } })) {
                                if (event.type !== 'activity' && event.type !== 'retry' && event.type !== 'error')
                                    state.hasObservedOutput = true;
                                await stream.accept(event);
                            }
                        }
                        catch (error) {
                            streamFailed = true;
                            streamFailure = error;
                            try {
                                try {
                                    reportModelUsage(host, stream.result());
                                }
                                catch (reporting) {
                                    await stream.fail(savingFailure(error, [reporting], 'Original model usage reporting failed'));
                                }
                                const physical = stream.result();
                                for (const call of calls)
                                    if (call.call && physical.batch.includes(call.call))
                                        call.handled = true;
                                const failure = modelFailureFacts(error), handoff = candidate.execution.handoff();
                                if ((error as {
                                    code?: string;
                                })?.code === 'EXECUTION_IDENTITY_CHANGED' && handoff && !state.hasStartedSend && !state.hasObservedOutput && state.epochRebuilds++ === 0) {
                                    state.handoff = handoff;
                                    rebuild = true;
                                }
                                else if ((error as {
                                    code?: string;
                                })?.code === 'CONTEXT_INPUT_STALE' && !state.hasStartedSend && !state.hasObservedOutput && ++state.reductionAttempts!.staleRebuilds <= 3)
                                    rebuild = true;
                                else if (!physical.providerEnded && failure?.code === 'CONTEXT_WINDOW_EXCEEDED' && failure.reason === 'context-limit') {
                                    await stream.discard();
                                    const required = await admissionOwner.recovery.require(error, candidate.prepared.measurement, firstEvent.seq!, signal);
                                    if (required.kind === 'blocked')
                                        throw required.error;
                                    startWitness = await run.admit(action.captureLifecycle!({ type: 'step/start', actionId: generation.actionId, attemptId: randomUUID() }));
                                    openStepBoundary(lifecycle);
                                    rebuild = true;
                                }
                                else
                                    await stream.fail(error);
                            }
                            catch (failed) {
                                streamFailure = failed;
                                throw failed;
                            }
                        }
                        finally {
                            candidate.execution.close();
                            try {
                                await stream.settle();
                            }
                            catch (cleanup) {
                                if (streamFailed)
                                    throw savingFailure(streamFailure, [cleanup], 'Original model attempt cleanup failed');
                                throw cleanup;
                            }
                        }
                        if (rebuild)
                            continue;
                        step = stream.result();
                        if (!step.providerEnded)
                            await stream.fail(Object.assign(Error('Model response ended without explicit completion'), { code: 'MODEL_RESPONSE_INCOMPLETE' }));
                        if (step.refusedThisStep || step.truncatedThisStep) {
                            for (const call of calls)
                                if (call.call && step.batch.includes(call.call))
                                    call.handled = true;
                            await stream.discard();
                            throw Object.assign(Error('Model response refused or truncated'), { code: step.refusedThisStep ? 'MODEL_REFUSED' : 'MODEL_OUTPUT_TRUNCATED' });
                        }
                        break;
                    }
                    unstarted.capture(step!.batch, candidate!.captured.instructions ? host.requestContext!.retain(candidate!.captured.instructions) : undefined);
                    for (const record of calls)
                        if (record.call && step!.batch.includes(record.call))
                            record.handled = true;
                    lifecycle.deferredFailure = error => acceptance.fail(async (complete) => { lifecycle.providerCompleted = complete; await closeGeneration(generation, signal.aborted ? 'stopped' : 'failed'); await settleFailedTurn(owned, lifecycle, error); });
                    const result = await acceptModelExchange({ facts: action.facts, flush: host.flush, generationAction: generation, captureModelExchange(...args) { assertManagedActionCurrent(host.domain, action); const capture = action.captureModelExchange(...args); acceptedCapture = capture; return capture; }, readAccepted(capture, outcome) {
                            if (outcome.kind !== 'committed')
                                throw TypeError('Original durable acceptance required');
                            const event = readManagedActionMembers(host.domain, action, capture, outcome).find(event => event.type === 'model/exchange-accepted');
                            if (event?.type !== 'model/exchange-accepted')
                                throw TypeError('Original acceptance member required');
                            acceptedEvent = event;
                            return event;
                        } }, { identity: step!.identity, step: step!, signal, request: candidate!.execution.attribution(step!.receipt), onCapture: acceptance.retain, onOutcome: acceptance.outcome, onAccepted() { lifecycle.providerCompleted = true; } });
                    if (result.outcome.kind !== 'committed' || !acceptedCapture || !acceptedEvent)
                        throw TypeError('Original acceptance ACK missing');
                    if (acceptedEvent.version === 2)
                        context.acknowledge(acceptedEvent);
                    await completeModelStep(host, { ownedBudget: context.budget }, step!, candidate!.prepared.measurement, acceptedEvent.version === 2 ? acceptedEvent : undefined, signal);
                    await acceptance.close();
                    lifecycle.deferredFailure = undefined;
                    await closeGeneration(generation, 'accepted');
                    accepted = true;
                    const witnesses = step!.batch.map(call => callWitnesses.get(call)!), acceptedWitness = { capture: acceptedCapture, outcome: result.outcome }, token = invocation.accepted(acceptedWitness, witnesses);
                    invocation.closed(token);
                    if (candidate!.captured.instructions && step!.receipt)
                        instructions = host.requestContext!.managedSucceeded({ ...result, outcome: result.outcome, domain: host.domain, action, accepted: acceptedWitness, candidate: candidate!.captured, evidence: candidate!.captured.instructions, physicalExecutionReceipt: step!.receipt, calls: step!.batch.map((call, index) => ({ callId: call.callId, eventSeq: call.eventSeq, call: { name: call.name, args: call.args }, ...witnesses[index]! })) });
                    if (step!.batch.length) {
                        const pendingInstructions = instructions;
                        await unstarted.handoff(take => {
                            const batchSource = createManagedBatchSource(host.domain, action, invocation, token, step!.batch, witnesses, host.hooks, drain => {
                                const actual = run.register(async () => { await drain(); await pendingInstructions?.release(); });
                                take();
                                for (const record of calls)
                                    if (record.call && step!.batch.includes(record.call))
                                        record.handled = true;
                                return actual;
                            });
                            return executeToolCalls(_ctx, batchSource, host.tools, step!.batch, { maxParallel, signal, sessionId: host.domain.sessionId, modelGeneration: managedToolGenerationFactory(host, batchSource, run.lifecycle!, parentActionId), ...pendingInstructions ? { instructionBatch: pendingInstructions } : {}, telemetry: host.telemetry, flush: host.flush });
                        }, async () => { await pendingInstructions?.release(); });
                        instructions = undefined;
                    }
                    else {
                        invocation.releaseBatch(token);
                        await instructions?.release();
                        instructions = undefined;
                        await unstarted.close();
                    }
                    for (const record of calls)
                        if (record.handled)
                            calls.delete(record);
                    callWitnesses.clear();
                    await admissionOwner.recovery.resolve(candidate!.prepared.measurement, signal);
                    origin = { kind: 'predecessor', seq: result.acceptedSeq };
                }
                catch (error) {
                    responseFailed = true;
                    responseFailure = error;
                    if (!accepted && lifecycle.deferredFailure)
                        try {
                            await lifecycle.deferredFailure(error);
                        }
                        catch (cleanup) {
                            responseFailure = savingFailure(error, [cleanup], 'Original acceptance cleanup failed');
                        }
                    throw responseFailure;
                }
                finally {
                    try {
                        await admissionOwner.recovery.close();
                    }
                    catch (cleanup) {
                        if (responseFailed)
                            throw savingFailure(responseFailure, [cleanup], 'Original recovery cleanup failed');
                        throw cleanup;
                    }
                }
                const actual = step!;
                await closeStepBoundary(owned, lifecycle, { type: 'step/end', ...actual.truncatedThisStep ? { truncated: true } : {}, ...actual.refusedThisStep ? { refused: true } : {} });
                await host.hooks.emit('agent/step', { domain: host.domain, sessionId: host.domain.sessionId, turns: steps, text: actual.stepText, signal });
                finalText = actual.stepText;
                if (actual.toolCallsThisStep)
                    continue;
                const verdict = await host.hooks.emit('agent/pre-stop', { domain: host.domain, sessionId: host.domain.sessionId, turns: steps, finalText, signal, stopHookActive: stopContinuations > 0 }) as {
                    continuation?: {
                        reason?: unknown;
                    };
                } | undefined, reason = verdict?.continuation?.reason;
                signal.throwIfAborted();
                if (typeof reason === 'string' && reason.trim()) {
                    stopContinuations++;
                    committedFactSeqs(await action.facts.agent.feedback({ type: 'user/message', text: feedbackText(reason), source: { kind: 'plugin', plugin: 'hooks' }, provenance: { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'agent.hooks' } }));
                    continue;
                }
                break;
            }
            await closeTurnBoundary(owned, lifecycle);
            await host.hooks.emit('agent/stop', { domain: host.domain, sessionId: host.domain.sessionId, turns: steps, finalText });
            await host.flush?.();
            return { finalText, turns: steps, reasoning: [...reasoning] };
        }
        catch (error) {
            failure = error;
            failed = true;
            throw error;
        }
        finally {
            if (!failed) {
                calls.clear();
                run.failureCleanup = undefined;
            }
        }
    }
    return { run: runTurn, async compact(run: ManagedRun, instructions?: string, options?: Parameters<import('./managed-types.ts').ManagedAgent['compact']>[1]) {
            if (!run.lifecycle)
                throw TypeError('Original generation lifecycle required');
            let generation = options?.generation;
            if (generation) {
                assertExecutionGeneration(host.execution, generation);
                generation.adoptManualExecution(host.execution.identity, run.action.signal);
            }
            else {
                const command = await run.admit(run.action.captureMetadata!({ type: 'command/run', commandId: randomUUID(), name: 'compact', ...instructions !== undefined ? { args: instructions } : {}, source: { kind: 'user' } }));
                generation = await run.lifecycle.open('manual', { kind: 'command', seq: command.outcome.seqs[0]! }, { signal: run.action.signal, timeoutMs: host.modelActionTimeoutMs });
            }
            run.generation = generation;
            assertGeneration(run);
            run.failureCleanup = () => closeGeneration(generation, run.action.signal.aborted ? 'stopped' : 'failed');
            const reduce = createManagedReduction(host, context, run.action, () => run.generation, run.register);
            const result = await reduce({ ...options, signal: run.action.signal, reason: 'manual' }, instructions);
            if (result.publication !== 'recovery-required') {
                await closeGeneration(generation, 'completed');
                run.failureCleanup = undefined;
            }
            return result;
        } };
}
