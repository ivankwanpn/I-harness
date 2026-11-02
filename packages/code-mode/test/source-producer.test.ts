import { expect, it, vi } from 'vitest';
const worker = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:worker_threads', async (load) => {
    const real = await load<typeof import('node:worker_threads')>();
    return { ...real, Worker: class extends real.Worker {
            constructor(...args: ConstructorParameters<typeof real.Worker>) { worker.calls++; super(...args); }
        } };
});
const journal = vi.hoisted(() => ({ hold: false, holdGeneration: false, entered: undefined as (() => void) | undefined, gate: undefined as Promise<void> | undefined, sources: 0, captures: 0, starts: 0, startedKey: undefined as import('@i-harness/core-session').BatchKey | undefined, mode: 'none' as 'none' | 'unknown' | 'refused' | 'temporary' | 'started-unknown', holdUnknown: false, key: '', failedAdmission: undefined as (() => void) | undefined }));
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async (load) => {
    const real = await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();
    return { ...real, createFactJournalBackend(...args: Parameters<typeof real.createFactJournalBackend>) {
            const original = real.createFactJournalBackend(...args), append = original.appendOwnedBatch, reconcile = original.reconcileOwnedBatch;
            return { ...original, async appendOwnedBatch(...input: Parameters<typeof append>) {
                    const source = Buffer.from(input[3].bytes).toString('utf8').includes('"sourceNamespace":"code"');
                    if (source) {
                        journal.sources++;
                        if (journal.mode === 'temporary')
                            return { kind: 'not-issued' as const, code: 'FACT_RECOVERY_REQUIRED' as const };
                        if (journal.mode === 'refused')
                            return { kind: 'not-issued' as const, code: 'FACT_PRECONDITION_STALE' as const };
                    }
                    const result = await append(...input);
                    if (journal.mode === 'started-unknown' && Buffer.from(input[3].bytes).toString('utf8').includes('"type":"code/cell"') && Buffer.from(input[3].bytes).toString('utf8').includes('"state":"started"') && result.kind === 'committed') {
                        journal.starts++;
                        journal.startedKey = input[3].key;
                        journal.key = input[3].key.batchId;
                        return { kind: 'unknown' as const, key: input[3].key };
                    }
                    if (journal.holdGeneration && Buffer.from(input[3].bytes).toString('utf8').includes('"type":"agent/delivery-generation"')) {
                        journal.entered?.();
                        await journal.gate;
                    }
                    if (source) {
                        if (journal.hold) {
                            journal.entered?.();
                            await journal.gate;
                        }
                        if (journal.mode === 'unknown' && result.kind === 'committed') {
                            journal.key = input[3].key.batchId;
                            return { kind: 'unknown' as const, key: input[3].key };
                        }
                    }
                    return result;
                }, async reconcileOwnedBatch(...input: Parameters<typeof reconcile>) {
                    if (journal.holdUnknown && input[3].key.batchId === journal.key)
                        return { kind: 'unknown' as const, key: input[3].key };
                    return reconcile(...input);
                } };
        } };
});
vi.mock('../../session-persistence/src/coordinator/action-captures.ts', async (load) => { const original = await load<typeof import('../../session-persistence/src/coordinator/action-captures.ts')>(); return { ...original, createActionCaptures(...args: Parameters<typeof original.createActionCaptures>) { const captures = original.createActionCaptures(...args), capture = captures.captureCodeDeliverySource; return { ...captures, captureCodeDeliverySource(...input: Parameters<typeof capture>) { journal.captures++; return Reflect.apply(capture, captures, input); } }; } }; });
vi.mock('../src/event-facts.ts', async (load) => {
    const original = await load<typeof import('../src/event-facts.ts')>();
    return { ...original, createCodeModeEventFacts(...args: Parameters<typeof original.createCodeModeEventFacts>) {
            const facts = original.createCodeModeEventFacts(...args);
            return { ...facts, required(...input: Parameters<typeof facts.required>) {
                    if (input[0].type === 'code/cell' && input[0].state === 'interrupted')
                        journal.failedAdmission?.();
                    return facts.required(...input);
                } };
        } };
});
const invocation = vi.hoisted(() => ({ tested: false, getters: 0, claims: [] as {
        assertCurrent(): void;
    }[], foreign: undefined as object | undefined }));
