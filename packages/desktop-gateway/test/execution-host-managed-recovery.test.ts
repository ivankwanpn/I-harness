import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
const injection = vi.hoisted(() => ({ install: false, marker: Error('original install seam'), attempts: 0, installed: 0 }));
const journal=vi.hoisted(()=>({mode:undefined as 'committed'|'absent'|'install-failed'|undefined,unresolved:true,reconciles:0}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{
 const module=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return {...module,createFactJournalBackend(...args:Parameters<typeof module.createFactJournalBackend>){
  const original=module.createFactJournalBackend(...args)
  return {...original,
   async appendOwnedBatch(...values:Parameters<typeof original.appendOwnedBatch>){
    if(journal.mode==='absent'){values[1].beforeIssue();return {kind:'unknown' as const,key:values[3].key}}
    const result=await original.appendOwnedBatch(...values);return journal.mode==='committed'?{kind:'unknown' as const,key:values[3].key}:result
   },
   async reconcileOwnedBatch(...values:Parameters<typeof original.reconcileOwnedBatch>){
    if(journal.mode){journal.reconciles++;if(journal.unresolved)return {kind:'unknown' as const,key:values[3].key}}
    return original.reconcileOwnedBatch(...values)
   }
  }
 }}
})
vi.mock('node:fs/promises', async (original) => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, readFile: vi.fn(fs.readFile), rename: vi.fn(fs.rename) }; });
vi.mock('@i-harness/core-session', async (original) => {
    const core = await original<typeof import('@i-harness/core-session')>();
    return { ...core, createManagedSessionState(...args: Parameters<typeof core.createManagedSessionState>) {
            const state = core.createManagedSessionState(...args), stage = state.stage;
            return { ...state, stage(...values: Parameters<typeof stage>) {
                    const staged = stage(...values);
                    return { ...staged, install() { injection.attempts++; if (injection.install)
                            throw injection.marker; staged.install(); injection.installed++; } };
                } };
        } };
});
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory';
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract';
import { createSessionService } from '@i-harness/session-executor';
import { managedExecutionStatus } from '../../session-persistence/src/coordinator/managed-document.ts';
import { observeColdExecutionWrites } from '../../session-persistence/src/coordinator/cold-execution-writes.ts';
import { createProjectScopeBroker } from '../src/project-scope.ts';
import { createDesktopExecution } from '../src/execution.ts';
import { createExecutionHostObservation } from '../src/execution-host-observation.ts';
async function setup() {
    journal.mode=undefined;journal.unresolved=true;journal.reconciles=0
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'managed-host-')), backend = createJsonlBackend(root);
    const c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract);
    const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root);
    const execution = createDesktopExecution(c, service), owner = createExecutionHostObservation(c, broker, service, execution);
    await c.create({ sessionId: 's' });
    const assembly = await service.assemblyFor('s'), doc = assembly.managedDocument!, action = doc.beginAction();
    await action.facts.code.record({ type: 'code/cell', cellId: 'cell', state: 'started' });
    await action.facts.code.record({ type: 'code/call', cellId: 'cell', callId: 'call', name: 'tool', args: { x: 1 } });
    const notices: {
        kind: string;
        revision: number;
    }[] = [], lease = await owner.subscribe('s', notice => notices.push(notice));
    return { root, backend, c, assembly, doc, action, owner, execution, lease, notices, async close() { injection.install = false; action.finish(); await owner.close(); await service.close().catch(() => { }); await broker.close(); await c.close().catch(() => { }); await rm(root, { recursive: true, force: true }); } };
}
it('resets an actual retained profile overlapping managed output, then reads exact output and result on the same lease', async () => {
    const x = await setup(), original = x.execution.read;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let armed = false;
    vi.spyOn(x.execution, 'read').mockImplementation(async (...args) => { if (armed) {
        armed = false;
        await args[3]!();
        entered.resolve();
        await gate.promise;
    } ; return original(...args); });
    const edges: string[] = [], offThrow = observeColdExecutionWrites(x.c, () => { throw Error('listener'); }), off = observeColdExecutionWrites(x.c, id => edges.push(id));
    try {
        const before = await x.lease.snapshot();
        expect(before.kind).toBe('snapshot');
        armed = true;
        const reading = x.lease.snapshot();
        await entered.promise;
        const ack = await x.action.facts.code.record({ type: 'code/output', cellId: 'cell', content: { type: 'text', text: 'installed output' } });
        expect(ack).toMatchObject({ kind: 'committed', receipt: { key: { count: 1 } } });
        expect(edges).toEqual(['s']);
        gate.resolve();
        const overlap = await reading;
        expect(overlap.kind).toBe('reset');
        expect(overlap.revision).toBeGreaterThan(before.revision);
        expect((await x.action.facts.code.record({ type: 'code/result', cellId: 'cell', callId: 'call', name: 'tool', output: 'installed result' })).kind).toBe('committed');
        const after = await x.lease.snapshot();
        expect(after.kind).toBe('snapshot');
        if (after.kind === 'snapshot') {
            expect(after.value.cells[0].output).toMatchObject([{ kind: 'text', text: 'installed output' }]);
            expect(after.value.cells[0].calls[0]).toMatchObject({ id: 'call', output: 'installed result' });
        }
        expect(edges).toEqual(['s', 's']);
        expect(x.notices.some(n => n.kind === 'invalidate')).toBe(true);
    }
    finally {
        gate.resolve();
        off();
        offThrow();
        vi.restoreAllMocks();
        await x.close();
    }
});
it.each(['committed', 'absent', 'install-failed'] as const)('retires a real host on %s uncertainty and restores only a fresh epoch after original reconciliation', async (mode) => {
    const x = await setup(), baseline = x.doc.view.events.length;
    const status: string[] = [], off = observeColdExecutionWrites(x.c, () => { const state = managedExecutionStatus(x.doc); status.push(state); if (state === 'available')
        x.doc.assertReady(); });
    journal.mode=mode
    try {
        injection.install = mode === 'install-failed';
        injection.attempts = 0;
        injection.installed = 0;
        const result = await x.action.facts.code.record({ type: 'code/output', cellId: 'cell', content: { type: 'text', text: mode } });
        expect(result.kind).toBe(mode === 'install-failed' ? 'recovery-required' : 'unknown');
        expect(status).toEqual(['unavailable']);
        expect(x.doc.view.events).toHaveLength(baseline);
        expect(x.assembly.executionSurfaceState!()).toBe('unavailable');
        await expect(x.lease.snapshot()).rejects.toThrow();
        if (result.kind !== 'unknown' && result.kind !== 'recovery-required')
            throw Error('pending result required');
        const receipt = 'receipt' in result ? result.receipt : undefined, key = 'key' in result ? result.key : result.receipt.key;
        if (mode === 'install-failed') {
            expect(result).toMatchObject({ code: 'FACT_INSTALL_FAILED' });
            expect((await x.backend.read('s')).events.at(-1)).toMatchObject({ type: 'code/output' });
            expect(injection.attempts).toBe(1);
        }
        const retry = await x.doc.reconcile(key);
        expect(retry.kind).toBe(mode === 'install-failed' ? 'recovery-required' : 'unknown');
        expect(status).toEqual(['unavailable']);
        expect(x.doc.view.events).toHaveLength(baseline);
        journal.unresolved = false;
        injection.install = false;
        const recovered = await x.doc.reconcile(key);
        expect(recovered.kind).toBe(mode === 'absent' ? 'absent' : 'committed');
        expect(status).toEqual(mode === 'absent' ? ['unavailable', 'available'] : ['unavailable', 'unavailable', 'available']);
        expect(x.doc.view.events).toHaveLength(baseline + (mode === 'absent' ? 0 : 1));
        expect((await x.doc.reconcile(key)).kind).toBe('not-issued');
        expect(journal.reconciles).toBe(mode === 'install-failed' ? 0 : 2);
        if (mode === 'install-failed') {
            expect(recovered).toMatchObject({ receipt });
            expect(injection.attempts).toBe(3);
            expect(injection.installed).toBe(1);
        }
        const fresh = await x.owner.subscribe('s', () => { });
        expect(fresh.epoch).not.toBe(x.lease.epoch);
        const value = await fresh.snapshot();
        expect(value.kind).toBe('snapshot');
        if (value.kind === 'snapshot')
            expect(value.value.cells[0].output.map(o => o.text)).toEqual(mode === 'absent' ? [] : [mode]);
        await fresh.close();
    }
    finally {
        off();
        await x.close();
    }
});
it('retains genuine recovery holds and sticky source faults, with passive reads and once-only revoke', async () => {
    const x = await setup(), source = x.action.registerSettlementSource(async () => { }), seen: string[] = [];
    const off = observeColdExecutionWrites(x.c, () => seen.push(managedExecutionStatus(x.doc)));
    try {
        source.holdRecovery();
        source.holdRecovery();
        expect(seen).toEqual(['unavailable']);
        await expect(x.lease.snapshot()).rejects.toThrow();
        for (let i = 0; i < 10; i++)
            expect(managedExecutionStatus(x.doc)).toBe('unavailable');
        expect(seen).toEqual(['unavailable']);
        await source.close();
        await x.lease.close();
        expect(seen).toEqual(['unavailable', 'available']);
        x.doc.assertReady();
        const fresh = await x.owner.subscribe('s', () => { });
        expect(fresh.epoch).not.toBe(x.lease.epoch);
        const poisoned = x.action.registerSettlementSource(async () => { });
        await poisoned.recovery.capture({ type: 'context/recovery', state: 'invalid' } as never).admit();
        expect(managedExecutionStatus(x.doc)).toBe('unavailable');
        await expect(fresh.snapshot()).rejects.toThrow();
        await x.doc.reconcile({} as never);
        expect(managedExecutionStatus(x.doc)).toBe('unavailable');
        expect(seen).toEqual(['unavailable', 'available', 'unavailable']);
        x.doc.revokeNewWork();
        x.doc.revokeNewWork();
        expect(seen).toEqual(['unavailable', 'available', 'unavailable', 'retired']);
        await fresh.close();
        off();
        await x.doc.close().catch(() => { });
        expect(seen).toHaveLength(4);
    }
    finally {
        off();
        await x.close();
    }
});
it('retires a genuine cold host before original transition repair physically completes', async () => {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'load-host-')), backend = createJsonlBackend(root);
    const c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract), broker = createProjectScopeBroker(c, root);
    const service = { liveAssembly: () => undefined, onExecutionSurfaceLifecycle: () => () => { } }, owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service));
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let armed = false;
    vi.mocked(rename).mockImplementation(async (...args) => { if (armed && String(args[1]) === join(root, 's.jsonl')) {
        entered.resolve();
        await gate.promise;
    } return native.rename(...args); });
    try {
        await c.create({ sessionId: 's' });
        await c.append('s', [{ type: 'turn/start' }, { type: 'code/cell', cellId: 'cell', state: 'started' }]);
        await c.releaseOwnership('s');
        const notices: string[] = [], lease = await owner.subscribe('s', n => notices.push(n.kind)), before = await lease.snapshot();
        expect(before.kind).toBe('snapshot');
        armed = true;
        const loading = c.load('s');
        await entered.promise;
        await expect(lease.snapshot()).rejects.toThrow();
        expect(notices).toContain('retired');
        gate.resolve();
        await loading;
        await lease.close();
        await c.releaseOwnership('s');
        const fresh = await owner.subscribe('s', () => { }), after = await fresh.snapshot();
        expect(fresh.epoch).not.toBe(lease.epoch);
        expect(after.kind).toBe('snapshot');
        if (before.kind === 'snapshot' && after.kind === 'snapshot')
            expect(after.value.cells).toEqual(before.value.cells);
        await fresh.close();
    }
    finally {
        armed = false;
        gate.resolve();
        vi.mocked(rename).mockImplementation(native.rename);
        await owner.close();
        await broker.close();
        await c.close();
        await rm(root, { recursive: true, force: true });
    }
});

it('direct managed close retires the actual consumer once and detached host receives no late code publication', async () => {
    const x = await setup(), statuses: string[] = [];
    const off = observeColdExecutionWrites(x.c, () => statuses.push(managedExecutionStatus(x.doc)));
    try {
        x.action.finish();
        await x.doc.close();
        expect(statuses).toEqual(['retired']);
        expect(x.assembly.executionSurfaceState!()).toBe('retired');
        await expect(x.lease.snapshot()).rejects.toThrow();
        await x.lease.close();
        const baseline = x.notices.length;
        x.doc.revokeNewWork();
        await x.doc.close();
        expect(await x.action.facts.code.record({type:'code/output',cellId:'cell',content:'late'})).toMatchObject({kind:'not-issued',code:'FACT_CLOSED'});
        await Promise.resolve();
        expect(x.notices).toHaveLength(baseline);
        expect(statuses).toEqual(['retired']);
    } finally { off(); await x.close(); }
});
