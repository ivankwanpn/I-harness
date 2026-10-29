import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { BatchKey } from '@i-harness/core-session';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { createSessionCoordinator } from '../src/index.ts';
import { createOwnership } from '../src/coordinator/ownership.ts';
import { createMutations } from '../src/coordinator/mutations.ts';
import { createLoads } from '../src/coordinator/load.ts';
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';

const installation = vi.hoisted(() => ({ fail: false }));
vi.mock('@i-harness/core-session', async importOriginal => {
    const original = await importOriginal<typeof import('@i-harness/core-session')>();
    return { ...original, createManagedSessionState: (...args: Parameters<typeof original.createManagedSessionState>) => {
        const state = original.createManagedSessionState(...args);
        return { ...state, stage: (...args: Parameters<typeof state.stage>) => {
            const staged = state.stage(...args);
            return { ...staged, install() { if (installation.fail) throw new Error('injected install failure'); staged.install(); } };
        } };
    } };
});

for (const terminal of ['committed', 'absent', 'failed-install'] as const) it(`retains bounded original pending witnesses through repeated unknown and ${terminal}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-pending-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } };
    const initial = createSessionCoordinator(backend, opts); await initial.create({ sessionId: 's' }); await initial.close();
    const ownership = createOwnership(backend, opts), originalLatches = createProcessReadLatches();
    let begins = 0, ends = 0;
    const latches = { ...originalLatches, beginMutation(input: Parameters<typeof originalLatches.beginMutation>[0]) {
        begins++; const token = originalLatches.beginMutation(input);
        return { end(outcome: 'settled' | 'unknown') { ends++; token.end(outcome); } };
    } };
    const mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations);
    const registry = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations, latches);
    const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!;
    let key: BatchKey | undefined, unknown = true;
    try {
        const document = await registry.open('s');
        backend.appendOwnedBatch = async (...args) => {
            key = args[3].key;
            if (terminal !== 'absent') await append(...args);
            return { kind: 'unknown', key };
        };
        backend.reconcileOwnedBatch = (...args) => unknown ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args);
        expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'unknown' });
        expect(() => originalLatches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
        const before = begins;
        for (let retry = 0; retry < 5; retry++) expect(await document.reconcile(key!)).toMatchObject({ kind: 'unknown' });
        expect((await Promise.all([document.reconcile(key!), document.reconcile(key!)])).map(outcome => outcome.kind)).toEqual(['unknown', 'unknown']);
        expect(begins - before).toBe(1);
        expect(begins - ends).toBe(3); // Admission, original reconciliation and original quarantine; bounded across retries.
        unknown = false; installation.fail = terminal === 'failed-install';
        const outcome = await document.reconcile(key!);
        expect(outcome.kind).toBe(terminal === 'absent' ? 'absent' : terminal === 'failed-install' ? 'recovery-required' : 'committed');
        if (terminal === 'failed-install') {
            expect(() => originalLatches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
            installation.fail = false;
            expect(await document.reconcile(key!)).toMatchObject({ kind: 'committed' });
        }
        expect(begins - ends).toBe(0);
        const reader = originalLatches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' }); reader.retire();
        expect(document.view.events).toHaveLength(terminal === 'absent' ? 0 : 1);
        const unrelated = originalLatches.beginMutation({ sessionIds: ['other'], documentKeys: [], kind: 'other' }); unrelated.end('unknown');
        await document.metadata.admit({ type: 'plan/mode', mode: 'off' });
        expect(() => originalLatches.capture({ sessionId: 'other', documentKeys: [], mode: 'cold' })).toThrow();
    } finally {
        installation.fail = false; backend.appendOwnedBatch = append; backend.reconcileOwnedBatch = reconcile;
        await registry.close().catch(() => {}); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true });
    }
});
