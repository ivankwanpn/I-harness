import { reduceContext, captureContextPayload, type ReductionRunOptions, type ReductionResult, type ContextSnapshot } from '@i-harness/context-engine';
import { previewRestoredConversationCandidate } from '@i-harness/core-session/internal/restoration';
import { assertManagedActionCurrent, readManagedActionMembers } from '@i-harness/core-session/internal/execution';
import type { ManagedAction, FactOutcome, SettlementFacts } from '@i-harness/core-session';
import { resolveCompactSpec } from '@i-harness/compaction';
import { prepareModelRequest, mapModelRequest, isGenerationError } from '@i-harness/llm-seam';
import { assertExecutionGeneration } from '../../../../session-executor/src/lifecycle/generation-actions.ts';
import { projectionFingerprint } from '@i-harness/token-meter';
import { randomUUID } from 'node:crypto';
import type { ManagedAgentHost, ManagedGenerationAction } from '../managed-types.ts';
import type { createManagedAgentContext } from '../managed-context.ts';
import { createReductionBridge } from './bridge.ts';
import { beginSoftSequence } from './sequence.ts';
import { softWorkFacts } from './automatic.ts';
import { reductionPolicyFacts } from './summary-policy.ts';
import { withInstructionRun } from './instruction-lease.ts';
import { buildContextRequest } from '../request-input.ts';
import { assertCurrentRepresentable } from '../current-representability.ts';
import { sameRequestCandidate } from '../request-snapshot.ts';
import { generationRequestLease } from '../generation-request-lease.ts';
import { savingFailure } from '../saving-failure.ts';
const unchanged = (): ReductionResult => ({ compacted: false, shadowedSeqs: [], outcome: 'unchanged', publication: 'none' });
/** The same transaction driver and captured publication authority, with an
 * original same-index preview in place of the public Session candidate. */
