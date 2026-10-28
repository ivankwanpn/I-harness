import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { createOwnership } from '../src/coordinator/ownership.ts';
import { createMutations } from '../src/coordinator/mutations.ts';
import { createLoads } from '../src/coordinator/load.ts';
import { createDocuments } from '../src/coordinator/documents.ts';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';

it('fences repair-capable loads while snapshot remains read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-load-')), backend = createJsonlBackend(root);
    const ownership = createOwnership(backend, {}), latches = createProcessReadLatches();
    const mutations = createMutations(backend, ownership, 10000, () => {});
    const loads = createLoads(backend, ownership, mutations, latches);
    try {
        await mutations.create({ sessionId: 's' });
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        await loads.snapshot('s'); reader.assertCurrent();
        const loading = loads.load('s');
        const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })();
        await loading; expect(denied).toBe(true);
        const next = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        const owned = loads.loadOwned('s');
        const ownedDenied = (() => { try { next.assertCurrent(); return false } catch { return true } })();
        await owned; expect(ownedDenied).toBe(true);
    } finally { await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});

it('fences the selected document before the async document queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-doc-')), backend = createJsonlBackend(root);
    const ownership = createOwnership(backend, {}), latches = createProcessReadLatches();
    const documents = createDocuments(backend, ownership, () => {}, latches);
    try {
        const reader = latches.capture({ sessionId: 's', documentKeys: ['key'], mode: 'cold' });
        const writing = documents.putDocumentStrict('key', { value: 1 });
        const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })();
        await writing; expect(denied).toBe(true);
        const after = latches.capture({ sessionId: 's', documentKeys: ['key'], mode: 'cold' });
        documents.closeAdmissions(['key']); expect(() => after.assertCurrent()).toThrow();
    } finally { await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});
