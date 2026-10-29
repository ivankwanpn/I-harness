import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { createOwnership } from '../src/coordinator/ownership.ts';
import { createMutations } from '../src/coordinator/mutations.ts';
import { createLoads } from '../src/coordinator/load.ts';
import { createDocuments } from '../src/coordinator/documents.ts';
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts';
import { createLifecycle } from '../src/coordinator/lifecycle.ts';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';

it('fences the manifest and session synchronously through actual deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-delete-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } };
    const ownership = createOwnership(backend, opts), latches = createProcessReadLatches();
    const mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations);
    const documents = createDocuments(backend, ownership, () => {}), managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations);
    const lifecycle = createLifecycle(backend, ownership, mutations, documents, managed, latches);
    try {
        await mutations.create({ sessionId: 's' });
        const reader = latches.capture({ sessionId: 's', documentKeys: ['task-s'], mode: 'cold' });
        const deleting = lifecycle.deleteOwnedSession('s', { documents: ['task-s'] });
        const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })();
        await deleting; expect(denied).toBe(true);
    } finally { await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});

it('closes observation admission synchronously before lifecycle drainage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-shutdown-')), backend = createJsonlBackend(root);
    const ownership = createOwnership(backend, {}), latches = createProcessReadLatches();
    const mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations);
    const documents = createDocuments(backend, ownership, () => {}), managed = createManagedDocuments(backend, ownership, loads.loadOwned, {}, () => {}, mutations);
    const lifecycle = createLifecycle(backend, ownership, mutations, documents, managed, latches);
    try {
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        const closing = lifecycle.close();
        const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })();
        await closing; expect(denied).toBe(true);
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
    } finally { await managed.close(); await rm(root, { recursive: true, force: true }); }
});
