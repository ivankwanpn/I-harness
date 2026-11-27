import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { captureExecutionHookChannel } from '@i-harness/core-plugin';
import type { LLMRequest } from '@i-harness/llm-seam';
import { DEFAULT_AGENT_PRESET } from '../../preset/src/index.ts';
import { committedFactSeqs, type ManagedAction, type FactOutcome, type CapturedActionFact } from '@i-harness/core-session';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { createExecutorExecutionCache } from '../../session-executor/src/durable-session.ts';
import { createOwnedMetadataFold } from '../../session-executor/src/lifecycle/owned-metadata-fold.ts';
import { actionMetadataFacts } from '../../session-executor/src/lifecycle/action-facts.ts';
import { createManagedExecutionRuntimeWithRegistry } from '../../session-executor/src/managed-assembly.ts';
import { controlledModel } from '../../session-executor/test/controlled-model.ts';
import { createOwnedDefaultSurface, type OwnedDefaultSurface } from '../src/owned-default-surface.ts';
it('uses original plan and metadata, live prompt and schemas, and preserves an existing off state', async () => {
    const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'default-surface-'));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let unknown = false, nativeWrites = 0;
    const backend = createJsonlBackend(root, { wrapOwnedBatch: append => (...args) => {
            const writing = append(...args);
            if (!Buffer.from(args[3].bytes).toString('utf8').includes('surface-held'))
                return writing;
            nativeWrites++;
            return writing.then(async (outcome) => { entered.resolve(); await release.promise; return unknown ? { kind: 'unknown' as const, key: args[3].key } : outcome; });
        } });
    const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, originalExecutionFoldFactory: createOwnedMetadataFold }, taskDocumentStorageContract);
    await coordinator.create({ sessionId: 'main' });
    const cache = createExecutorExecutionCache({ coordinator }), entry = await cache.get('main'), cleanups: Array<() => void | Promise<void>> = [];
    committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({ type: 'plan/mode', mode: 'off' }));
    const requests: LLMRequest[] = [];
    const model = controlledModel(async function* (request) {
        requests.push(request);
        yield { type: 'text/chunk', text: 'done' };
        yield { type: 'end' };
    });
    let surface: OwnedDefaultSurface | undefined, section = 'policy one', phase = 'one', original: any;
    let writingAction: ManagedAction<FactOutcome> | undefined, capture: CapturedActionFact<FactOutcome> | undefined, writing: Promise<FactOutcome> | undefined, writeOutcome: FactOutcome | undefined, primary: {
        cause: unknown;
    } | undefined;
    try {
        const runtime = await createManagedExecutionRuntimeWithRegistry({
            execution: entry.execution, systemPrompt: 'system', tools: [], assertConstructionCurrent() { },
            retainConstructionCleanup: c => cleanups.push(c),
            async configureRegistry(value) {
                original = value;
                surface = await createOwnedDefaultSurface(value, {
                    initialPlanMode: true, policyPrompt: () => section, shellPrompt: () => `shell ${phase}`,
                    projectPrompt: () => `project ${phase}`, hookPrompt: () => `hook ${phase}`, recoveryPrompt: () => `recovery ${phase}`,
                    schemas: () => value.tools.schemas(), prepareInput: async (text) => `expanded ${text}`, reconcileAuthority: async () => { }, goalChanged() { },
                });
                return surface;
            },
            resolveModel() { return { model }; },
        });
        const run = async (inputId: string) => {
            await entry.inputs.inbox.admit({ inputId, text: inputId, delivery: 'queue', intent: 'user',
                provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } });
            await runtime.lane.runAdmitted(inputId);
        };
        expect(entry.execution.observe().plan().active).toBe(false);
        expect(surface!.systemPrompt()).toContain('policy one');
        expect(surface!.modelSurface?.().baseInstructions).toBe(DEFAULT_AGENT_PRESET.systemPrompt);
        await run('first');
        const before = surface!.modelOverheadTokens();
        section = 'policy two '.repeat(100);
        phase = 'two';
        original.tools.register({ name: 'extra', description: 'extra live schema', inputSchema: { type: 'object' }, isReadOnly: true, async execute() { return 'ok'; } });
        expect(surface!.systemPrompt()).toContain('policy two');
        expect(surface!.modelSurface?.().baseInstructions).toBe(DEFAULT_AGENT_PRESET.systemPrompt);
        expect(surface!.modelToolSchemas().some((s: any) => s.name === 'extra')).toBe(true);
        expect(surface!.modelOverheadTokens()).toBeGreaterThan(before);
        expect(await surface!.prepareInput('/greet')).toBe('expanded /greet');
        committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({ type: 'plan/mode', mode: 'on' }));
        expect(surface!.systemPrompt()).toContain('PLAN MODE');
        await run('second');
        expect(requests).toHaveLength(2);
        for (const [index, label] of ['one', 'two'].entries()) {
            const request = requests[index]!;
            for (const part of ['policy', 'shell', 'project', 'hook', 'recovery']) expect(request.systemPrompt).toContain(`${part} ${label}`);
            expect(request.baseInstructions).toBe(DEFAULT_AGENT_PRESET.systemPrompt);
            expect(request.tools.some(schema => schema.name === 'extra')).toBe(index === 1);
        }
        expect(requests[0]!.systemPrompt).not.toContain('PLAN MODE');
        expect(requests[1]!.systemPrompt).toContain('PLAN MODE');
        await expect(captureExecutionHookChannel(runtime.ctx).emit('tools/pre-execute', { name: 'unknown' })).rejects.toThrow('read-only');
        const exit = original.tools.get('exit_plan_mode')!;
        expect(await exit.execute({}, { abortSignal: new AbortController().signal } as any)).toEqual({ active: true });
        expect(entry.execution.observe().plan().active).toBe(false);
        expect(await exit.execute({}, { abortSignal: new AbortController().signal } as any)).toEqual({ active: false });
        const prompt = surface!.systemPrompt(), schemas = surface!.modelToolSchemas(), overhead = surface!.modelOverheadTokens();
        writingAction = entry.execution.owner.beginAction();
        capture = writingAction.captureMetadata!({ type: 'session/title', title: 'surface-held', source: 'user', messageSeqs: [] });
        writing = capture.admit().then(outcome => { writeOutcome = outcome; return outcome; });
        await Promise.race([entered.promise, writing.then(() => { throw Error('Original native hold was not reached'); })]);
        expect(surface!.systemPrompt()).toBe(prompt);
        expect(surface!.modelToolSchemas()).toEqual(schemas);
        expect(surface!.modelOverheadTokens()).toBe(overhead);
        await expect(surface!.prepareInput('fresh input')).rejects.toThrow();
        unknown = true;
        release.resolve();
        expect(await writing).toMatchObject({ kind: 'unknown' });
        expect(() => surface!.systemPrompt()).toThrow();
        expect(() => surface!.modelToolSchemas()).toThrow();
        expect(() => surface!.modelOverheadTokens()).toThrow();
        await expect(surface!.prepareInput('unknown input')).rejects.toThrow();
        unknown = false;
        writeOutcome = await capture.reconcile();
        expect(writeOutcome).toMatchObject({ kind: 'committed' });
        expect(surface!.systemPrompt()).toBe(prompt);
        expect(nativeWrites).toBe(1);
        expect(await surface!.prepareInput('/greet')).toBe('expanded /greet');
        writingAction.finish();
        writingAction = undefined;
        await runtime.close();
        expect(() => surface!.systemPrompt()).toThrow(/retired|closed/i);
        expect(() => surface!.modelToolSchemas()).toThrow(/retired|closed/i);
    }
    catch (cause) {
        primary = { cause };
    }
    finally {
        release.resolve();
        unknown = false;
        const failures: unknown[] = [];
        try {
            await writing;
        }
        catch (error) {
            if (error !== primary?.cause)
                failures.push(error);
        }
        if (capture && (writeOutcome?.kind === 'unknown' || writeOutcome?.kind === 'recovery-required'))
            try {
                await capture.reconcile();
            }
            catch (error) {
                failures.push(error);
            }
        try {
            writingAction?.finish();
        }
        catch (error) {
            failures.push(error);
        }
        for (const cleanup of [...cleanups].reverse())
            try {
                await cleanup();
            }
            catch (error) {
                failures.push(error);
            }
        try {
            await cache.closeAll();
        }
        catch (error) {
            failures.push(error);
        }
        try {
            await coordinator.close();
        }
        catch (error) {
            failures.push(error);
        }
        if (primary && !failures.length)
            throw primary.cause;
        if (failures.length)
            throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original surface and cleanup failed', { cause: primary ? primary.cause : failures[0] });
    }
}, 30000);
