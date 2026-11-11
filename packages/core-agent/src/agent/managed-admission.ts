import { prepareModelRequest, type LLMRequest } from '@i-harness/llm-seam';
import { assertManagedActionCurrent, getManagedExecutionAdmissionWait } from '@i-harness/core-session/internal/execution';
import type { ManagedAction, FactOutcome, SettlementFacts } from '@i-harness/core-session';
import { assertExecutionGeneration } from '../lifecycle/generation-actions.ts';
import type { ManagedAgentHost, ManagedGenerationAction } from './managed-types.ts';
import type { createManagedAgentContext } from './managed-context.ts';
import type { createManagedReduction } from './context-reduction/managed.ts';
import { createRecovery, type RecoveryAdmissionState } from './recovery.ts';
import { assertCurrentRepresentable } from './current-representability.ts';
import { stalePreparedInput, isRequestContextRebuild } from './admission.ts';
import type { CandidateExecutionState } from './execution.ts';
import type { createStepInput } from './step-input.ts';
import { generationRequestLease } from './generation-request-lease.ts';
export function createManagedAdmission(host: ManagedAgentHost, context: ReturnType<typeof createManagedAgentContext>, action: ManagedAction<FactOutcome>, generation: () => ManagedGenerationAction, reduction: ReturnType<typeof createManagedReduction>, register: (drain: () => Promise<void>) => SettlementFacts<FactOutcome>, prepareRequest: ReturnType<typeof createStepInput>, scope: LLMRequest['requestScope'], onCaptured?: (candidate: import('./request-snapshot.ts').RequestEvidence) => void) {
    const recovery = createRecovery({ facts: action.facts, registerFactSource: register, flush: host.flush, get generationAction() { return generation(); }, recoveryObservation: binding => host.execution.observe().recovery(binding) }, { ownedBudget: context.budget, metadata: context.metadata, ...context.hasCompact ? { recoverOwned: options => reduction(options, undefined, scope) } : {} });
    return { recovery, async admit(signal: AbortSignal, state: RecoveryAdmissionState & CandidateExecutionState, getSteps: () => number) {
            const attempts = state.reductionAttempts ??= { count: 0, staleRebuilds: 0 };
            const stale = () => {
                if (++attempts.staleRebuilds > 3)
                    throw stalePreparedInput();
            };
            for (;;) {
                signal.throwIfAborted();
                for (;;) {
                    const wait = getManagedExecutionAdmissionWait(host.domain, action, signal);
                    if (!wait) break;
                    await wait;
                }
                assertManagedActionCurrent(host.domain, action);
                try { await host.requestContext?.reconcile(signal); }
                catch (error) {
                    if (!isRequestContextRebuild(error)) throw error;
                    stale();
                    continue;
                }
                let captured = await context.capture(action, signal);
                if (host.requestContext && !host.requestContext.current(captured.instructions)) {
                    stale();
                    continue;
                }
                onCaptured?.(captured);
                const preparedInput = prepareRequest(signal, scope, getSteps, captured), initial = await prepareModelRequest(captured.model, preparedInput.request);
                if (!context.current(captured)) {
                    stale();
                    continue;
                }
                assertCurrentRepresentable(captured, initial);
                const assess = (authorized = false, selected = initial, selectOutputCap = true) => context.budget.assess(selected, captured, captured.snapshot.surface.contextWindow, captured.snapshot.surface.maxOutputTokens, context.budgetConfig?.reserveRatio, authorized, selectOutputCap, context.pressurePolicy, authorized ? 'recovery' : 'main');
                let assessed = assess();
                if (assessed.decision.disposition === 'blocked')
                    throw Error(assessed.snapshot.coverage === 'incomplete' ? assessed.snapshot.reason : `Prepared request admission blocked: ${assessed.decision.reason}`);
                assertCurrentRepresentable(captured, assessed.prepared);
                const owner = generation();
                assertExecutionGeneration(host.execution, owner);
                await owner.bind(assessed.prepared);
                let refreshed = await context.refresh(action, captured, signal);
                if (!refreshed) {
                    stale();
                    continue;
                }
                captured = refreshed;
                const admission = await recovery.admit(assessed.prepared.measurement, state, signal);
                if (admission === 'rebuild')
                    continue;
                refreshed = await context.refresh(action, captured, signal);
                if (!refreshed) {
                    stale();
                    continue;
                }
                captured = refreshed;
                if (admission === 'authorized')
                    assessed = assess(true, assessed.prepared, false);
                const { snapshot, prepared } = assessed, needsReduction = assessed.decision.disposition === 'reduce' || snapshot.recoveryRequired && admission !== 'authorized';
                if (assessed.disposition)
                    context.budget.retire(assessed.disposition);
                if (snapshot.coverage === 'incomplete')
                    throw Error(snapshot.reason);
                host.telemetry?.emit({ type: 'provider/context', ts: Date.now(), data: { systemBytes: prepared.measurement.input.components.system.textUtf8Bytes, schemaBytes: prepared.measurement.input.components.toolSchemas.structuredBytes, ...assessed.estimate.kind === 'estimated' ? { estimatedInputTokens: assessed.estimate.value, estimateSource: assessed.estimate.source } : { tokenEstimateUnavailable: assessed.estimate.reason }, coverage: snapshot.coverage, reasoningTokens: snapshot.reasoningTokens, outputReserve: snapshot.outputReserve, capSupport: snapshot.capSupport } });
                await context.budget.checkpoint();
                await host.flush?.();
                signal.throwIfAborted();
                refreshed = await context.refresh(action, captured, signal);
                if (!refreshed) {
                    stale();
                    continue;
                }
                captured = refreshed;
                if (context.compactConfig && admission !== 'authorized') {
                    const result = await reduction({ signal, attempts, reason: needsReduction ? 'manual' : 'auto' }, undefined, scope);
                    if (result.publication === 'recovery-required')
                        throw Object.assign(Error('Context reduction requires reconciliation'), { code: 'FACT_RECOVERY_REQUIRED' });
                    if (result.compacted)
                        continue;
                    refreshed = await context.refresh(action, captured, signal);
                    if (!refreshed) {
                        stale();
                        continue;
                    }
                    captured = refreshed;
                }
                if (needsReduction)
                    throw Error(`prompt_too_long: prepared context cannot fit the owned window (${snapshot.admissionInputTokens} input tokens; ${snapshot.outputReserve} output reserve)`);
                const current = () => context.current(captured), validateBeforeTransport = () => {
                    signal.throwIfAborted();
                    assertManagedActionCurrent(host.domain, action);
                    assertExecutionGeneration(host.execution, owner);
                    if (!current())
                        throw stalePreparedInput();
                    assertCurrentRepresentable(captured, prepared);
                    recovery.validate(prepared.measurement, state);
                };
                validateBeforeTransport();
                const execution = context.execution.candidate(prepared, captured, state, assessed.calibrated, current, () => context.budget.retire('execution-identity-changed'));
                const control = generationRequestLease(owner.control(state.recoveryId ? 'recovery' : 'main', validateBeforeTransport), async () => {
                    const next = await context.refresh(action, captured, signal);
                    if (!next)
                        return false;
                    captured = next;
                    return current();
                });
                return { prepared, captured, execution, control, validateBeforeTransport };
            }
        } };
}
