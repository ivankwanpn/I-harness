import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, appendFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
const disposal = vi.hoisted(() => ({ armed: false, calls: 0, marker: Error('original release debt') }));
vi.mock('@i-harness/fs-lock', async (original) => {
    const locks = await original<typeof import('@i-harness/fs-lock')>();
    return { ...locks, async acquireSessionLock(...args: Parameters<typeof locks.acquireSessionLock>) {
            const held = await locks.acquireSessionLock(...args);
            return { get held() { return held.held; }, async release() { disposal.calls++; if (disposal.armed) {
                    disposal.armed = false;
                    throw disposal.marker;
                } ; await held.release(); } };
        } };
});
vi.mock('node:fs/promises', async (original) => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, readFile: vi.fn(fs.readFile), rename: vi.fn(fs.rename), open: vi.fn(fs.open) }; });
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { createOwnership } from '../src/coordinator/ownership.ts';
import { createLoads } from '../src/coordinator/load.ts';
import { createMutations } from '../src/coordinator/mutations.ts';
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts';
import { createColdExecutionWrites, observeColdExecutionWrites } from '../src/coordinator/cold-execution-writes.ts';
it.each(['transition14', 'historical13', 'lower13', 'lower5'] as const)('qualifies original %s recovery bytes, physical effects, sequences and snapshot silence', async (lane) => {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'load-causal-')), backend = createJsonlBackend(root), path = join(root, 's.jsonl');
    const version = lane === 'transition14' ? 14 : lane === 'lower5' ? 5 : 13;
    if (version === 14) {
        await backend.create('s', { sessionId: 's', createdAt: 'x', formatVersion: 14 });
        await writeFile(join(root, 'task-s.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}\n');
    }
    else if (version === 13) {
        const fixture = await readFile(join(import.meta.dirname, '../../session-persistence-jsonl/test/fixtures/original13-empty.jsonl'), 'utf8');
        await writeFile(path, fixture.replace('"p"', '"s"'));
    }
    else
        await writeFile(path, JSON.stringify({ sessionId: 's', createdAt: 'x', formatVersion: 5 }) + '\n');
    const seed = [{ type: 'turn/start', seq: 0 }, { type: 'code/cell', cellId: 'cell', state: 'started', seq: 1 }, { type: 'tool/call', callId: 'pending', name: 'tool', args: {}, seq: 2 }] as import('@i-harness/core-session').SessionEvent[];
    if (version === 5)
        seed.forEach(event => delete (event as {
            seq?: number;
        }).seq);
    await backend.append('s', seed);
    await appendFile(path, '{"torn":');
    const phases: string[] = [], entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), effectEntered = Promise.withResolvers<void>(), effectGate = Promise.withResolvers<void>();
    let armed = false, repairs = 0, replacements = 0, appends = 0;
    vi.mocked(readFile).mockImplementation(async (...args: any[]) => { const repair = armed && String(args[0]) === path && new Error().stack?.includes('Object.repair'); if (repair) {
        repairs++;
        phases.push('repair-enter');
        entered.resolve();
        await gate.promise;
    } return (native.readFile as any)(...args); });
    vi.mocked(rename).mockImplementation(async (...args) => { if (armed && String(args[1]) === path) {
        replacements++;
        phases.push('physical-replace-enter');
        if (lane === 'lower5' && replacements === 2) {
            effectEntered.resolve();
            await effectGate.promise;
        }
        ;
        await native.rename(...args);
        phases.push('physical-replace-complete');
        return;
    } return native.rename(...args); });
    vi.mocked(open).mockImplementation(async (...args) => { const handle = await native.open(...args); if (armed && String(args[0]) === path && args[1] === 'r+') {
        appends++;
        return new Proxy(handle, { get(target, key) { if (key === 'sync')
                return async () => { effectEntered.resolve(); await effectGate.promise; return target.sync(); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    } ; return handle; });
    const ownership = createOwnership(backend, { lock: { enabled: true, lockRoot: root } }), latches = createProcessReadLatches(), changes = createColdExecutionWrites(), loads = createLoads(backend, ownership, createMutations(backend, ownership, 10000, () => { }), latches, undefined, changes);
    const c = lane === 'transition14' || lane === 'historical13' ? composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract) : undefined;
    const off = c ? observeColdExecutionWrites(c, () => phases.push('edge')) : changes.observe(() => phases.push('edge'));
    try {
        armed = true;
        const before = await readFile(path), peek = await (c ? c.snapshot!('s') : loads.snapshot('s'));
        expect(phases).toEqual([]);
        expect(repairs + replacements + appends).toBe(0);
        expect(await readFile(path)).toEqual(before);
        const reader = latches.capture({ sessionId: 's', documentKeys: [], mode: 'cold' }), loading = c ? c.load('s') : loads.loadOwned('s');
        await entered.promise;
        expect(phases).toEqual(['edge', 'repair-enter']);
        expect(await readFile(path)).toEqual(before);
        if (!c)
            expect(() => reader.assertCurrent()).toThrow();
        gate.resolve();
        if (lane !== 'historical13') {
            await effectEntered.promise;
            expect(phases.filter(p => p === 'edge')).toHaveLength(3);
            effectGate.resolve();
        }
        ;
        const result = await loading, disk = await backend.read('s');
        expect(await readFile(path)).not.toEqual(before);
        expect(repairs).toBe(1);
        expect(replacements).toBe(lane === 'lower5' ? 3 : lane === 'lower13' ? 2 : 1);
        expect(appends).toBe(lane === 'transition14' || lane === 'lower13' ? 1 : 0);
        if (lane === 'lower5') {
            expect(peek.session.events.find(e => e.type === 'code/cell')?.seq).toBeUndefined();
            expect(disk.events.find(e => e.type === 'code/cell')).toMatchObject({ cellId: 'cell', state: 'started', seq: 1 });
            expect(result.session.events.find(e => e.type === 'code/cell')?.seq).toBe(1);
        }
        else {
            expect(disk.events.filter(e => e.type === 'code/cell')).toEqual(peek.session.events.filter(e => e.type === 'code/cell'));
            expect(result.session.events.filter(e => e.type === 'code/cell')).toEqual(peek.session.events.filter(e => e.type === 'code/cell'));
        }
        ;
        expect(disk.events.map(e => e.seq)).toEqual(disk.events.map((_, i) => i));
        expect(disk.events.some(e => e.type === 'tool/result')).toBe(lane !== 'historical13');
        expect(phases.filter(p => p === 'edge')).toHaveLength(lane === 'historical13' ? 2 : 4);
    }
    finally {
        armed = false;
        gate.resolve();
        effectGate.resolve();
        off();
        vi.mocked(readFile).mockImplementation(native.readFile);
        vi.mocked(rename).mockImplementation(native.rename);
        vi.mocked(open).mockImplementation(native.open);
        await c?.close();
        await Promise.all(ownership.releaseHeldLocks());
        await rm(root, { recursive: true, force: true });
    }
});
it('preserves lower owned replacement failure over original release debt, retaining cleanup until explicit retry', async () => {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'lower-debt-')), path = join(root, 's.jsonl'), backend = createJsonlBackend(root);
    const seed = [{ type: 'turn/start' }, { type: 'code/cell', cellId: 'cell', state: 'started' }, { type: 'tool/call', callId: 'call', name: 'tool', args: {} }];
    await writeFile(path, [JSON.stringify({ sessionId: 's', createdAt: 'x', formatVersion: 5 }), ...seed.map(event => JSON.stringify(event))].join('\n') + '\n');
    const ownership = createOwnership(backend, { lock: { enabled: true, lockRoot: root } }), changes = createColdExecutionWrites(), loads = createLoads(backend, ownership, createMutations(backend, ownership, 10000, () => { }), undefined, undefined, changes), seen: string[] = [];
    const off = changes.observe(() => seen.push('edge'));
    let replaces = 0;
    const fault = Object.freeze({ original: 'replace-after-rename' });
    vi.mocked(rename).mockImplementation(async (...args) => { await native.rename(...args); if (String(args[1]) === path && ++replaces === 2) {
        disposal.armed = true;
        throw fault;
    } });
    try {
        const before = await readFile(path);
        disposal.calls = 0;
        await expect(loads.loadOwned('s')).rejects.toBe(fault);
        expect(await readFile(path)).not.toEqual(before);
        expect((await backend.read('s')).events.some(e => e.type === 'tool/result')).toBe(true);
        expect(seen).toEqual(['edge', 'edge', 'edge']);
        expect(disposal.calls).toBe(1);
        expect(ownership.ownerOf('s')).toBe(true);
        await expect(ownership.borrowOwnership('s')).rejects.toBe(disposal.marker);
        await Promise.all(ownership.releaseHeldLocks());
        expect(disposal.calls).toBe(2);
        expect(ownership.ownerOf('s')).toBe(false);
    }
    finally {
        disposal.armed = false;
        off();
        vi.mocked(rename).mockImplementation(native.rename);
        await Promise.all(ownership.releaseHeldLocks());
        await rm(root, { recursive: true, force: true });
    }
});
it.each([undefined, false])('preserves falsey original issued repair failure %s after physical commit without a success edge', async (fault) => {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'repair-failure-')), path = join(root, 's.jsonl'), backend = createJsonlBackend(root);
    const fixture = await readFile(join(import.meta.dirname, '../../session-persistence-jsonl/test/fixtures/original13-empty.jsonl'), 'utf8');
    await writeFile(path, fixture.replace('"p"', '"s"'));
    await backend.append('s', [{ type: 'turn/start', seq: 0 }]);
    await appendFile(path, '{"torn":');
    const c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract), phases: string[] = [], entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let armed = true;
    const off = observeColdExecutionWrites(c, () => phases.push('edge'));
    vi.mocked(rename).mockImplementation(async (...args) => { await native.rename(...args); if (armed && String(args[1]) === path) {
        phases.push('physical-complete');
        entered.resolve();
        await gate.promise;
        throw fault;
    } });
    try {
        const before = await readFile(path), loading = c.load('s');
        void loading.catch(() => { });
        await entered.promise;
        expect(phases).toEqual(['edge', 'physical-complete']);
        expect(await readFile(path)).not.toEqual(before);
        gate.resolve();
        await expect(loading).rejects.toBe(fault);
        expect(phases).toHaveLength(2);
    }
    finally {
        armed = false;
        gate.resolve();
        off();
        vi.mocked(rename).mockImplementation(native.rename);
        await c.close();
        await rm(root, { recursive: true, force: true });
    }
});
