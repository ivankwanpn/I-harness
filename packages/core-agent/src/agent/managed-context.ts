import { getManagedExecutionAdmissionWait } from '@i-harness/core-session/internal/execution';
import { captureRestoredContextSnapshot, readRestoredContextCoordinates } from '../../../context-engine/src/snapshot/build.ts';
import { projectionFingerprint } from '@i-harness/token-meter';
import { renderConversation, type ContextBindingMetadata, type ExchangeAcceptedEventV2, type ManagedAction, type FactOutcome, type FactPorts, type ProducerFactOutcome, type SettlementFacts } from '@i-harness/core-session';
import { snapshotModelData } from '@i-harness/llm-seam';
import { resolveCompactSpec } from '@i-harness/compaction';
import type { ManagedAgentHost } from './managed-types.ts';
import { createExecutionOwner } from './execution.ts';
import { createOwnedBudget, type OwnedBudgetHistory } from './budget.ts';
import { sameRequestCandidate, type RequestEvidence } from './request-snapshot.ts';
import type { PreparedExecutionRequest } from '@i-harness/core-session/internal/execution';
import { validateBudget } from './context.ts';
/** Request payloads come from the same original index/lease; no complete-view
 * surface is created or substituted for a synchronous freshness check. */
export function createManagedAgentContext(host: ManagedAgentHost) {
    const execution = createExecutionOwner(), leases = new Set<PreparedExecutionRequest>(), accepted = new WeakSet<object>();
    const capturedEvidence = new WeakSet<object>();
    let active: {
        lease: PreparedExecutionRequest;
        evidence: RequestEvidence;
        hooks: object;
    } | undefined;
    let facts: FactPorts<ProducerFactOutcome> | undefined, source: SettlementFacts<ProducerFactOutcome> | undefined;
    let config = { budget: host.budget, compact: host.compact, maxOutputTokens: host.maxOutputTokens }, metadataOverride: ContextBindingMetadata | undefined, hasMetadataOverride = false;
    let budgetOverride: import('@i-harness/llm-seam').ModelBudgetBinding | undefined, hasBudgetOverride = false;
    const binding = () => host.bindingForStep?.();
    const metadata = () => binding()?.contextMetadata ?? (hasMetadataOverride ? metadataOverride : typeof host.contextMetadata === 'function' ? host.contextMetadata() : host.contextMetadata);
    const surface = () => { const inherited = binding(), bindingMetadata = metadata(); return { systemPrompt: typeof host.systemPrompt === 'function' ? host.systemPrompt() : host.systemPrompt, tools: host.modelToolSchemas?.() ?? host.tools.schemas(), reasoningEffort: inherited ? inherited.reasoningEffort : host.reasoningEffort, maxOutputTokens: inherited ? inherited.maxOutputTokens : config.maxOutputTokens, contextWindow: inherited ? inherited.contextWindow : bindingMetadata?.contextWindow ?? config.budget?.contextWindow ?? config.compact?.contextWindow, binding: bindingMetadata, budgetBinding: inherited ? inherited.budgetBinding : hasBudgetOverride ? budgetOverride : typeof host.budgetBinding === 'function' ? host.budgetBinding() : host.budgetBinding }; };
    const selected = () => ({ model: host.model, bindingIdentity: host.modelBindingIdentity?.(), executionIdentity: binding()?.executionIdentity ?? host.executionIdentity?.() ?? host.model.executionIdentity });
    const current = (evidence: RequestEvidence) => {
        try {
            if (!active || active.evidence !== evidence)
                return false;
            host.domain.assertCurrent();
            active.lease.assertCurrent();
            host.hooks.assertCurrent(active.hooks);
            const now = selected();
            if (projectionFingerprint(surface()) !== projectionFingerprint(evidence.snapshot.surface) || now.model !== evidence.model || now.bindingIdentity !== evidence.bindingIdentity)
                return false;
            if (host.requestContext && !host.requestContext.current(evidence.instructions))
                return false;
            active.lease.assertCurrent();
            host.hooks.assertCurrent(active.hooks);
            host.domain.assertCurrent();
            return true;
        }
        catch {
            return false;
        }
    };
    const history: OwnedBudgetHistory = { kind: 'managed-budget-history', assessmentRevision: () => String(host.execution.observe().contextRevision), recovery: binding => { const value = host.execution.observe().recovery(binding); return value ? { ...value } : undefined; }, coordinates: () => {
            if (!active)
                throw TypeError('Original request preparation unavailable');
            return readRestoredContextCoordinates(active.lease.archive, { ownerSessionId: host.domain.sessionId });
        }, ownsAccepted: event => accepted.has(event) };
    const budget = createOwnedBudget(undefined, host.domain.sessionId, () => {
        if (!active || !current(active.evidence))
            throw TypeError('Original request preparation expired');
        return active.evidence;
    }, execution.observationLifetimeId, execution.peekExpected, () => {
        if (!facts)
            throw TypeError('Original action facts unavailable');
        return facts;
    }, () => source, history);
    const validate = () => {
        validateBudget(config.budget);
        if (config.maxOutputTokens !== undefined && (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1))
            throw RangeError('Invalid output cap');
        if (config.compact)
            resolveCompactSpec(config.compact, metadata()?.providerId, metadata()?.modelId);
    };
    validate();
    return {
        execution, budget, metadata, current,
        retainedCandidate() {
            if (!active)
                throw TypeError('Original context preparation unavailable');
            return active.evidence;
        },
        bindAction(originalFacts: FactPorts<FactOutcome>, originalSource: SettlementFacts<FactOutcome>) { facts = originalFacts; source = originalSource; },
        acknowledge(event: ExchangeAcceptedEventV2) { accepted.add(event); },
        async capture(action: ManagedAction<FactOutcome>, signal: AbortSignal = action.signal) {
            for (;;) {
                signal.throwIfAborted();
                const wait = getManagedExecutionAdmissionWait(host.domain, action, signal);
                if (!wait) break;
                await wait;
            }
            host.domain.assertCurrent();
            const hooks = host.hooks.capture(), lease = await host.execution.prepareRequest(action);
            leases.add(lease);
            try {
                lease.assertCurrent();
                host.hooks.assertCurrent(hooks);
                const result = captureRestoredContextSnapshot(lease.archive, { ownerSessionId: host.domain.sessionId, surface: surface() });
                if (result.kind !== 'captured')
                    throw Object.assign(Error(`${result.code}: ${result.component}`), { code: result.code });
                const evidence: RequestEvidence = { snapshot: result.snapshot, ...selected(), projectionRevision: lease.observation.projectionRevision, neutralFingerprint: projectionFingerprint(renderConversation(result.snapshot.conversation)), metadata: result.snapshot.surface.binding, instructions: host.requestContext?.capture() };
                lease.assertCurrent();
                host.hooks.assertCurrent(hooks);
                const prior = active;
                active = { lease, evidence, hooks };
                capturedEvidence.add(evidence);
                if (prior) {
                    await prior.lease.settle();
                    leases.delete(prior.lease);
                }
                if (!current(evidence))
                    throw Object.assign(Error('CONTEXT_INPUT_STALE'), { code: 'CONTEXT_INPUT_STALE' });
                return evidence;
            }
            catch (primary) {
                try {
                    await lease.settle();
                    leases.delete(lease);
                }
                catch (cleanup) {
                    throw new AggregateError([primary, cleanup], 'Original request preparation cleanup failed');
                }
                throw primary;
            }
        },
        async refresh(action: ManagedAction<FactOutcome>, expected: RequestEvidence, signal: AbortSignal = action.signal) {
            if (!capturedEvidence.has(expected))
                throw TypeError('Original request evidence required');
            if (host.requestContext && !host.requestContext.current(expected.instructions))
                return undefined;
            const next = await this.capture(action, signal);
            if (!sameRequestCandidate(expected, next) || expected.neutralFingerprint !== next.neutralFingerprint || host.requestContext && !host.requestContext.current(expected.instructions))
                return undefined;
            const retained = { ...next, instructions: expected.instructions };
            capturedEvidence.add(retained);
            active!.evidence = retained;
            return current(retained) ? retained : undefined;
        },
        readBudget(): import('@i-harness/core-session').BudgetRead {
            try {
                return budget.read();
            }
            catch {
                return { kind: 'unavailable', reason: 'Original context observation is unavailable' };
            }
        },
        get budgetConfig() { return config.budget; }, get compactConfig() { return config.compact; }, get outputCap() { return surface().maxOutputTokens; },
        get pressurePolicy() { return config.compact ? resolveCompactSpec(config.compact, metadata()?.providerId, metadata()?.modelId) : undefined; },
        get archive() {
            if (!active || !current(active.evidence))
                throw TypeError('Original request lease expired');
            return active.lease.archive;
        },
        update(next: Parameters<NonNullable<import('./types.ts').Agent['updateContext']>>[0]) {
            const previous = config;
            config = { budget: next.budget, compact: next.compact, maxOutputTokens: next.maxOutputTokens };
            try {
                validate();
            }
            catch (error) {
                config = previous;
                throw error;
            }
            if ('contextMetadata' in next) {
                metadataOverride = snapshotModelData(next.contextMetadata);
                hasMetadataOverride = true;
            }
            if ('budgetBinding' in next) {
                budgetOverride = snapshotModelData(next.budgetBinding);
                hasBudgetOverride = true;
            }
            budget.invalidate(false);
        },
        async close() {
            const errors: unknown[] = [];
            for (const lease of leases)
                try {
                    await lease.settle();
                    leases.delete(lease);
                }
                catch (error) {
                    errors.push(error);
                }
            if (errors.length)
                throw new AggregateError(errors, 'Original request leases require cleanup');
            active = undefined;
            facts = undefined;
            source = undefined;
        },
    };
}
