import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlBackend, lookupJsonlProcessRead } from '../src/backend-factory.ts';
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session';
import { createProcessReadLatches } from '../../session-persistence/src/coordinator/process-read-latches.ts';
import { createColdProcessReadOwner } from '../../session-persistence/src/coordinator/process-read-owner.ts';
import { createManagedProcessReadOwner } from '../../session-persistence/src/coordinator/process-read-managed-owner.ts';
import { createSessionCoordinator } from './helpers/composed.ts';
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts';
import { createMutations } from '../../session-persistence/src/coordinator/mutations.ts';
import { createLoads } from '../../session-persistence/src/coordinator/load.ts';
import { createManagedDocuments } from '../../session-persistence/src/coordinator/managed-documents.ts';

it('publishes only after a genuine cold finish and retires escaped observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-owner-')), backend = createJsonlBackend(root);
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const owner = createColdProcessReadOwner(lookupJsonlProcessRead(backend)!, createProcessReadLatches());
        let escaped: { assertCurrent(): void } | undefined;
        const result = await owner.run('s', { documentKeys: ['task-s'] }, async o => {
            escaped = o; expect(o.initial.highWater).toBe(0); expect(await o.check()).toEqual({ kind: 'unchanged', highWater: 0 }); return 'candidate';
        }, async (candidate, o, last) => { expect(last.kind).toBe('unchanged'); o.assertCurrent(); return candidate; });
        expect(result).toBe('candidate'); expect(() => escaped!.assertCurrent()).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('delivers the real managed installed suffix through the owner and finishes once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-managed-owner-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } };
    const setup = createSessionCoordinator(backend, options); await setup.create({ sessionId: 's' }); await setup.close();
    const latches = createProcessReadLatches(), ownership = createOwnership(backend, options), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations);
    const registry = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches);
    try {
        const document = await registry.open('s'), owner = createManagedProcessReadOwner(lookupJsonlProcessRead(backend)!, registry);
        const result = await owner.run('s', { documentKeys: [] }, async observation => {
            const from = observation.initial.highWater;
            expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed');
            const update = await observation.check(); expect(update.kind).toBe('suffix');
            if (update.kind === 'suffix') { expect(update.from).toBe(from); expect(update.to).toBe(from + 1); }
            expect((await observation.check()).kind).toBe('unchanged'); return 'candidate';
        }, async (candidate, observation, last) => { expect(last.kind).toBe('unchanged'); observation.assertCurrent(); return candidate; });
        expect(result).toBe('candidate');
    } finally { await registry.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});

it('delivers a suffix installed during final auxiliary verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-managed-final-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } };
    const setup = createSessionCoordinator(backend, options); await setup.create({ sessionId: 's' }); await setup.close();
    const latches = createProcessReadLatches(), ownership = createOwnership(backend, options), mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations);
    const registry = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches);
    try {
        const document = await registry.open('s'), genuine = lookupJsonlProcessRead(backend)!, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        const owner = createManagedProcessReadOwner({ capture: genuine.capture, async captureManagedAuxiliary(id, keys) {
            const aux = await genuine.captureManagedAuxiliary(id, keys);
            return { ...aux, async finish() { entered.resolve(); await release.promise; await aux.finish() } };
        } }, registry);
        const operation = owner.run('s', { documentKeys: [] }, async () => 'candidate', async (candidate, o, last) => {
            expect(last.kind).toBe('suffix'); if (last.kind === 'suffix') expect(last.to - last.from).toBe(1);
            o.assertCurrent(); return candidate;
        });
        await entered.promise; expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed'); release.resolve();
        expect(await operation).toBe('candidate');
    } finally { await registry.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});

it('discards a caught guard failure and refuses a second finish or escaped page check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-owner-fail-')), backend = createJsonlBackend(root), latches = createProcessReadLatches();
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const owner = createColdProcessReadOwner(lookupJsonlProcessRead(backend)!, latches);
        let published = false;
        await expect(owner.run('s', { documentKeys: [] }, async o => {
            const token = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'other' }); token.end('settled');
            try { o.assertCurrent() } catch {} return 'candidate';
        }, async () => { published = true; return 'bad' })).rejects.toThrow();
        expect(published).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('skips verification after failed work and fences publication across a final await', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-owner-publish-')), backend = createJsonlBackend(root), latches = createProcessReadLatches();
    try {
        await backend.create('s', { sessionId: 's', formatVersion: CURRENT_FORMAT_VERSION, createdAt: '2026-01-01T00:00:00.000Z' });
        const genuine = lookupJsonlProcessRead(backend)!; let finishes = 0;
        const owner = createColdProcessReadOwner({ async capture(id, keys) {
            const raw = await genuine.capture(id, keys);
            return { ...raw, async finish() { finishes++; await raw.finish() } };
        }, captureManagedAuxiliary: genuine.captureManagedAuxiliary }, latches);
        await expect(owner.run('s', { documentKeys: [] }, async () => { throw new Error('work failed') }, async () => 'bad')).rejects.toThrow('work failed');
        expect(finishes).toBe(0);
        await expect(owner.run('s', { documentKeys: [] }, async () => 'candidate', async (candidate, o) => {
            await Promise.resolve(); const token = latches.beginMutation({ sessionIds: ['s'], documentKeys: [], kind: 'other' }); token.end('settled');
            try { o.assertCurrent() } catch {} return candidate;
        })).rejects.toThrow();
        expect(finishes).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
});
