import { expect, it, vi, onTestFinished } from 'vitest';
import type { FactOutcome } from '@i-harness/core-session';
type State = Awaited<ReturnType<(typeof import('../../core-session/src/managed/execution-state.ts'))['restoreManagedExecutionState']>>;
type Ownership = ReturnType<(typeof import('../src/coordinator/ownership.ts'))['createOwnership']>;
const cut = vi.hoisted(() => ({
    ownership: new WeakMap<object, Ownership>(), state: undefined as State | undefined,
    prepare: undefined as undefined | ((state: State) => Promise<void>),
    failClose: false, closeCause: undefined as unknown, closeEntered: undefined as undefined | (() => void),
    closeGate: undefined as Promise<void> | undefined,
    releasePrepare: undefined as undefined | (() => void), releaseClose: undefined as undefined | (() => void), closeAttempts: 0, closed: 0, prepareError: undefined as unknown,
}));
vi.mock('../src/coordinator/ownership.ts', async (load) => {
    const real = await load<typeof import('../src/coordinator/ownership.ts')>();
    return { ...real, createOwnership(...args: Parameters<typeof real.createOwnership>) {
            const owner = real.createOwnership(...args);
            cut.ownership.set(args[0], owner);
            return owner;
        } };
});
vi.mock('../../core-session/src/managed/execution-state.ts', async (load) => {
    const real = await load<typeof import('../../core-session/src/managed/execution-state.ts')>();
    return { ...real, async restoreManagedExecutionState(...args: Parameters<typeof real.restoreManagedExecutionState>) {
            const state = await real.restoreManagedExecutionState(...args);
            if (args[1].token.sessionId === 'parent') {
                cut.state = state;
                const original = state.prepareWrite;
                state.prepareWrite = async (...input: Parameters<typeof original>) => {
                    try {
                        const staged = await Reflect.apply(original, state, input);
                        try {
                            await cut.prepare?.(state);
                        }
                        catch (cause) {
                            staged.discardUnissued();
                            throw cause;
                        }
                        return staged;
                    }
                    catch (cause) {
                        cut.prepareError = cause;
                        throw cause;
                    }
                };
            }
            return state;
        } };
});
vi.mock('../src/execution-internal.ts', async (load) => {
    const real = await load<typeof import('../src/execution-internal.ts')>();
    return { ...real, associateExecutionDependencies(backend: object, open: Parameters<typeof real.associateExecutionDependencies>[1]) {
            real.associateExecutionDependencies(backend, (...args) => {
                const original = open(...args);
                return Object.freeze({
                    assertCurrent: original.assertCurrent.bind(original), readEvent: original.readEvent.bind(original),
                    async close() {
                        if (cut.failClose) {
                            cut.closeAttempts++;
                            cut.closeEntered?.();
                            await cut.closeGate;
                            throw cut.closeCause;
                        }
                        await original.close();
                        cut.closed++;
                    },
                });
            });
        } };
});
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../src/execution-internal.ts';
import { captureManagedRequiredParent } from '../src/coordinator/managed-document.ts';
async function fixture(opaque?: () => Promise<void>) {
    cut.releasePrepare = undefined;
    cut.releaseClose = undefined;
    cut.state = undefined;
    cut.closeAttempts = 0;
    cut.closed = 0;
    cut.prepareError = undefined;
    cut.prepare = undefined;
    cut.failClose = false;
    cut.closeEntered = undefined;
    cut.closeGate = undefined;
    const root = await mkdtemp(join(tmpdir(), 'required-preparing-'));
    let coordinator: ReturnType<typeof composeJsonlTaskTransitionCoordinator> | undefined;
    let action: ReturnType<Awaited<ReturnType<NonNullable<typeof coordinator>['openManagedDocument']>>['beginAction']> | undefined;
    let cleanup: Promise<void> | undefined;
    onTestFinished(context => {
        if (!cleanup)
            cleanup = (async () => {
                cut.releasePrepare?.();
                cut.releaseClose?.();
                cut.prepare = undefined;
                cut.failClose = false;
                cut.closeEntered = undefined;
                cut.closeGate = undefined;
                const errors: unknown[] = [];
                try {
                    action?.finish();
                }
                catch (error) {
                    errors.push(error);
                }
                try {
                    await coordinator?.close();
                }
                catch (error) {
                    errors.push(error);
                }
                if (errors.length)
                    throw new AggregateError(errors, 'Original preparation fixture cleanup failed');
                const target = resolve(root);
                if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('required-preparing-'))
                    throw Error('Unsafe preparation fixture cleanup');
                if(context.task.result?.state!=='fail')await rm(target, { recursive: true, force: true });
            })();
        return cleanup;
    });
    let appends = 0;
    const backend = createJsonlBackend(root, { wrapOwnedBatch: next => async (...input) => {
            if (Buffer.from(input[3].bytes).includes(Buffer.from('"type":"step/end"'))) {
                if (opaque)
                    await opaque();
                appends++;
            }
            return next(...input);
        } });
    coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract);
    await coordinator.create({ sessionId: 'parent' });

    await acquireManagedExecution(coordinator, 'parent');
    const document = await coordinator.openManagedDocument('parent');
    action = document.beginAction();
    const source = action.registerSettlementSource(async () => { }), other = action.registerSettlementSource(async () => { });
    await action.facts.agent.lifecycle({type:'turn/start'});
    await action.facts.agent.lifecycle({type:'step/start'});
    const ownership = cut.ownership.get(backend);
    if (!ownership)
        throw Error('Original ownership not observed');
    const parent = captureManagedRequiredParent(document, ownership, source);
    return { root, coordinator, document, action, source, other, parent, appends: () => appends };
}
it('joins the original accepted preparation before reserving a required writer', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let writer: Awaited<ReturnType<typeof f.parent.acquireWriter>> | undefined;
    let admission: Promise<FactOutcome> | undefined, acquiring: ReturnType<typeof f.parent.acquireWriter> | undefined;
    try {
        cut.releasePrepare = release.resolve;
        cut.prepare = async () => { entered.resolve(); await release.promise; };
        admission = f.other.lifecycle.lifecycle({ type: 'step/end' });
        await entered.promise;
        acquiring = f.parent.acquireWriter();
        release.resolve();
        const result = await admission;
        writer = await acquiring;
        expect(result).toMatchObject({ kind: 'committed' });
        expect(f.appends()).toBe(1);
        const events = (await f.coordinator.snapshot!('parent')).session.events;
        expect(events.filter(event => event.type === 'step/end')).toHaveLength(1);
    }
    finally {
        release.resolve();
        await admission?.catch(() => { });
        if (acquiring)
            writer = await acquiring.catch(() => undefined);
        writer?.release();
    }
});
it('rechecks a later opaque interception instead of self-waiting an early preparation join', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), intercepted = Promise.withResolvers<void>();
    let acquiring: Promise<{
        release(): void;
    }> | undefined;
    const f = await fixture(async () => { intercepted.resolve(); await acquiring?.catch(() => { }); });
    let admission: Promise<FactOutcome> | undefined;
    try {
        cut.releasePrepare = release.resolve;
        cut.prepare = async () => { entered.resolve(); await release.promise; };
        admission = f.other.lifecycle.lifecycle({ type: 'step/end' });
        await entered.promise;
        acquiring = f.parent.acquireWriter();
        void acquiring.catch(() => { });
        release.resolve();
        await Promise.race([intercepted.promise, admission.then(() => { throw Error('Expected original opaque interception'); })]);
        await expect(acquiring).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', cause: { originalBatchIssued: false, sameRequiredSource: false } });
        expect(await admission).toMatchObject({ kind: 'committed' });
        expect(f.appends()).toBe(1);
    }
    finally {
        release.resolve();
        const lease = await acquiring?.catch(() => undefined);
        lease?.release();
        await admission?.catch(() => { });
    }
});
it('refuses the same source while its original preparation is pending', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let admission: Promise<FactOutcome> | undefined, acquiring: ReturnType<typeof f.parent.acquireWriter> | undefined;
    try {
        cut.releasePrepare = release.resolve;
        cut.prepare = async () => { entered.resolve(); await release.promise; };
        admission = f.source.lifecycle.lifecycle({ type: 'step/end' });
        await entered.promise;
        acquiring = f.parent.acquireWriter();
        await expect(acquiring).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' });
        release.resolve();
        expect(await admission).toMatchObject({ kind: 'committed' });
    }
    finally {
        release.resolve();
        const lease = await acquiring?.catch(() => undefined);
        lease?.release();
        await admission?.catch(() => { });
    }
});
it('refuses a reentrant preparation callback before any self-wait', async () => {
    const f = await fixture();
    try {
        cut.prepare = async () => { await expect(f.parent.acquireWriter()).rejects.toThrow(); await expect(f.parent.joinIssuedWriter()).rejects.toThrow(); };
        expect(await f.other.lifecycle.lifecycle({ type: 'step/end' })).toMatchObject({ kind: 'committed' });
    }
    finally {
    }
});
it.each([undefined, null, false, 0] as const)('keeps original preparation close failure %s out of the exclusion ACK', async (cause) => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let admission: Promise<FactOutcome> | undefined, acquiring: ReturnType<typeof f.parent.acquireWriter> | undefined;
    try {
        const before = await readFile(join(f.root, 'parent.jsonl'));
        cut.failClose = true;
        cut.closeCause = cause;
        cut.closeEntered = entered.resolve;
        cut.closeGate = release.promise;
        cut.releaseClose = release.resolve;
        admission = f.other.lifecycle.lifecycle({ type: 'step/end' });
        await entered.promise;
        acquiring = f.parent.acquireWriter();
        void acquiring.catch(() => { });
        release.resolve();
        expect(await admission).toMatchObject({ kind: 'not-issued' });
        const originalError = cut.prepareError;
        await expect(acquiring).rejects.toBe(originalError);
        expect(f.appends()).toBe(0);
        expect(await readFile(join(f.root, 'parent.jsonl'))).toEqual(before);
        cut.failClose = false;
        await cut.state!.settleDependencies();
        expect(cut.closeAttempts).toBeGreaterThan(0);
        const writer = await f.parent.acquireWriter();
        writer.release();
    }
    finally {
        release.resolve();
        cut.failClose = false;
        await acquiring?.catch(() => { });
        await admission?.catch(() => { });
    }
});
it('does not revive a retired parked exclusion after an original preparation join', async () => {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const writer = await f.parent.acquireWriter();
    writer.park();
    let admission: Promise<FactOutcome> | undefined, resuming: Promise<void> | undefined;
    try {
        cut.releasePrepare = release.resolve;
        cut.prepare = async () => { entered.resolve(); await release.promise; };
        admission = f.other.lifecycle.lifecycle({ type: 'step/end' });
        await entered.promise;
        resuming = writer.resume();
        void resuming.catch(() => { });
        writer.release();
        release.resolve();
        expect(await admission).toMatchObject({ kind: 'committed' });
        await expect(resuming).rejects.toThrow('Retired original writer exclusion');
        expect(await f.document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed' });
    }
    finally {
        release.resolve();
        await resuming?.catch(() => { });
        writer.release();
        await admission?.catch(() => { });
    }
});