vi.mock('../../core-tools/src/code-origin.ts', async (load) => {
    const original = await load<typeof import('../../core-tools/src/code-origin.ts')>();
    return { ...original, claimPreparedCodeInvocation(...args: Parameters<typeof original.claimPreparedCodeInvocation>) {
            const [registration, exec, owner] = args;
            if (exec.callEventSeq !== undefined && !invocation.tested) {
                invocation.tested = true;
                expect(() => original.claimPreparedCodeInvocation({ ...registration }, exec, owner)).toThrow();
                expect(() => original.claimPreparedCodeInvocation(invocation.foreign as typeof registration, exec, owner)).toThrow();
                for (const replacement of [{ ...owner, context: { ...owner.context } }, { ...owner, view: { ...owner.view } }, { ...owner, factOwner: { ...owner.factOwner } }, { ...owner, sessionId: 'foreign' }])
                    expect(() => original.claimPreparedCodeInvocation(registration, exec, replacement)).toThrow();
                const copy = Object.defineProperty({ ...exec }, 'session', { get() { invocation.getters++; throw Error('No getter'); } });
                expect(() => original.claimPreparedCodeInvocation(registration, copy, owner)).toThrow();
                expect(() => original.claimPreparedCodeInvocation(registration, new Proxy(exec, { get() { invocation.getters++; throw Error('No proxy trap'); } }), owner)).toThrow();
            }
            const claim = original.claimPreparedCodeInvocation(...args);
            if (claim) {
                expect(() => claim.consume.call({ ...claim })).toThrow();
                expect(() => claim.takeCodeSourceIssuer()).toThrow();
                invocation.claims.push(claim);
            }
            return claim;
        } };
});
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext } from '@i-harness/core-plugin';
import { createToolRegistry } from '@i-harness/core-tools';
import { captureCodeRegistration } from '../../core-tools/src/code-origin.ts';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { createAgent } from '../../core-agent/src/index.ts';
import { createAgentModelOriginOwner } from '../../core-agent/src/tool-batch/model-origin.ts';
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts';
import { createContextOutputService } from '../../context-output/src/index.ts';
import { createCodeTextRetention } from '../../session-executor/src/lifecycle/code-text-retention.ts';
import { createCodeFinalOutputRetention } from '../../session-executor/src/lifecycle/code-final-output-retention.ts';
import { captureOriginalCodeCompletion } from '../src/register.ts';
import { observeOriginalCodeFinalOutputs } from '../src/final-output.ts';
import { registerCodeMode } from '../src/register.ts';
import { createCodeModeEventFacts } from '../src/event-facts.ts';
const wire = (tool: boolean, code = 'text("actual original output")', yieldMs = 60000) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'genuine-code', function: { name: 'code_exec', arguments: JSON.stringify({ code, yield_time_ms: yieldMs }) } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
async function fixture(code = 'text("actual original output")', yieldMs = 60000) {
    invocation.tested = false;
    invocation.getters = 0;
    invocation.claims = [];
    const foreignRegistry = createToolRegistry(createContext()), foreignTool = { name: 'code_exec', description: 'registration snapshot only', inputSchema: {}, async execute() { return 'not Code'; } };
    foreignRegistry.register(foreignTool);
    invocation.foreign = captureCodeRegistration(foreignRegistry, foreignTool, foreignTool.execute);
    journal.captures = 0;
    journal.starts = 0;
    journal.startedKey = undefined;
    journal.mode = 'none';
    journal.holdUnknown = false;
    journal.key = '';
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'code-source-real-'));
    await mkdir(join(root, 'sessions'));
    const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext();
    const origin = createAgentModelOriginOwner({ view: document.view, factOwner: document }), pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: id } }, origin.verifier);
    const output = createContextOutputService({ root: join(root, 'output'), workspaceId: 'source-proof' });
    const mount = registerCodeMode(ctx, pair.registry, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' }, retainText: createCodeTextRetention({ service: output, sessionId: id, sourceFor: async () => ({ sourceId: 'actual-native-source' }) }), finalOutput: createCodeFinalOutputRetention({ service: output, sourceFor: async () => ({ sourceId: 'actual-native-source' }) }) });
    const server = await createLoopbackProvider('/v1/chat/completions', [async (r) => { r.end(wire(true, code, yieldMs)); }, async (r) => { r.end(wire(false)); }]);
    const agent = createAgent(ctx, { session: document.view, sessionId: id, factOwner: document, tools: pair.registry, modelCallOrigin: origin.bind(pair.registry, pair.driver), model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 'original', generationFactory: (action, deps) => createGenerationLifecycle(document.view, id, action, undefined, deps) });
    return { id, document, server, mount, tools: pair.registry, run: (signal?: AbortSignal) => agent.run('Execute actual Code once', signal, undefined, undefined, { provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }), async close() { journal.hold = false; await mount.dispose(); await coordinator.close(); await output.close(); await server.close(); } };
}
it('genuine Code constructor admits one original source and terminal without foreground handoff', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture();
    try {
        expect((await f.run()).finalText).toBe('done');
        const events = f.document.view.events, sources = events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code'), ends = events.filter(e => e.type === 'code/end');
        expect(sources).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(events.filter(e => e.type === 'agent/delivery-handoff' && e.kind === 'code')).toEqual([]);
        expect(worker.calls).toBe(1);
        expect(journal.sources).toBe(1);
        expect(f.server.requests).toHaveLength(2);
    }
    finally {
        await f.close();
    }
}, 30000);
it('holds the genuine Worker behind the original Code source ACK', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    journal.hold = true;
    journal.entered = entered.resolve;
    journal.gate = release.promise;
    const running = f.run();
    void running.catch(() => { });
    try {
        await Promise.race([entered.promise, running.then(() => { throw Error('Actual original Code source was omitted'); })]);
        expect(worker.calls).toBe(0);
        expect(journal.sources).toBe(1);
        release.resolve();
        await running;
        expect(worker.calls).toBe(1);
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toHaveLength(1);
    }
    finally {
        release.resolve();
        journal.hold = false;
        journal.entered = undefined;
        journal.gate = undefined;
        await running.catch(() => { });
        await f.close();
    }
}, 30000);
it('keeps a lost original source ACK and records committed-no-Worker without a replacement issue', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture(), failed = Promise.withResolvers<void>();
    journal.mode = 'unknown';
    journal.holdUnknown = true;
    journal.failedAdmission = failed.resolve;
    const running = f.run();
    void running.catch(() => { });
    try {
        await Promise.race([failed.promise, running.then(() => { throw Error('Unknown original source was not fenced'); })]);
        expect(worker.calls).toBe(0);
        expect(journal.sources).toBe(1);
        journal.holdUnknown = false;
        await running.catch(() => { });
        await f.mount.dispose().catch(() => { });
        await f.mount.dispose();
        const events = f.document.view.events;
        expect(events.filter(e => e.type === 'code/cell' && e.state === 'interrupted')).toHaveLength(1);
        expect(events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toHaveLength(1);
        expect(events.filter(e => e.type === 'code/end')).toEqual([expect.objectContaining({ execution: { dispatch: 'not-dispatched', outcome: 'unknown' }, reason: 'launch-refused' })]);
        expect(journal.sources).toBe(1);
        expect(worker.calls).toBe(0);
    }
    finally {
        journal.failedAdmission = undefined;
        journal.holdUnknown = false;
        journal.mode = 'none';
        await running.catch(() => { });
        await f.close();
    }
}, 30000);
it('never constructs a Worker for a known unsent original source', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture();
    journal.mode = 'refused';
    try {
        await f.run();
        expect(f.document.view.events.filter(e => e.type === 'tool/result')).toEqual([expect.objectContaining({ isError: true, output: expect.objectContaining({ code: 'TOOL_FAILED' }) })]);
        expect(worker.calls).toBe(0);
        expect(journal.sources).toBe(1);
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toEqual([]);
        expect(f.document.view.events.filter(e => e.type === 'code/end')).toEqual([]);
    }
    finally {
        journal.mode = 'none';
        await f.close();
    }
}, 30000);
it('settles the same committed source after Stop at the held ACK with no Worker', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), stop = new AbortController();
    journal.hold = true;
    journal.entered = entered.resolve;
    journal.gate = release.promise;
    const running = f.run(stop.signal);
    void running.catch(() => { });
    try {
        await Promise.race([entered.promise, running.then(() => { throw Error('Original source was omitted'); })]);
        stop.abort();
        release.resolve();
        await expect(running).rejects.toThrow();
        await f.mount.dispose().catch(() => { });
        await f.mount.dispose();
        expect(worker.calls).toBe(0);
        expect(journal.sources).toBe(1);
        expect(f.document.view.events.filter(e => e.type === 'code/end')).toEqual([expect.objectContaining({ execution: { dispatch: 'not-dispatched', outcome: 'unknown' }, reason: 'launch-refused' })]);
        expect(f.server.requests).toHaveLength(1);
    }
    finally {
        release.resolve();
        journal.hold = false;
        journal.entered = undefined;
        journal.gate = undefined;
        await running.catch(() => { });
        await f.close();
    }
}, 30000);
it('an original yielded cell hands off once and settles after its body frame and owner admission retire', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture('await tools.pause({});text("after yield")', 0), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.tools.register({ name: 'pause', description: 'hold the original nested body', inputSchema: { type: 'object' }, async execute() { entered.resolve(); await release.promise; return 'released'; } });
    try {
        const running = f.run();
        void running.catch(() => { });
        await entered.promise;
        expect((await running).finalText).toBe('done');
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-handoff' && e.kind === 'code')).toHaveLength(1);
        expect(f.document.view.events.filter(e => e.type === 'code/end')).toEqual([]);
        f.document.revokeNewWork();
        release.resolve();
        await f.mount.dispose();
        expect(journal.sources).toBe(1);
        expect(worker.calls).toBe(1);
        expect(f.document.view.events.filter(e => e.type === 'code/end')).toHaveLength(1);
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-handoff' && e.kind === 'code')).toHaveLength(1);
        expect(f.server.requests).toHaveLength(2);
    }
    finally {
        release.resolve();
        await f.close();
    }
}, 30000);
it('unregister and re-register of the same Code tool cannot revive the original constructor witness', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture(), tool = f.tools.get('code_exec')!;
    f.tools.unregister('code_exec');
    f.tools.register(tool);
    try {
        await f.run().catch(() => { });
        expect(worker.calls).toBe(0);
        expect(journal.sources).toBe(0);
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toEqual([]);
    }
    finally {
        await f.close();
    }
}, 30000);
it('manual use of the actual Code mount retains its old nonproducer route', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture();
    try {
        await f.tools.get('code_exec')!.execute({ code: 'text("manual")', yield_time_ms: 60000 }, { session: f.document.view, sessionId: f.id });
        await f.mount.dispose();
        expect(worker.calls).toBe(1);
        expect(journal.sources).toBe(0);
        expect(f.document.view.events.filter(e => e.type === 'code/end')).toEqual([]);
    }
    finally {
        await f.close();
    }
}, 30000);
it('keeps the real constructor claim conjunctive and expires it after the genuine body frame', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture();
    try {
        await f.run();
        expect(invocation.tested).toBe(true);
        expect(invocation.getters).toBe(0);
        expect(invocation.claims).toHaveLength(1);
        expect(() => invocation.claims[0]!.assertCurrent()).toThrow();
        expect(worker.calls).toBe(1);
        expect(journal.sources).toBe(1);
    }
    finally {
        await f.close();
    }
}, 30000);
it('captures the nominal completion early while copied mounts, handles and late lookup never supply authority', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture();
    let id: string | undefined, handle: ReturnType<typeof captureOriginalCodeCompletion> | undefined, copyRejected = false;
    const off = observeOriginalCodeFinalOutputs(f.mount, cell => { id = cell; expect(() => captureOriginalCodeCompletion({ ...f.mount }, cell)).toThrow(); handle = captureOriginalCodeCompletion(f.mount, cell); void handle.settle.call({ ...handle }).then(() => { throw Error('Copied completion accepted'); }, () => { copyRejected = true; }); });
    try {
        await f.run();
        expect(id).toBeTypeOf('string');
        expect(copyRejected).toBe(true);
        expect(handle).toBeDefined();
        expect(await handle!.settle()).toMatchObject({ kind: 'qualified', worker: 'acquired', eligible: true });
        expect(() => captureOriginalCodeCompletion(f.mount, id!)).toThrow();
        expect(journal.sources).toBe(1);
        expect(worker.calls).toBe(1);
    }
    finally {
        off();
        await f.close();
    }
}, 30000);
it('retires the same temporarily unsent source capture after the original body frame expires', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture();
    journal.mode = 'temporary';
    try {
        await f.run().catch(() => { });
        expect(journal.captures).toBe(1);
        expect(worker.calls).toBe(0);
        let cleanup: unknown;
        await f.mount.dispose().catch(error => { cleanup = error; });
        expect(cleanup).toBeUndefined();
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toEqual([]);
        expect(f.document.view.events.filter(e => e.type === 'code/end')).toEqual([]);
        expect(journal.captures).toBe(1);
    }
    finally {
        journal.mode = 'none';
        await f.close().catch(() => { });
    }
}, 30000);
it('a retired original Code mount cannot issue a fresh source after held generation preparation', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    journal.holdGeneration = true;
    journal.entered = entered.resolve;
    journal.gate = release.promise;
    const running = f.run();
    void running.catch(() => { });
    try {
        await Promise.race([entered.promise, running.then(() => { throw Error('Original generation preparation omitted'); })]);
        const closing = f.mount.dispose();
        void closing.catch(() => { });
        release.resolve();
        await running.catch(() => { });
        await closing;
        expect(worker.calls).toBe(0);
        expect(journal.captures).toBe(0);
        expect(journal.sources).toBe(0);
        expect(f.document.view.events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toEqual([]);
    }
    finally {
        release.resolve();
        journal.holdGeneration = false;
        journal.entered = undefined;
        journal.gate = undefined;
        await running.catch(() => { });
        await f.close().catch(() => { });
    }
}, 30000);
it('joins the same auto-interrupted native record when started admission loses ACK after the outer source', async () => {
    worker.calls = journal.sources = 0;
    const f = await fixture(), failed = Promise.withResolvers<void>();
    journal.mode = 'started-unknown';
    journal.holdUnknown = true;
    journal.failedAdmission = failed.resolve;
    const running = f.run();
    void running.catch(() => { });
    try {
        await Promise.race([failed.promise, running.then(() => { throw Error('Original native started failure was omitted'); })]);
        expect(journal.sources).toBe(1);
        expect(journal.captures).toBe(1);
        expect(journal.starts).toBe(1);
        expect(worker.calls).toBe(0);
        journal.holdUnknown = false;
        await f.document.reconcile(journal.startedKey!);
        await running.catch(() => { });
        await f.mount.dispose();
        const events = f.document.view.events;
        expect(events.filter(e => e.type === 'code/cell' && e.state === 'started')).toHaveLength(1);
        expect(events.filter(e => e.type === 'code/cell' && e.state === 'interrupted')).toHaveLength(1);
        expect(events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toHaveLength(1);
        expect(events.filter(e => e.type === 'code/end')).toEqual([expect.objectContaining({ execution: { dispatch: 'not-dispatched', outcome: 'unknown' }, reason: 'launch-refused' })]);
        expect(worker.calls).toBe(0);
        expect(journal.starts).toBe(1);
        expect(journal.captures).toBe(1);
    }
    finally {
        journal.failedAdmission = undefined;
        journal.holdUnknown = false;
        journal.mode = 'none';
        await running.catch(() => { });
        await f.close().catch(() => { });
    }
}, 30000);
// Queue notification controls use the real native owner without claiming Code
// producer admission; only the preceding Agent/mount control proves that cut.
async function notificationFixture() {
    journal.mode = 'none';
    journal.holdUnknown = false;
    journal.startedKey = undefined;
    journal.failedAdmission = undefined;
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'code-notice-native-'));
    await mkdir(join(root, 'sessions'));
    const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract);
    const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id);
    const facts = createCodeModeEventFacts(document, async () => { });
    const started = { type: 'code/cell' as const, cellId: 'notice-cell', sessionId: id, state: 'started' as const };
    const terminal = { ...started, state: 'interrupted' as const, error: 'Code Mode admission did not complete' };
    return { document, facts, started, terminal, async close() { journal.mode = 'none'; journal.holdUnknown = false; await facts.close().catch(() => { }); await coordinator.close().catch(() => { }); } };
}
it('joins pending and already-settled original interrupted notifications once without replay', async () => {
    const f = await notificationFixture();
    let calls = 0, lateCalls = 0;
    const settled = () => { calls++; }, late = () => { lateCalls++; };
    journal.mode = 'started-unknown';
    journal.holdUnknown = true;
    try {
        await expect(f.facts.optional(f.started)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
        const joined = f.facts.required(f.terminal, undefined, settled);
        void joined.catch(() => { });
        journal.holdUnknown = false;
        await f.document.reconcile(journal.startedKey!);
        await joined.catch(() => { });
        await f.facts.refresh();
        expect(calls).toBe(1);
        await f.facts.required(f.terminal, undefined, settled);
        await f.facts.required(f.terminal, undefined, late);
        await f.facts.required(f.terminal, undefined, late);
        expect([calls, lateCalls]).toEqual([1, 1]);
        expect(f.document.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started', 'interrupted']);
        expect(f.facts.observationState()).toBe('available');
        await f.facts.close();
    }
    finally {
        await f.close();
    }
}, 30000);
it.each(['pending', 'settled'] as const)('retains a falsey %s original interrupted notification failure without callback or fact replay', async (phase) => {
    const f = await notificationFixture();
    let calls = 0;
    const failure = () => { calls++; throw false; };
    const reasons = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
    journal.mode = 'started-unknown';
    journal.holdUnknown = true;
    try {
        await expect(f.facts.optional(f.started)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
        let joined: Promise<void> | undefined;
        if (phase === 'pending') {
            joined = f.facts.required(f.terminal, undefined, failure);
            void joined.catch(() => { });
        }
        journal.holdUnknown = false;
        await f.document.reconcile(journal.startedKey!);
        if (phase === 'settled') {
            await f.facts.refresh();
            let late: unknown;
            try {
                await f.facts.required(f.terminal, undefined, failure);
            }
            catch (error) {
                late = error;
            }
            expect(reasons(late)).toContain(false);
        }
        await joined?.catch(() => { });
        for (let attempt = 0; attempt < 2; attempt++) {
            let error: unknown;
            try {
                await f.facts.required(f.terminal, undefined, failure);
            }
            catch (reason) {
                error = reason;
            }
            expect(reasons(error)).toContain(false);
        }
        let repeated: unknown;
        try {
            await f.facts.required(f.terminal, undefined, failure);
        }
        catch (error) {
            repeated = error;
        }
        expect(reasons(repeated)).toContain(false);
        expect(calls).toBe(1);
        expect(f.document.view.events.filter(e => e.type === 'code/cell' && e.state === 'interrupted')).toHaveLength(1);
        expect(f.facts.observationState()).toBe('unavailable');
        await expect(f.facts.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
    }
    finally {
        await f.close();
    }
}, 30000);
