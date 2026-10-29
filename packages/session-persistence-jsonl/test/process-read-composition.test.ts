import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlSessionCoordinator } from '../src/index.ts';
import { createSessionCoordinator, compileSemanticSeed } from '@i-harness/session-persistence';
import { createJsonlBackend } from '../src/backend-factory.ts';

it('constructs the genuine composed coordinator while generic construction stays separate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-'));
    const composed = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    const generic = createSessionCoordinator(createJsonlBackend(root));
    try {
        await composed.create({ sessionId: 's' });
        expect((await composed.snapshot!('s')).session.events).toEqual([]);
        expect('withProcessReadObservation' in generic).toBe(false);
        expect(composed.withProcessReadObservation).toBeTypeOf('function');
        let escaped: { assertCurrent(): void } | undefined;
        const result = await composed.withProcessReadObservation!('s', { documentKeys: [] }, async observation => {
            escaped = observation; expect(observation.initial.highWater).toBe(0); return 'candidate';
        }, async (candidate, observation, last) => { observation.assertCurrent(); expect(last.kind).toBe('unchanged'); return candidate; });
        expect(result).toBe('candidate'); expect(() => escaped!.assertCurrent()).toThrow();
        const copied = { ...composed };
        await expect(copied.withProcessReadObservation!('s', { documentKeys: [] }, async () => 1, async value => value)).rejects.toThrow();
        let published = false;
        await expect(composed.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
            try { await copied.withProcessReadObservation!('s', { documentKeys: [] }, async () => 1, async value => value) } catch {}
            return 'cached';
        }, async value => { published = true; return value })).rejects.toThrow();
        expect(published).toBe(false);
    } finally { await composed.close(); await generic.close(); await rm(root, { recursive: true, force: true }); }
});

it('refuses a real process capture while original bootstrap binding admission is still joined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-bootstrap-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>();
    await coordinator.create({ sessionId: 'target' });
    const binding = coordinator.withExistingSessionBindingObservation!({ sessionIds: ['target'] }, async () => { entered.resolve(); await leave.promise });
    const bindingOutcome = binding.catch(error => error);
    await entered.promise;
    const invocation = { version: 1 as const, operationId: 'joined', targetSessionId: 'target', createdAt: '2026-10-29T00:00:00.000Z', requestDigest: 'c'.repeat(64) };
    let finished = false;
    const never = async (): Promise<never> => { throw new Error('No dependencies') };
    const bootstrap = coordinator.bootstrapSemanticTarget({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'import' }, seed: compileSemanticSeed({ kind: 'none' }) }, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }).finally(() => { finished = true });
    try {
        await expect(coordinator.withProcessReadObservation!('target', { documentKeys: [] }, async () => 'bad', async value => value)).rejects.toThrow();
        expect(finished).toBe(false);
    } finally { leave.resolve(); await bindingOutcome; await bootstrap; await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});

it('discards an active managed candidate after a genuine recovery hold is entered and released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-recovery-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    try {
        await coordinator.create({ sessionId: 's' }); const document = await coordinator.openManagedDocument('s');
        const action = document.beginAction(), source = action.registerSettlementSource(async () => {});
        let published = false;
        await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async o => {
            source.holdRecovery(); source.holdRecovery(); action.finish(); await source.close();
            try { o.assertCurrent() } catch {} return 'cached';
        }, async value => { published = true; return value })).rejects.toThrow();
        expect(published).toBe(false);
        await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'fresh', async value => value);
    } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});

it.each([1, -1, 0.5, '1', null])('refuses inherited or malformed seed boundary %j in cold and managed process setup only', async seedLength => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-seed-')), backend = createJsonlBackend(root);
    const setup = createSessionCoordinator(backend, { lock: { enabled: true } });
    await setup.create({ sessionId: 's' }); await setup.append('s', [{ type: 'plan/mode', mode: 'on' }]); await setup.close();
    const path = join(root, 's.jsonl'), bytes = await readFile(path, 'utf8'), newline = bytes.indexOf('\n');
    await writeFile(path, JSON.stringify({ ...JSON.parse(bytes.slice(0, newline)), parentSession: 'parent', seedLength }) + bytes.slice(newline));
    const coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    try {
        await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'bad', async value => value)).rejects.toThrow();
        // Generic normalization remains the original behavior; a supported
        // ordinary managed owner must still refuse optimized inherited setup.
        const document = await coordinator.openManagedDocument('s'); expect(document.view.events).toHaveLength(1);
        await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'bad', async value => value)).rejects.toThrow();
    } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});

it.each([undefined, 0])('preserves ordinary lineage-only process reads with seed boundary %j', async seedLength => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-lineage-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    try {
        await coordinator.create({ sessionId: 's', parentSession: 'parent', ...(seedLength === undefined ? {} : { seedLength }) });
        await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'cold', async value => value);
        await coordinator.openManagedDocument('s');
        await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'managed', async value => value);
    } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});

it('uses the original ready managed owner and delivers its contiguous suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-compose-managed-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    try {
        await coordinator.create({ sessionId: 's' });
        const document = await coordinator.openManagedDocument('s');
        const result = await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async observation => {
            const from = observation.initial.highWater;
            expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed');
            const update = await observation.check(); expect(update.kind).toBe('suffix');
            if (update.kind === 'suffix') { expect(update.from).toBe(from); expect(update.to).toBe(from + 1); }
            return 'candidate';
        }, async (candidate, observation) => { observation.assertCurrent(); return candidate });
        expect(result).toBe('candidate');
    } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});

it('delivers the unique final managed suffix committed during the last work await', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-final-suffix-')), coordinator = createJsonlSessionCoordinator(root, { lock: { enabled: true } });
    try {
        await coordinator.create({ sessionId: 's' }); const document = await coordinator.openManagedDocument('s');
        let publications = 0;
        expect(await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async o => {
            await o.check();
            expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed');
            return 'candidate';
        }, async (value, o, last) => {
            publications++; expect(last).toMatchObject({ kind: 'suffix', from: 0, to: 1, events: [{ type: 'plan/mode' }] });
            o.assertCurrent(); return value;
        })).toBe('candidate');
        expect(publications).toBe(1);
    } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});
