import { expect, it, vi } from 'vitest';
import type { SettlementFacts } from '@i-harness/core-session';
const probe = vi.hoisted(() => ({ mode: '' as 'not-issued' | 'absent' | 'unknown' | '', holdUnknown: false, key: '', claims: 0, root: undefined as SettlementFacts | undefined, recordRoot: false }));
function originalRoot() { return probe.root; }
vi.mock('../../session-persistence/src/coordinator/settlement-source.ts', async (load) => { const original = await load<typeof import('../../session-persistence/src/coordinator/settlement-source.ts')>(); return { ...original, createSettlementSource(...args: Parameters<typeof original.createSettlementSource>) { const source = original.createSettlementSource(...args); if (probe.recordRoot && !probe.root)
        probe.root = source; return source; } }; });
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async (load) => { const original = await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>(); return { ...original, createFactJournalBackend(...args: Parameters<typeof original.createFactJournalBackend>) { const backend = original.createFactJournalBackend(...args), append = backend.appendOwnedBatch, reconcile = backend.reconcileOwnedBatch; return { ...backend, async appendOwnedBatch(...input: Parameters<typeof append>) { const text = Buffer.from(input[3].bytes).toString('utf8'); if (probe.mode && text.includes('"type":"agent/input/promoted"') && text.includes('steer-original')) {
            probe.claims++;
            if (probe.mode === 'not-issued')
                return { kind: 'not-issued' as const, code: 'FACT_PRECONDITION_STALE' as const };
            if (probe.mode === 'absent') {
                input[1].beforeIssue();
                return { kind: 'absent' as const, key: input[3].key };
            }
            const outcome = await append(...input);
            if (outcome.kind === 'committed') {
                probe.key = input[3].key.batchId;
                return { kind: 'unknown' as const, key: input[3].key };
            }
            return outcome;
        } return append(...input); }, async reconcileOwnedBatch(...input: Parameters<typeof reconcile>) { if (probe.holdUnknown && input[3].key.batchId === probe.key)
            return { kind: 'unknown' as const, key: input[3].key }; return reconcile(...input); } }; } }; });
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, captureExecutionHookChannel } from '@i-harness/core-plugin';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts';
import { receivedExecutionInputsFor } from '../../session-executor/src/lifecycle/execution-inputs.ts';
import { createExecutionInputPreparationOwner } from '../../session-executor/src/lifecycle/execution-input-preparation.ts';
import { createExecutionGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createManagedAgent } from '../src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/model-origin.ts';
import { createLoopbackProvider } from './helpers/provider-loopback.ts';
it.each(['not-issued', 'absent', 'unknown'] as const)('real completed steer preparation keeps original claim/cancellation ownership (%s)', async (mode) => {
    probe.mode = '';
    probe.holdUnknown = false;
    probe.claims = 0;
    probe.key = '';
    probe.root = undefined;
    probe.recordRoot = false;
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'actual-steer-disposition-')), c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await c.create(), execution = await acquireManagedExecution(c, id), inputs = receivedExecutionInputsFor(execution), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution), pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { kind: 'managed-execution', domain: origin.domain, context: ctx, sessionId: id } }, origin.verifier);
    await inputs.inbox.admit({ inputId: 'steer-original', text: 'genuine prepared steer', delivery: 'steer', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } });
    const server = await createLoopbackProvider('/v1/chat/completions', []);
    let transforms = 0, cancellations = 0;
    const agent = createManagedAgent(ctx, { execution, domain: origin.domain, hooks: captureExecutionHookChannel(ctx), modelCallOrigin: origin.bind(pair.registry, pair.driver), tools: pair.registry, model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 'original', budget: { contextWindow: 16000 }, maxOutputTokens: 128, generationFactory: (action, deps) => createExecutionGenerationLifecycle(execution, id, action, undefined, deps), stepInputs: inputs.inbox, inputPreparationFactory(action) { const owner = createExecutionInputPreparationOwner(execution, action, { async transform(text) { transforms++; return text + ' original observation'; }, cancel: id => inputs.inbox.cancel(id) }); return { prepare: (input, generation) => owner.prepare(input.inputId, generation, 'steer'), async cancelUnpromoted(result) { cancellations++; await owner.cancelUnpromoted(result); }, close: owner.close }; } });
    try {
        probe.mode = mode;
        probe.holdUnknown = mode === 'unknown';
        probe.recordRoot = true;
        const result = await agent.run('actual main input').then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        expect(result.ok).toBe(false);
        expect(transforms).toBe(1);
        expect(server.requests).toHaveLength(0);
        expect(probe.claims).toBe(1);
        if (mode === 'unknown') {
            expect(cancellations).toBe(0);
            expect(() => execution.observe()).toThrow();
            probe.holdUnknown = false;
            await probe.root!.close();
            expect(inputs.inbox.isPending('steer-original')).toBe(false);
            expect(cancellations).toBe(0);
            expect(probe.claims).toBe(1);
        }
        else {
            expect(cancellations).toBe(1);
            expect(inputs.inbox.isPending('steer-original')).toBe(false);
        }
    }
    finally {
        probe.mode = '';
        probe.holdUnknown = false;
        probe.recordRoot = false;
        await originalRoot()?.close();
        await c.close();
        await server.close();
    }
}, 30000);
