import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { BatchKey } from '@i-harness/core-session';
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, ownedControls } from './helpers/composed.ts';
import type { createManagedDocuments } from '../src/coordinator/managed-documents.ts';
import type { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';

const constructed = vi.hoisted(() => ({ latches: [] as Array<{ value: unknown; begins: number; ends: number }>, registry: undefined as unknown }))
vi.mock('../src/coordinator/process-read-latches.ts', async load => {
  const api = await load<typeof import('../src/coordinator/process-read-latches.ts')>()
  return { ...api, createProcessReadLatches: (...args: Parameters<typeof api.createProcessReadLatches>) => {
    const value = api.createProcessReadLatches(...args), begin = value.beginMutation
    const record = { value, begins: 0, ends: 0 }
    value.beginMutation = input => { record.begins++; const token = Reflect.apply(begin, value, [input]); return { end(outcome) { record.ends++; token.end(outcome) } } }
    constructed.latches.push(record); return value
  } }
})
vi.mock('../src/coordinator/managed-documents.ts', async load => {
  const api = await load<typeof import('../src/coordinator/managed-documents.ts')>()
  return { ...api, createManagedDocuments: (...args: Parameters<typeof api.createManagedDocuments>) => { const value = api.createManagedDocuments(...args); constructed.registry = value; return value } }
})

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
    const coordinator = createSessionCoordinator(backend, opts)
    const registry = constructed.registry as ReturnType<typeof createManagedDocuments>
    const measured = constructed.latches.at(-1)!
    const originalLatches = measured.value as ReturnType<typeof createProcessReadLatches>
    const append = ownedControls(backend).originalAppend, reconcile = ownedControls(backend).originalReconcile
    let key: BatchKey | undefined, unknown = true;
    try {
        const document = await registry.open('s');
        ownedControls(backend).append = async (...args) => {
            key = args[3].key;
            if (terminal !== 'absent') await append(...args);
            else args[1].beforeIssue(); // Original issue boundary, lost acknowledgment with no bytes.
            return { kind: 'unknown', key };
        };
        ownedControls(backend).reconcile = (...args) => unknown ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args);
        expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'unknown' });
        expect(() => originalLatches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
        const before = measured.begins;
        for (let retry = 0; retry < 5; retry++) expect(await document.reconcile(key!)).toMatchObject({ kind: 'unknown' });
        expect((await Promise.all([document.reconcile(key!), document.reconcile(key!)])).map(outcome => outcome.kind)).toEqual(['unknown', 'unknown']);
        expect(measured.begins - before).toBe(1);
        expect(measured.begins - measured.ends).toBe(3); // Admission, original reconciliation and original quarantine; bounded across retries.
        unknown = false; installation.fail = terminal === 'failed-install';
        const outcome = await document.reconcile(key!);
        expect(outcome.kind).toBe(terminal === 'absent' ? 'absent' : terminal === 'failed-install' ? 'recovery-required' : 'committed');
        if (terminal === 'failed-install') {
            expect(() => originalLatches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' })).toThrow();
            installation.fail = false;
            expect(await document.reconcile(key!)).toMatchObject({ kind: 'committed' });
        }
        expect(measured.begins - measured.ends).toBe(0);
        const reader = originalLatches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' }); reader.retire();
        expect(document.view.events).toHaveLength(terminal === 'absent' ? 0 : 1);
        const unrelated = originalLatches.beginMutation({ sessionIds: ['other'], documentKeys: [], kind: 'other' }); unrelated.end('unknown');
        await document.metadata.admit({ type: 'plan/mode', mode: 'off' });
        expect(() => originalLatches.capture({ sessionId: 'other', documentKeys: [], mode: 'cold' })).toThrow();
    } finally {
        installation.fail = false; ownedControls(backend).append = append; ownedControls(backend).reconcile = reconcile;
        await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true });
    }
});
