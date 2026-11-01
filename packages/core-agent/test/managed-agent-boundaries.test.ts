import { expect, it, vi } from 'vitest';
import type { ManagedAction, FactOutcome } from '@i-harness/core-session';
const probe = vi.hoisted(() => ({ afterReserve: undefined as undefined | (() => Promise<void>), unknownType: undefined as string | undefined, acceptedAppends: 0, resultAppends: 0 }));
vi.mock('@i-harness/core-session', async (load) => { const original = await load<typeof import('@i-harness/core-session')>(); return { ...original, createManagedSessionState() { throw Error('Private boundary constructed a complete view'); }, projectConversation() { throw Error('Private boundary replayed conversation'); }, readConversationState() { throw Error('Private boundary replayed state'); } }; });
// Constructor-installed delegating callable: real reserve/issue/settle and its
// exact returned reservation remain the original producer's operations.
vi.mock('../src/agent/generation-request-lease.ts', async (load) => {
    const original = await load<typeof import('../src/agent/generation-request-lease.ts')>();
    return { ...original, generationRequestLease(control: Parameters<typeof original.generationRequestLease>[0], refresh: Parameters<typeof original.generationRequestLease>[1]) {
            let checks = 0;
            return original.generationRequestLease(control, async () => {
                if (++checks % 2 === 0)
                    await probe.afterReserve?.();
                return refresh();
            });
        } };
});
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async (load) => {
    const original = await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();
    return { ...original, createFactJournalBackend(...args: Parameters<typeof original.createFactJournalBackend>) {
            const journal = original.createFactJournalBackend(...args), append = journal.appendOwnedBatch;
            return { ...journal, async appendOwnedBatch(...input: Parameters<typeof append>) {
                    const bytes = Buffer.from(input[3].bytes).toString('utf8');
                    if (bytes.includes('"type":"model/exchange-accepted"'))
                        probe.acceptedAppends++;
                    if (bytes.includes('"type":"tool/result"'))
                        probe.resultAppends++;
                    const outcome = await append(...input);
                    if (probe.unknownType && bytes.includes(`"type":"${probe.unknownType}"`) && outcome.kind === 'committed') {
                        probe.unknownType = undefined;
                        return { kind: 'unknown' as const, key: input[3].key };
                    }
                    return outcome;
                } };
        } };
});
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, captureExecutionHookChannel, onExecutionEvent, waterfallExecutionEvent, onExecutionCascade } from '@i-harness/core-plugin';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts';
import { createExecutionGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createManagedAgent, createManagedSessionExecutor } from '../src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/model-origin.ts';
import { createLoopbackProvider } from './helpers/provider-loopback.ts';
import { committedFactSeqs } from '@i-harness/core-session';
import { captureRestoredContextSnapshot } from '../../context-engine/src/snapshot/build.ts';
import { selectReductionRuns } from '@i-harness/context-engine';
import { pruneProposal } from '../../context-engine/src/reduction/prune.ts';
const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'original-read', function: { name: 'read_probe', arguments: '{}' } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
async function fixture(mode: string) {
    probe.afterReserve = undefined;
    probe.unknownType = undefined;
    probe.acceptedAppends = probe.resultAppends = 0;
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'agent-boundary-')), backend = createJsonlBackend(root), c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await c.create(), execution = await acquireManagedExecution(c, id), ctx = createContext(), origin = createManagedAgentModelOriginOwner(ctx, execution);
    let effects = 0, hooks = 0, action: ManagedAction<FactOutcome> | undefined, reserves = 0, preCallbacks = 0, postCallbacks = 0, forbidden = 0, preStops = 0, agentSteps = 0;
    const order: string[] = [];
    const telemetry: Parameters<import('@i-harness/telemetry').Telemetry['emit']>[0][] = [];
    const scopes: unknown[] = [];
    onExecutionEvent(ctx, 'agent/pre-step', () => {
        hooks++;
        if (mode === 'falsey-hook')
            throw undefined;
    });
    const pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { kind: 'managed-execution', domain: origin.domain, context: ctx, sessionId: id } }, origin.verifier), output = mode === 'prune' || mode === 'unknown-prune' || mode === 'rewrite-drift' ? `HEAD${'B'.repeat(6000)}TAIL` : 'original result';
    pair.registry.register({ name: 'read_probe', description: 'actual body', inputSchema: { type: 'object' }, async execute() {
            effects++;
            order.push('body');
            if (mode === 'late-after-body')
                ctx.on('tools/post-execute', () => { forbidden++; });
            return output;
        } });
    if (mode === 'unmarked-pre')
        ctx.on('tools/pre-execute', () => { forbidden++; });
    if (mode === 'late-pre')
        onExecutionEvent(ctx, 'tools/pre-execute', () => { preCallbacks++; ctx.onCascade('tools/execute', async (_input, next) => { forbidden++; return next(); }); });
    if (mode === 'late-around')
        onExecutionCascade(ctx, 'tools/execute', async (_input, next) => { await Promise.resolve(); ctx.onCascade('tools/execute', async (_later, forward) => { forbidden++; return forward(); }); return next(); });
    if (mode === 'post-throw' || mode === 'falsey-cleanup')
        onExecutionEvent(ctx, 'tools/post-execute', () => { postCallbacks++; throw undefined; });
    if (mode === 'empty-parity')
        waterfallExecutionEvent(ctx, 'agent/pre-stop', async (input, next) => { preStops++; await next(input); return preStops === 1 ? { continuation: { reason: 'must not run after empty' } } : undefined; });
    if (mode === 'scope-parity')
        onExecutionEvent(ctx, 'agent/step', () => { agentSteps++; });
    if (mode === 'owned-order') {
        onExecutionEvent(ctx, 'tools/pre-execute', () => { preCallbacks++; order.push('pre'); });
        waterfallExecutionEvent(ctx, 'tools/pre-execute', async (input, next) => { order.push('waterfall-before'); const value = await next(input); order.push('waterfall-after'); return value; });
        onExecutionCascade(ctx, 'tools/execute', async (_input, next) => { order.push('around-before'); const value = await next(); order.push('around-after'); return value; });
        onExecutionEvent(ctx, 'tools/post-execute', () => { postCallbacks++; order.push('post'); });
    }
    const server = await createLoopbackProvider('/v1/chat/completions', [async (response) => { response.end(mode === 'empty-parity' ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n` : wire(true)); }, async (response) => { response.end(wire(false)); }, async (response) => { response.end(wire(false)); }]);
    let agent: ReturnType<typeof createManagedAgent> | undefined;
    let cleanupFailed = false;
    const actualClient = createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl });
    const model: import('@i-harness/llm-seam').ModelClient = mode === 'scope-parity' ? { executionIdentity: actualClient.executionIdentity, stream: request => actualClient.stream(request), async prepare(request) { scopes.push(request.requestScope); return actualClient.prepare!(request); } } : actualClient;
    const construct = () => createManagedAgent(ctx, { execution, domain: origin.domain, hooks: captureExecutionHookChannel(ctx), modelCallOrigin: origin.bind(pair.registry, pair.driver), tools: pair.registry, model, ...mode === 'empty-parity' || mode === 'scope-parity' ? { telemetry: { emit(event) { telemetry.push(event); }, close() { } } } : {}, systemPrompt: 'original', maxOutputTokens: 128, budget: { contextWindow: 16000 }, ...mode === 'deadline' ? { modelActionTimeoutMs: 1 } : {}, ...mode === 'falsey-cleanup' ? { async flush() {
                await c.flush(id);
                if (effects && !cleanupFailed) {
                    cleanupFailed = true;
                    throw false;
                }
            } } : {}, ...mode === 'prune' || mode === 'unknown-prune' ? { compact: { contextWindow: 16000, auto: false, retainTokens: 0, prune: { thresholdChars: 100, headChars: 16, tailChars: 16 } } } : {}, generationFactory(original, deps) { action = original; return createExecutionGenerationLifecycle(execution, id, original, undefined, deps); } });
    if (mode === 'bookkeeping' || mode === 'input-drift' || mode === 'stop')
        probe.afterReserve = async () => {
            reserves++;
            if (!action)
                throw Error('Original action absent');
            if (mode === 'stop')
                action.stop();
            else if (mode === 'bookkeeping')
                committedFactSeqs(await action.facts.metadata.admit({ type: 'session/title', title: `bookkeeping ${reserves}`, source: 'user', messageSeqs: [] }));
            else
                committedFactSeqs(await action.facts.agent.feedback({ type: 'user/message', text: `actual changed input ${reserves}`, source: { kind: 'plugin', plugin: 'fixture' } }));
        };
    if (mode === 'unknown-acceptance')
        probe.unknownType = 'model/exchange-accepted';
    if (mode === 'unknown-result')
        probe.unknownType = 'tool/result';
    return { get agent() { return agent ??= construct(); }, c, backend, id, execution, server, output, telemetry, scopes, get action() {
            if (!action)
                throw Error('Actual action absent');
            return action;
        }, read: () => ({ effects, hooks, reserves, preCallbacks, postCallbacks, forbidden, preStops, agentSteps, order: [...order] }), async close() {
            probe.afterReserve = undefined;
            probe.unknownType = undefined;
            try {
                await c.close();
            }
            finally {
                await server.close();
            }
        } };
}
it.each(['bookkeeping', 'input-drift', 'stop', 'falsey-hook', 'deadline', 'unknown-acceptance', 'unknown-result'] as const)('actual private Agent preserves original request/cleanup boundary (%s)', async (mode) => {
    const f = await fixture(mode);
    try {
        const result = await f.agent.run('Use the original read tool').then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        const facts = (await f.backend.read(f.id)).events, state = f.read();
        if (mode === 'bookkeeping') {
            expect(result).toMatchObject({ ok: true, value: { finalText: 'done' } });
            expect(f.server.requests).toHaveLength(2);
            expect(state).toMatchObject({ effects: 1, hooks: 2, reserves: 2 });
        }
        else {
            expect(result.ok).toBe(false);
            if (mode === 'falsey-hook') {
                if (result.ok)
                    throw Error('Expected falsey rejection');
                expect(result.error).toBeUndefined();
            }
            expect(f.server.requests).toHaveLength(mode === 'unknown-acceptance' || mode === 'unknown-result' ? 1 : 0);
            expect(state.effects).toBe(mode === 'unknown-result' ? 1 : 0);
            expect(facts.filter(event => event.type === 'context/action' && event.op === 'close' && event.disposition === 'accepted')).toHaveLength(mode === 'unknown-result' ? 1 : 0);
        }
        if (mode === 'input-drift') {
            expect(state.hooks).toBe(1);
            expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1);
            expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'rebind').length).toBeGreaterThan(0);
            expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'settle').every(event => event.type === 'context/attempt' && event.op === 'settle' && event.disposition === 'unsent')).toBe(true);
        }
        if (mode === 'unknown-acceptance' || mode === 'unknown-result') {
            expect(probe.acceptedAppends).toBe(1);
            expect(probe.resultAppends).toBe(1);
            expect(facts.filter(event => event.type === 'tool/call')).toHaveLength(1);
            expect(facts.filter(event => event.type === 'tool/result')).toHaveLength(1);
        }
        expect(facts.filter(event => event.type === 'turn/start')).toHaveLength(mode === 'deadline' ? 0 : 1);
        expect(facts.filter(event => event.type === 'turn/end')).toHaveLength(mode === 'deadline' ? 0 : 1);
    }
    finally {
        await f.close();
    }
}, 30000);
it.each(['unmarked-pre', 'late-pre', 'late-around', 'post-throw', 'late-after-body', 'owned-order'] as const)('original owned tool-hook surface preserves body/result ownership (%s)', async (mode) => {
    const f = await fixture(mode);
    try {
        const result = await Promise.resolve().then(() => f.agent.run('Use the original read tool')).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })), state = f.read(), facts = (await f.backend.read(f.id)).events;
        expect(state.forbidden).toBe(0);
        if (mode === 'owned-order') {
            expect(result).toMatchObject({ ok: true, value: { finalText: 'done' } });
            expect(state.order).toEqual(['pre', 'waterfall-before', 'waterfall-after', 'around-before', 'body', 'around-after', 'post']);
            expect(state.effects).toBe(1);
            expect(f.server.requests).toHaveLength(2);
        }
        else {
            expect(result.ok).toBe(false);
            expect(f.server.requests).toHaveLength(mode === 'unmarked-pre' ? 0 : 1);
            expect(state.effects).toBe(mode === 'post-throw' || mode === 'late-after-body' ? 1 : 0);
            if (mode === 'post-throw') {
                if (result.ok)
                    throw Error('Expected falsey post-hook failure');
                expect(result.error).toBeUndefined();
                expect(state.postCallbacks).toBe(1);
            }
            expect(facts.filter(event => event.type === 'tool/result')).toHaveLength(mode === 'unmarked-pre' ? 0 : 1);
            if (mode === 'late-after-body' || mode === 'post-throw')
                expect(facts.find(event => event.type === 'tool/result')).toMatchObject({ output: f.output });
        }
    }
    finally {
        await f.close();
    }
}, 30000);
it.each(['prune', 'unknown-prune'] as const)('actual private reduction uses same-index preview and original publication (%s)', async (mode) => {
    const f = await fixture(mode);
    try {
        expect((await f.agent.run('Read original once')).finalText).toBe('done');
        expect(f.server.requests).toHaveLength(2);
        if (mode === 'unknown-prune')
            probe.unknownType = 'compaction/prune';
        const result = await f.agent.compact();
        expect(result.publication).toBe(mode === 'prune' ? 'committed' : 'recovery-required');
        const archive = await f.backend.read(f.id);
        expect(archive.events.filter(event => event.type === 'compaction/prune')).toHaveLength(1);
        expect(archive.events.find(event => event.type === 'tool/result')).toMatchObject({ output: f.output });
        expect(f.read().effects).toBe(1);
        if (mode === 'prune') {
            expect(result.compacted).toBe(true);
            expect((await f.agent.run('Continue original context')).finalText).toBe('done');
            expect(f.server.requests).toHaveLength(3);
            expect(JSON.stringify(f.server.requests[2]!.body.messages)).not.toContain(f.output);
        }
    }
    finally {
        await f.close();
    }
}, 30000);
it('the original shared queue runs genuine private inputs FIFO without duplicate admissions or Session/Agent casts', async () => {
    const f = await fixture('lane');
    try {
        const lane = createManagedSessionExecutor({ execution: f.execution, agent: f.agent }), first = lane.submit({ tier: 'send', text: 'First original input' }, 'lane-first'), second = lane.submit({ tier: 'followup', text: 'Second original input' }, 'lane-second');
        await Promise.all([first.admitted, second.admitted]);
        await lane.drain();
        expect(f.server.requests).toHaveLength(3);
        expect(f.read().effects).toBe(1);
        const events = (await f.backend.read(f.id)).events;
        expect(events.filter(event => event.type === 'agent/input/admitted').map(event => event.inputId)).toEqual(['lane-first', 'lane-second']);
        expect(events.filter(event => event.type === 'agent/input/promoted').map(event => event.inputId)).toEqual(['lane-first', 'lane-second']);
        expect(lane.pending()).toEqual([]);
        lane.dispose();
        expect(() => lane.submit({ tier: 'send', text: 'late' })).toThrow('disposed');
    }
    finally {
        await f.close();
    }
}, 30000);
it('private lane rejects a copied Agent and permanent lane retirement before creating new input effects', async () => {
    const f = await fixture('lane-refusal');
    try {
        expect(Object.isFrozen(f.agent)).toBe(true);
        expect(() => createManagedSessionExecutor({ execution: f.execution, agent: { ...f.agent } })).toThrow('Original private Agent');
        const lane = createManagedSessionExecutor({ execution: f.execution, agent: f.agent });
        lane.dispose();
        expect(() => lane.submit({ tier: 'send', text: 'not admitted' })).toThrow('disposed');
        await expect(lane.runAdmitted('missing')).rejects.toThrow('disposed');
        expect((await f.backend.read(f.id)).events).toEqual([]);
        expect(f.server.requests).toHaveLength(0);
    }
    finally {
        await f.close();
    }
});
it('real rewrite drift refuses original reserve/rebind and never physically issues the stale request', async () => {
    const f = await fixture('rewrite-drift');
    try {
        await f.agent.run('Read original once');
        let boundaries = 0;
        probe.afterReserve = async () => {
            if (++boundaries > 1) {
                f.action.stop();
                return;
            }
            const request = await f.execution.prepareRequest(f.action);
            try {
                const captured = captureRestoredContextSnapshot(request.archive, { ownerSessionId: f.id, surface: { systemPrompt: 'original', tools: [] } });
                if (captured.kind !== 'captured')
                    throw Error('Original snapshot unavailable');
                const policy = { retainTokens: 0, prune: { enabled: true, thresholdChars: 100, headChars: 16, tailChars: 16 } }, run = selectReductionRuns(captured.snapshot, policy).find(run => pruneProposal(captured.snapshot, run, policy).length);
                if (!run)
                    throw Error('Original eligible prune absent');
                const drafts = pruneProposal(captured.snapshot, run, policy), capture = f.action.captureContextReduction!({ kind: 'context-reduction', events: drafts }, () => {
                    try {
                        request.assertCurrent();
                        return true;
                    }
                    catch {
                        return false;
                    }
                });
                committedFactSeqs(await capture.admit());
            }
            finally {
                await request.settle();
            }
        };
        const outcome = await f.agent.run('A new original request').then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        expect(outcome.ok).toBe(false);
        expect(f.server.requests).toHaveLength(2);
        expect(boundaries).toBe(2);
        const events = (await f.backend.read(f.id)).events;
        expect(events.filter(event => event.type === 'compaction/prune')).toHaveLength(1);
        expect(f.read().effects).toBe(1);
        const lastOpen = events.findLast(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'main');
        if (lastOpen?.type !== 'context/action' || lastOpen.op !== 'open')
            throw Error('Actual generation missing');
        const attempts = events.filter(event => event.type === 'context/attempt' && event.actionId === lastOpen.actionId);
        expect(attempts.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1);
        expect(attempts.filter(event => event.type === 'context/attempt' && event.op === 'rebind')).toHaveLength(1);
        expect(attempts.filter(event => event.type === 'context/attempt' && event.op === 'settle').every(event => event.type === 'context/attempt' && event.op === 'settle' && event.disposition === 'unsent')).toBe(true);
    }
    finally {
        await f.close();
    }
}, 30000);
it('falsey post-hook primary and original cleanup failure remain ordered while result and cleanup settle independently', async () => {
    const f = await fixture('falsey-cleanup');
    try {
        const error = await f.agent.run('Original body then observer failure').then(() => { throw Error('Unexpected success'); }, error => error);
        expect(error).toBeInstanceOf(AggregateError);
        expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toBeUndefined();
        const values: unknown[] = [];
        const visit = (value: unknown) => {
            if (value instanceof AggregateError)
                for (const nested of value.errors)
                    visit(nested);
            else
                values.push(value);
        };
        visit(error);
        expect(values[0]).toBeUndefined();
        expect(values).toContain(false);
        expect(f.read()).toMatchObject({ effects: 1, postCallbacks: 1 });
        expect((await f.backend.read(f.id)).events.filter(event => event.type === 'tool/result')).toHaveLength(1);
        expect(f.server.requests).toHaveLength(1);
    }
    finally {
        await f.close();
    }
}, 30000);
it('empty actual completion keeps original empty ending and suppresses pre-stop continuation', async () => {
    const f = await fixture('empty-parity');
    try {
        const result = await f.agent.run('Original empty ending');
        expect(result.finalText).toBe('');
        expect(f.server.requests).toHaveLength(1);
        expect(f.read().preStops).toBe(0);
        const events = (await f.backend.read(f.id)).events;
        expect(events.filter(event => event.type === 'step/end')).toEqual([expect.objectContaining({ empty: true })]);
        expect(f.telemetry.filter(event => event.type === 'provider/empty')).toHaveLength(1);
    }
    finally {
        await f.close();
    }
}, 30000);
it('one original request scope spans a real tool continuation and original finish telemetry', async () => {
    const f = await fixture('scope-parity');
    try {
        await f.agent.run('Original scoped continuation');
        expect(f.scopes.length).toBeGreaterThanOrEqual(2);
        expect(f.scopes.every(scope => scope === f.scopes[0])).toBe(true);
        expect(f.read().agentSteps).toBe(0);
        expect(f.telemetry.filter(event => event.type === 'turn/end')).toHaveLength(1);
        expect(f.telemetry.filter(event => event.type === 'token/usage')).toHaveLength(1);
    }
    finally {
        await f.close();
    }
}, 30000);
