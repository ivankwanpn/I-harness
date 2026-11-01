import { expect, it, vi } from 'vitest';
vi.mock('@i-harness/core-session', async (load) => { const original = await load<typeof import('@i-harness/core-session')>(); return { ...original, createManagedSessionState() { throw Error('Request built a complete Session'); }, projectConversation() { throw Error('Request replayed public conversation'); }, readConversationState() { throw Error('Request replayed public state'); } }; });
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, captureExecutionHookChannel, onExecutionEvent } from '@i-harness/core-plugin';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts';
import { createExecutionGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/managed-model-origin.ts';
import { createManagedAgentContext } from '../src/agent/managed-context.ts';
import type { ManagedAgentHost } from '../src/agent/managed-types.ts';
import { committedFactSeqs } from '@i-harness/core-session';
it('private request leases refresh original bookkeeping and refuse changed input, surface, listeners and Stop', async () => {
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'private-request-')), c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await c.create(), execution = await acquireManagedExecution(c, id), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution), pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { kind: 'managed-execution', domain: origin.domain, context: ctx, sessionId: id } }, origin.verifier);
    const host: ManagedAgentHost = { execution, domain: origin.domain, hooks: captureExecutionHookChannel(ctx), modelCallOrigin: origin.bind(pair.registry, pair.driver), tools: pair.registry, model: createOpenAICompatibleClient({ apiKey: 'unused', model: 'local-no-network', baseUrl: 'http://127.0.0.1:1' }), systemPrompt: 'original', budget: { contextWindow: 4096 }, generationFactory: (action, deps) => createExecutionGenerationLifecycle(execution, id, action, undefined, deps) };
    const action = execution.owner.beginAction(), source = action.registerSettlementSource(async () => { }), context = createManagedAgentContext(host);
    context.bindAction(action.facts, source);
    try {
        committedFactSeqs(await action.captureLifecycle!({ type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' }).admit());
        committedFactSeqs(await action.captureInputPromotion({ kind: 'input-start', turn: { type: 'turn/start' }, message: { type: 'user/message', text: 'actual input' } }, () => true).admit());
        const first = await context.capture(action);
        expect(context.current(first)).toBe(true);
        expect(first.snapshot.conversation.items).not.toHaveLength(0);
        committedFactSeqs(await action.captureMetadata!({ type: 'session/title', title: 'bookkeeping', source: 'user', messageSeqs: [] }).admit());
        expect(context.current(first)).toBe(false);
        const refreshed = await context.refresh(action, first);
        expect(refreshed).toBeDefined();
        expect(context.current(refreshed!)).toBe(true);
        host.systemPrompt = 'changed';
        expect(context.current(refreshed!)).toBe(false);
        host.systemPrompt = 'original';
        expect(context.current(refreshed!)).toBe(true);
        onExecutionEvent(ctx, 'agent/pre-step', () => { });
        expect(context.current(refreshed!)).toBe(false);
        const next = await context.capture(action);
        expect(context.current(next)).toBe(true);
        committedFactSeqs(await action.facts.agent.feedback({ type: 'user/message', text: 'new context', source: { kind: 'plugin', plugin: 'test' } }));
        expect(await context.refresh(action, next)).toBeUndefined();
        action.stop();
        await expect(context.capture(action)).rejects.toThrow();
        expect(context.current(next)).toBe(false);
    }
    finally {
        await context.close();
        await source.close();
        action.finish();
        await c.close();
    }
}, 30000);
