import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { createOwnership } from '../src/coordinator/ownership.ts';
import { createMutations } from '../src/coordinator/mutations.ts';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';

it('owns the original queued mutation until real JSONL flush settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-queue-')), backend = createJsonlBackend(root);
    const ownership = createOwnership(backend, {}), latches = createProcessReadLatches();
    const mutations = createMutations(backend, ownership, 10000, () => {}, undefined, undefined, latches);
    try {
        await mutations.create({ sessionId: 's' });
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        mutations.enqueue('s', [{ type: 'turn/start' }]);
        expect(() => reader.assertCurrent()).toThrow();
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
        await mutations.flush('s');
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).not.toThrow();
    } finally { await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});

it('invalidates a reader synchronously when direct append is admitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-append-')), backend = createJsonlBackend(root);
    const ownership = createOwnership(backend, {}), latches = createProcessReadLatches();
    const mutations = createMutations(backend, ownership, 10000, () => {}, undefined, undefined, latches);
    try {
        await mutations.create({ sessionId: 's' });
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        const writing = mutations.append('s', [{ type: 'turn/start' }]);
        expect(() => reader.assertCurrent()).toThrow();
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
        await writing;
        expect(() => latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).not.toThrow();
    } finally { await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});