export function createManagedReduction(host: ManagedAgentHost, context: ReturnType<typeof createManagedAgentContext>, action: ManagedAction<FactOutcome>, generation: () => ManagedGenerationAction | undefined, register: (drain: () => Promise<void>) => SettlementFacts<FactOutcome>) {
    return async (options: ReductionRunOptions = {}, instructions?: string, scope?: import('@i-harness/llm-seam').LLMRequest['requestScope']) => {
        const config = context.compactConfig;
        if (!config)
            return unchanged();
        return withInstructionRun({ requestContext: host.requestContext, registerFactSource: register }, options.signal, async (retain) => {
            assertManagedActionCurrent(host.domain, action);
            let initial = await context.capture(action);
            retain(initial.instructions);
            const resolved = resolveCompactSpec(config, initial.metadata?.providerId, initial.metadata?.modelId), policy = reductionPolicyFacts(resolved, initial.snapshot.surface, initial.model, context.budgetConfig?.reserveRatio);
            let sequence: Awaited<ReturnType<typeof beginSoftSequence>> | undefined, published = false;
            const selectedPolicy = (snapshot: ContextSnapshot) => { const selected = resolveCompactSpec(config, snapshot.surface.binding?.providerId, snapshot.surface.binding?.modelId), facts = reductionPolicyFacts(selected, snapshot.surface, context.retainedCandidate().model, context.budgetConfig?.reserveRatio); return { model: selected.summarizationModel, key: projectionFingerprint(facts), facts }; };
            const actual = () => { const value = context.retainedCandidate(); retain(value.instructions); return value; };
            const assertCurrent = () => context.current(actual());
            const captureReduction = action.captureContextReduction?.bind(action);
            if (!captureReduction)
                return { ...unchanged(), outcome: 'blocked' as const, blockedReason: 'publication-unavailable' as const };
            if (options.reason === 'auto') {
                const prepared = await prepareModelRequest(initial.model, buildContextRequest(initial.snapshot, { sessionId: host.domain.sessionId, signal: options.signal, requestScope: scope }));
                if (!context.current(initial))
                    throw Object.assign(Error('CONTEXT_INPUT_STALE'), { code: 'CONTEXT_INPUT_STALE' });
                assertCurrentRepresentable(initial, prepared);
                const probe = context.budget.probe(prepared, initial, false, policy.reserveRatio, policy), pressure = probe.decision.pressure, progress = host.execution.observe().softReduction(), work = softWorkFacts(initial.snapshot, policy);
                const cooldown = progress.sinceRewrite, allowed = !progress.state.pending && !progress.state.consumed.has(work.workKey) && (!cooldown || (resolved.cooldown.mode === 'human-turns' ? cooldown.humanTurns : cooldown.acceptedExchanges) >= resolved.cooldown.minimum);
                if (!(host.autoCompactionEnabled?.() ?? resolved.auto) || pressure.kind !== 'known' || !pressure.softNeeded || !allowed)
                    return { ...unchanged(), outcome: pressure.kind === 'known' && pressure.targetReady ? 'ready' as const : 'unchanged' as const };
                const sequenceSource = initial;
                sequence = await beginSoftSequence({ captureSoftReduction: action.captureSoftReduction.bind(action), registerFactSource: register, softTerminalInstalled: () => published }, { type: 'context/soft-reduction', version: 1, op: 'start', ownerSessionId: host.domain.sessionId, sequenceId: randomUUID(), ...work, humanTurns: progress.humanTurns, acceptedExchanges: progress.acceptedExchanges }, () => context.current(sequenceSource));
                const refreshed = await context.capture(action);
                if (!sameRequestCandidate(initial, refreshed)) {
                    await sequence.settle('canceled');
                    throw Object.assign(Error('CONTEXT_INPUT_STALE'), { code: 'CONTEXT_INPUT_STALE' });
                }
                initial = refreshed;
            }
            const ports = createReductionBridge({ signal: options.signal, sessionId: host.domain.sessionId, requestContext: host.requestContext, registerFactSource: register, captureContextReduction: captureReduction, assertFactOpen: () => assertManagedActionCurrent(host.domain, action), async previewReduction(rewrites, previewOptions) {
                    const held = context.retainedCandidate(), candidate = await previewRestoredConversationCandidate(context.archive, rewrites, { ...previewOptions, capturePayload: value => captureContextPayload(value), assertCurrent() {
                            if (!context.current(held))
                                throw Object.assign(Error('CONTEXT_INPUT_STALE'), { code: 'CONTEXT_INPUT_STALE' });
                        } });
                    return { projection: captureContextPayload(candidate.projection), assertCurrent: candidate.assertCurrent.bind(candidate) };
                }, reductionCommitted(capture, outcome) {
                    if (outcome.kind !== 'committed')
                        throw TypeError('Original durable reduction ACK required');
                    const members = readManagedActionMembers(host.domain, action, capture, outcome);
                    if (sequence) {
                        const terminal = members.find(event => event.type === 'context/soft-reduction' && event.op === 'terminal' && event.sequenceId === sequence!.start.sequenceId);
                        if (!terminal)
                            throw TypeError('Original atomic soft terminal required');
                        published = true;
                    }
                } }, actual, context.budget, assertCurrent, policy, options.signal, undefined, !resolved.summarizationModel || resolved.summarizationModel === initial.model, scope, sequence?.start, async () => { await sequence?.settle('canceled'); });
            const capture = ports.capture, current = ports.current, prepare = ports.prepare, policies = new WeakMap<ContextSnapshot, ReturnType<typeof selectedPolicy>>();
            ports.capture = () => { const snapshot = capture(), selected = selectedPolicy(snapshot); policies.set(snapshot, selected); return snapshot; };
            ports.current = (source, groups) => { const selected = policies.get(source), now = selectedPolicy(source); return !!selected && selected.model === now.model && selected.key === now.key && current(source, groups); };
            ports.prepare = async (...args) => { await context.capture(action); return prepare(...args); };
            ports.summary = host.summaryFactory ? selection => {
                const selected = actual(), surface = selected.snapshot.surface, configuration = resolveCompactSpec({ ...config, contextWindow: surface.contextWindow ?? config.contextWindow }, selected.metadata?.providerId, selected.metadata?.modelId), model = mapModelRequest(selected.model, request => ({ ...request, sessionId: request.sessionId ?? host.domain.sessionId })), owner = generation();
                if (!owner)
                    throw TypeError('Original summary generation required');
                assertExecutionGeneration(host.execution, owner);
                const control = generationRequestLease(owner.control('summary', () => {
                    assertExecutionGeneration(host.execution, owner);
                    if (!selection.current())
                        throw Object.assign(Error('CONTEXT_INPUT_STALE'), { code: 'CONTEXT_INPUT_STALE' });
                }), async () => !!await context.refresh(action, selected) && selection.current());
                return host.summaryFactory!({ model, config: configuration.summarizationModel === selected.model ? { ...configuration, summarizationModel: model } : configuration, generation: control, async bindGeneration(prepared) {
                        assertExecutionGeneration(host.execution, owner);
                        await owner.bind(prepared, 'summary');
                        if (!await context.refresh(action, selected))
                            throw Object.assign(Error('CONTEXT_INPUT_STALE'), { code: 'CONTEXT_INPUT_STALE' });
                    }, contextMetadata: selected.metadata, budgetBinding: surface.budgetBinding, maxOutputTokens: surface.maxOutputTokens, reasoningEffort: surface.reasoningEffort, flush: host.flush, telemetry: host.telemetry })(selection);
            } : undefined;
            let result: ReductionResult;
            try {
                result = await reduceContext(ports, policy, options, instructions);
            }
            catch (error) {
                try {
                    await sequence?.settle(options.signal?.aborted ? 'canceled' : isGenerationError(error) ? 'blocked' : 'failed');
                }
                catch (cleanup) {
                    throw savingFailure(error, [cleanup], 'Original soft sequence cleanup failed');
                }
                throw error;
            }
            if (result.publication === 'none')
                await sequence?.settle(result.reason === 'summarizer-failed' ? 'failed' : result.outcome === 'blocked' ? 'blocked' : 'unchanged');
            else if (result.publication !== 'recovery-required')
                await sequence?.close();
            return result;
        });
    };
}
