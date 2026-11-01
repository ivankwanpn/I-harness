import { expect, it, vi } from 'vitest';
vi.mock('@i-harness/core-session', async (load) => { const original = await load<typeof import('@i-harness/core-session')>(); return { ...original, createManagedSessionState() { throw Error('Instruction Agent built full view'); }, projectConversation() { throw Error('Instruction Agent replayed conversation'); }, readConversationState() { throw Error('Instruction Agent replayed state'); } }; });
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, captureExecutionHookChannel } from '@i-harness/core-plugin';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { committedFactSeqs } from '@i-harness/core-session';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts';
import { createExecutionGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createRuntimeContextSource } from '../../session-executor/src/lifecycle/action-facts.ts';
import { createMainInstructionManager, isOriginalAcceptedInstructionOrigin } from '../../session-executor/src/context/instructions/manager.ts';
import { createProjectInstructionEnvironment } from '../../session-executor/src/context/instructions/host.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createManagedAgent, type RequestContextPin } from '../src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/model-origin.ts';
import { createLoopbackProvider } from './helpers/provider-loopback.ts';
const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'actual-instructed', function: { name: 'read_probe', arguments: '{}' } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
it.each([false, true])('genuine instructed batch owns exact handoff pin through drain and release retry (%s)', async (failRelease) => {
    const cwd = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'agent-real-instructions-'));
    await writeFile(join(cwd, 'AGENTS.md'), 'Genuine original project instruction for this controlled read.');
    const backend = createJsonlBackend(join(cwd, 'sessions')), c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await c.create(), execution = await acquireManagedExecution(c, id), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution), environment = createProjectInstructionEnvironment(), runtime = createRuntimeContextSource(execution.owner);
    let effects = 0, faultEnabled = failRelease;
    const manager = createMainInstructionManager({ domain: origin.domain, environment, cwd, authority: () => ({ kind: 'unbound', revision: 'actual', workspaceRoot: cwd }), available: () => true, async publish(signal, retain) { const pin = retain(), source = runtime(signal); try {
            committedFactSeqs(await source.captureRuntimeContext({ type: 'runtime/context', version: 1, sections: [{ name: 'instructions', text: manager.text() }] }, () => { origin.domain.assertCurrent(); return true; }).admit());
        }
        finally {
            source.finish();
            await pin.release();
        } } });
    const server = await createLoopbackProvider('/v1/chat/completions', [async (response) => { response.end(wire(true)); }, async (response) => { response.end(wire(false)); }]);
    const retained: {
        pin: RequestContextPin;
        handoff: boolean;
        attempts: number;
        underlying: number;
        released: boolean;
    }[] = [];
    const originalRetain = manager.retain.bind(manager);
    // Delegate the actual manager's cleanup-only pin before Agent construction;
    // all source/evidence/adoption/body permissions remain the original producer.
    manager.retain = evidence => { const pin = originalRetain(evidence), release = pin.release.bind(pin), record = { pin, handoff: server.requests.length === 1 && effects === 0, attempts: 0, underlying: 0, released: false }; retained.push(record); pin.release = async () => { record.attempts++; if (record.handoff && faultEnabled) {
        faultEnabled = false;
        throw false;
    } await release(); record.underlying++; record.released = true; }; return pin; };
    const pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { kind: 'managed-execution', domain: origin.domain, context: ctx, sessionId: id }, instructionsRequired: true, instructionOriginVerifier: isOriginalAcceptedInstructionOrigin }, origin.verifier);
    pair.registry.register({ name: 'read_probe', description: 'actual instructed read', inputSchema: { type: 'object' }, captureNativePlan() { return { operation: 'read', targets: [] }; }, async execute() { effects++; return 'original instructed body result'; } });
    const agent = createManagedAgent(ctx, { execution, domain: origin.domain, hooks: captureExecutionHookChannel(ctx), modelCallOrigin: origin.bind(pair.registry, pair.driver), requestContext: manager, tools: pair.registry, model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: () => manager.text(), budget: { contextWindow: 16000 }, maxOutputTokens: 128, generationFactory: (action, deps) => createExecutionGenerationLifecycle(execution, id, action, undefined, deps) });
    try {
        const result = await agent.run('Use the genuine instructed read').then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        expect(effects).toBe(1);
        const handoffs = retained.filter(pin => pin.handoff);
        expect(handoffs).toHaveLength(1);
        expect(handoffs[0]!.released).toBe(true);
        expect(handoffs[0]!.attempts).toBe(failRelease ? 2 : 1);
        expect(handoffs[0]!.underlying).toBe(1);
        expect(result.ok).toBe(!failRelease);
        expect(server.requests).toHaveLength(failRelease ? 1 : 2);
        expect((await backend.read(id)).events.filter(event => event.type === 'tool/result')).toHaveLength(1);
        await manager.close();
    }
    finally {
        faultEnabled = false;
        for (const pin of retained)
            if (!pin.released)
                await pin.pin.release();
        await manager.close();
        await environment.close();
        await c.close();
        await server.close();
    }
}, 30000);
