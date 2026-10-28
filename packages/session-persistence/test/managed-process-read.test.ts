import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { createSessionCoordinator } from '../src/index.ts';
import { createOwnership } from '../src/coordinator/ownership.ts';
import { createMutations } from '../src/coordinator/mutations.ts';
import { createLoads } from '../src/coordinator/load.ts';
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';
import { subscribe } from '@i-harness/core-session';

it('captures a genuine ready owner and delivers its immutable committed suffix once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-process-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } };
    const initial = createSessionCoordinator(backend, options);
    await initial.create({ sessionId: 's' }); await initial.close();
    const ownership = createOwnership(backend, options), mutations = createMutations(backend, ownership, 200, () => {});
    const latches = createProcessReadLatches();
    const loads = createLoads(backend, ownership, mutations), registry = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches);
    try {
        const document = await registry.open('s');
        expect(() => registry.captureProcessRead({ ...document }, [])).toThrow();
        const capture = registry.captureProcessRead(document, []);
        const count = capture.initial.events.length;
        expect(Object.isFrozen(capture.initial.events)).toBe(true);
        expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed');
        expect(capture.initial.events).toHaveLength(count);
        expect(() => capture.assertDrained()).toThrow();
        // A failed guard cannot be recovered or used to obtain the suffix.
        expect(() => capture.take()).toThrow();
        const next = registry.captureProcessRead(document, []);
        expect((await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).kind).toBe('committed');
        const update = next.take();
        expect(update.kind).toBe('suffix');
        if (update.kind === 'suffix') { expect(update.from).toBe(count + 1); expect(update.to).toBe(count + 2); expect(Object.isFrozen(update.events)).toBe(true); }
        expect(next.take()).toEqual({ kind: 'unchanged', highWater: count + 2 });
        next.assertDrained(); next.close(); expect(() => next.take()).toThrow();
        const verified = registry.captureProcessRead(document, []); verified.markVerified();
        expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed');
        expect(() => verified.assertDrained()).toThrow(); verified.close();
        const tampered = registry.captureProcessRead(document, []), originalView = document.view;
        let getterCalls = 0;
        Object.defineProperty(document, 'view', { configurable: true, get() { getterCalls++; return originalView; } });
        expect(() => tampered.take()).toThrow(); expect(getterCalls).toBe(0);
        Object.defineProperty(document, 'view', { configurable: true, writable: true, value: originalView });
        expect(() => tampered.take()).toThrow();
        const foreignOwnership = createOwnership(backend, options);
        const foreign = createManagedDocuments(backend, foreignOwnership, loads.loadOwned, options, () => {}, mutations);
        expect(() => foreign.captureProcessRead(document, [])).toThrow();
        registry.revoke('s'); expect(() => registry.captureProcessRead(document, [])).toThrow();
    } finally { await registry.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});

it('invalidates a cold reader before genuine managed admission reaches its queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-managed-latch-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } };
    const initial = createSessionCoordinator(backend, options); await initial.create({ sessionId: 's' }); await initial.close();
    const ownership = createOwnership(backend, options), latches = createProcessReadLatches();
    const mutations = createMutations(backend, ownership, 200, () => {}), loads = createLoads(backend, ownership, mutations);
    const registry = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches);
    try {
        const document = await registry.open('s');
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        let observerCanCapture = false;
        const unsubscribe = subscribe(document.view, () => { try { latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' }); observerCanCapture = true } catch {} });
        const operation = document.metadata.admit({ type: 'plan/mode', mode: 'on' });
        const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })();
        expect((await operation).kind).toBe('committed'); expect(denied).toBe(true); expect(observerCanCapture).toBe(true); unsubscribe();
        const beforeRevoke = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' });
        document.revokeNewWork(); expect(() => beforeRevoke.assertCurrent()).toThrow();
    } finally { await registry.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }); }
});
