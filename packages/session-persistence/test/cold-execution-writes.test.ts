import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
vi.mock('node:fs/promises', async (original) => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, readFile: vi.fn(fs.readFile), open: vi.fn(fs.open) }; });
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { observeColdExecutionWrites } from '../src/coordinator/cold-execution-writes.ts';
it('signals before original repair completes and only after original append success, past a throwing listener', async () => {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'cold-causal-')), path = join(root, 's.jsonl');
    const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract), phases: string[] = [];
    const repairing = Promise.withResolvers<void>(), repairGate = Promise.withResolvers<void>(), appending = Promise.withResolvers<void>(), appendGate = Promise.withResolvers<void>();
    let armed = false;
    vi.mocked(readFile).mockImplementation(async (...args: any[]) => { const repair = armed && String(args[0]) === path && new Error().stack?.includes('Object.repair'); if (repair) {
        phases.push('repair-read-enter');
        repairing.resolve();
        await repairGate.promise;
    } const value = await (native.readFile as any)(...args); if (repair)
        phases.push('repair-read-complete'); return value; });
    vi.mocked(open).mockImplementation(async (...args) => { const handle = await native.open(...args); if (!armed || String(args[0]) !== path || args[1] !== 'r+')
        return handle; let wrote = false; return new Proxy(handle, { get(target, key) { if (key === 'write')
            return async (...values: Parameters<typeof target.write>) => { wrote = true; return target.write(...values); }; if (key === 'sync')
            return async () => { if (wrote) {
                phases.push('append-sync-enter');
                appending.resolve();
                await appendGate.promise;
            } await target.sync(); if (wrote)
                phases.push('append-sync-complete'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); });
    try {
        await c.create({ sessionId: 's' });
        const seen: string[] = [], offThrow = observeColdExecutionWrites(c, () => { throw Error('consumer'); }), off = observeColdExecutionWrites(c, id => { seen.push(id); phases.push('edge'); });
        armed = true;
        const work = c.append('s', [{ type: 'plan/mode', mode: 'on' }]);
        await repairing.promise;
        expect(phases).toEqual(['edge', 'repair-read-enter']);
        repairGate.resolve();
        await appending.promise;
        expect(phases).toEqual(['edge', 'repair-read-enter', 'repair-read-complete', 'append-sync-enter']);
        expect(seen).toEqual(['s']);
        appendGate.resolve();
        await work;
        expect(phases).toEqual(['edge', 'repair-read-enter', 'repair-read-complete', 'append-sync-enter', 'append-sync-complete', 'edge']);
        expect((await c.snapshot!('s')).session.events).toMatchObject([{ type: 'plan/mode', mode: 'on', seq: 0 }]);
        off();
        offThrow();
        armed = false;
        await c.append('s', [{ type: 'plan/mode', mode: 'off' }]);
        expect(seen).toEqual(['s', 's']);
    }
    finally {
        armed = false;
        repairGate.resolve();
        appendGate.resolve();
        vi.mocked(readFile).mockImplementation(native.readFile);
        vi.mocked(open).mockImplementation(native.open);
        await c.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('does not signal pre-issue backend method-integrity refusal', async () => {
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'cold-refusal-')), backend = createJsonlBackend(root), c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract);
    try {
        await c.create({ sessionId: 's' });
        const seen: string[] = [], off = observeColdExecutionWrites(c, id => seen.push(id));
        backend.append = async () => { throw Error('write failed'); };
        await expect(c.append('s', [{ type: 'plan/mode', mode: 'on' }])).rejects.toThrow('TASK_TRANSITION_FAILED');
        expect(seen).toEqual([]);
        off();
    }
    finally {
        await c.close();
        await rm(root, { recursive: true, force: true });
    }
});

it.each([undefined, false])('retains original falsey append failure %s after sync and publishes uncertainty only after issue', async fault => {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'cold-falsey-')), path = join(root, 's.jsonl');
    const backend = createJsonlBackend(root), c = composeJsonlTaskTransitionCoordinator(backend, {lock:{enabled:true}}, taskDocumentStorageContract);
    const phases: string[] = []; let armed = false;
    vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await native.open(...args);
        if (!armed || String(args[0]) !== path || args[1] !== 'r+') return handle;
        let wrote = false;
        return new Proxy(handle, {get(target, key) {
            if (key === 'write') return async (...values: Parameters<typeof target.write>) => { wrote = true; phases.push('write'); return target.write(...values); };
            if (key === 'sync') return async () => { await target.sync(); if(wrote) phases.push('synced'); };
            if (key === 'close') return async () => { await target.close(); if(wrote && armed) { armed=false; phases.push('close-failed'); throw fault; } };
            const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
        }});
    });
    try {
        await c.create({sessionId:'s'}); const before=await readFile(path);
        const off = observeColdExecutionWrites(c, () => phases.push('edge'));
        armed=true;
        const failure=await c.append('s',[{type:'code/cell',cellId:'cell',state:'started'}]).then(()=>{throw Error('failure required')},error=>error);
        expect(failure).toMatchObject({message:'TASK_TRANSITION_FAILED'}); expect(failure.cause).toBe(fault);
        expect(phases).toEqual(['edge','write','synced','close-failed','edge']);
        expect(await readFile(path)).not.toEqual(before);
        expect((await backend.read('s')).events).toMatchObject([{type:'code/cell',cellId:'cell',state:'started',seq:0}]);
        off();
    } finally {armed=false;vi.mocked(open).mockImplementation(native.open);await c.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
});
