import { expect, it, vi } from 'vitest';
vi.mock('@i-harness/core-session', async (load) => { const original = await load<typeof import('@i-harness/core-session')>(); return { ...original, createManagedSessionState() { throw Error('Private Agent built a full managed view'); }, projectConversation() { throw Error('Private Agent replayed public conversation'); }, readConversationState() { throw Error('Private Agent replayed public state'); } }; });
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
import { createLoopbackProvider } from './helpers/provider-loopback.ts';
import { createManagedAgent } from '../src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/model-origin.ts';
const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'original-read', function: { name: 'read_probe', arguments: '{}' } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
it('actual private Agent prepares original generation, accepted calls, tool body and continuation without a Session fallback', async () => {
    const create = createManagedAgent, originFactory = createManagedAgentModelOriginOwner;
    expect(create).toBeTypeOf('function');
    expect(originFactory).toBeTypeOf('function');
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'private-agent-')), c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract);
    await c.create({ sessionId: 'main' });
    const execution = await acquireManagedExecution(c, 'main'), ctx = createContext(), origin = originFactory(ctx, execution);
    let effects = 0, hooks = 0;
    onExecutionEvent(ctx, 'agent/pre-step', () => { hooks++; });
    const pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { kind: 'managed-execution', domain: origin.domain, context: ctx, sessionId: 'main' } }, origin.verifier);
    pair.registry.register({ name: 'read_probe', description: 'original actual body', inputSchema: { type: 'object' }, async execute(_args, exec) { expect(exec.session).toBeUndefined(); effects++; return 'observed original result'; } });
    const server = await createLoopbackProvider('/v1/chat/completions', [async (response) => { response.end(wire(true)); }, async (response, request) => { expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool' })])); response.end(wire(false)); }]);
    try {
        const agent = create(ctx, { execution, domain: origin.domain, hooks: captureExecutionHookChannel(ctx), modelCallOrigin: origin.bind(pair.registry, pair.driver), tools: pair.registry, model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 'original system', budget: { contextWindow: 4096 }, maxOutputTokens: 128, generationFactory: (action, dependencies) => createExecutionGenerationLifecycle(execution, 'main', action, undefined, dependencies) });
        const result = await agent.run('use the real read tool then report');
        expect(result.finalText).toBe('done');
        expect(server.requests).toHaveLength(2);
        expect(effects).toBe(1);
        expect(hooks).toBe(2);
        expect(Object.hasOwn(execution.owner, 'view')).toBe(false);
    }
    finally {
        await c.close();
        await server.close();
    }
}, 30000);
