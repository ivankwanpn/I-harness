import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory';
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract';
import { createSessionService } from '@i-harness/session-executor';
import { createProjectScopeBroker } from '../src/project-scope.ts';
import { createDesktopExecution } from '../src/execution.ts';
import { createExecutionHostObservation } from '../src/execution-host-observation.ts';
import { createSurfaceSubscriptions } from '../src/observation/subscriptions.ts';
import { createGatewayWrite } from '../src/router.ts'
it('does not advertise observation for a forged or unsupported original native owner',()=>{
 const retain=vi.fn(()=>{throw Error('must not read')}),unsupported=createExecutionHostObservation({retainExistingSessionBindingObservation:retain} as never,{} as never,{onExecutionSurfaceLifecycle:()=>()=>{},liveAssembly:()=>undefined},{} as never),frames:any[]=[]
 expect(unsupported.supported()).toBe(false)
 createGatewayWrite(frame=>frames.push(frame),{execution:{} as never,executionObservation:unsupported})({jsonrpc:'2.0',id:'initialize',result:{name:'fixture',version:'0',protocolVersion:3,capabilities:{}}})
 expect(frames[0].result.capabilities['desktop-execution']).toEqual(['1']);expect(frames[0].result.capabilities).not.toHaveProperty('desktop-surface-events');expect(retain).not.toHaveBeenCalled()
})
it('binds original managed snapshot replies to original revision and authority at actual write, including ACK/replay', async () => {
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'surface-wire-')), c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract);
    const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), execution = createDesktopExecution(c, service), source = createExecutionHostObservation(c, broker, service, execution), notices: unknown[] = [], surfaces = createSurfaceSubscriptions(source, n => notices.push(n));
    try {
        await c.create({ sessionId: 's' });
        const assembly = await service.assemblyFor('s'), action = assembly.managedDocument!.beginAction();
        await action.facts.code.record({ type: 'code/cell', cellId: 'cell', state: 'started' });
        const query = { surface: 'execution', sessionId: 's', requestKey: 'r1:1' }, first = surfaces.subscribe(query);
        expect(surfaces.subscribe(query)).toBe(first);
        const lease = await first;
        const ack = vi.fn();
        surfaces.acknowledge(lease.subscriptionId, ack);
        expect(ack).toHaveBeenCalledWith(lease);
        const reply = await surfaces.snapshot({ subscriptionId: lease.subscriptionId, epoch: lease.stamp.epoch });
        await action.facts.code.record({ type: 'code/output', cellId: 'cell', content: 'new' });
        const sent = vi.fn();
        reply.write(sent);
        expect(sent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reset' }));
        expect(sent.mock.calls[0][0]).not.toHaveProperty('value');
        const next = await surfaces.snapshot({ subscriptionId: lease.subscriptionId, epoch: lease.stamp.epoch });
        next.write(sent);
        expect(sent.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'snapshot', value: { cells: [{ output: [{ text: 'new' }] }] } });
        const originalRead=execution.read,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>()
        const held=vi.spyOn(execution,'read').mockImplementation(async(...args)=>{await args[3]!();entered.resolve();await gate.promise;return originalRead(...args)})
        const reading=surfaces.snapshot({subscriptionId:lease.subscriptionId,epoch:lease.stamp.epoch}),joined=surfaces.snapshot({subscriptionId:lease.subscriptionId,epoch:lease.stamp.epoch})
        await entered.promise
        const otherPage=await surfaces.snapshot({subscriptionId:lease.subscriptionId,epoch:lease.stamp.epoch,offset:10});otherPage.write(sent);expect(sent.mock.calls.at(-1)?.[0].kind).toBe('reset');expect(held).toHaveBeenCalledTimes(1)
        await action.facts.code.record({type:'code/output',cellId:'cell',content:'during original snapshot'});gate.resolve()
        ;(await reading).write(sent);expect(sent.mock.calls.at(-1)?.[0].kind).toBe('reset');(await joined).write(sent);expect(sent.mock.calls.at(-1)?.[0].kind).toBe('reset');held.mockRestore()
        const obsolete = await surfaces.snapshot({ subscriptionId: lease.subscriptionId, epoch: lease.stamp.epoch });
        assembly.managedDocument!.revokeNewWork();
        expect(() => obsolete.write(sent)).toThrow();
        await expect(surfaces.snapshot({ subscriptionId: lease.subscriptionId, epoch: lease.stamp.epoch })).rejects.toThrow();
        action.finish();
        await surfaces.unsubscribe({ subscriptionId: lease.subscriptionId });
        expect(await surfaces.unsubscribe({subscriptionId:lease.subscriptionId})).toEqual({unsubscribed:true})
        expect(notices.length).toBeGreaterThan(0);
    }
    finally {
        await surfaces.close();
        await source.close();
        await service.close();
        await broker.close();
        await c.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('bounds real cold references and idempotency without constructing an assembly, and validates before original reads', async () => {
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'surface-capacity-')), c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract);
    const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), execution = createDesktopExecution(c, service), source = createExecutionHostObservation(c, broker, service, execution), surfaces = createSurfaceSubscriptions(source, () => { });
    const construct = vi.spyOn(service, 'assemblyFor'), subscribe = vi.spyOn(source, 'subscribe');
    try {
        await c.create({ sessionId: 's' });
        await c.releaseOwnership('s');
        const before=await readFile(join(root,'s.jsonl'))
        expect(() => surfaces.subscribe({ surface: 'execution', sessionId: 's', requestKey: 'é'.repeat(65) })).toThrow();
        let evaluated = false;
        expect(() => surfaces.subscribe(Object.defineProperty({ surface: 'execution', sessionId: 's' }, 'requestKey', { enumerable: true, get() { evaluated = true; return 'r1:1'; } }))).toThrow();
        expect(evaluated).toBe(false);
        expect(subscribe).not.toHaveBeenCalled();
        const leases = await Promise.all(Array.from({ length: 32 }, (_, i) => surfaces.subscribe({ surface: 'execution', sessionId: 's', requestKey: 'r1:' + (i + 1) })));
        expect(() => surfaces.subscribe({ surface: 'execution', sessionId: 's', requestKey: 'r1:33' })).toThrow();
        expect(subscribe).toHaveBeenCalledTimes(32);
        for (const lease of leases)
            await surfaces.unsubscribe({ subscriptionId: lease.subscriptionId });
        for (let i = 33; i <= 65; i++) {
            const lease = await surfaces.subscribe({ surface: 'execution', sessionId: 's', requestKey: 'r1:' + i });
            surfaces.acknowledge(lease.subscriptionId, () => { });
            const reply = await surfaces.snapshot({ subscriptionId: lease.subscriptionId, epoch: lease.stamp.epoch });
            reply.write(value => expect(value.kind).toBe('snapshot'));
            await surfaces.unsubscribe({ subscriptionId: lease.subscriptionId });
        }
        expect(() => surfaces.subscribe({ surface: 'execution', sessionId: 's', requestKey: 'r1:1' })).toThrow('obsolete');
        expect(construct).not.toHaveBeenCalled();
        expect(service.liveAssembly('s')).toBeUndefined();
        expect(await readFile(join(root,'s.jsonl'))).toEqual(before)
        const last=await surfaces.subscribe({surface:'execution',sessionId:'s',requestKey:'r1:66'});let selfClose:Promise<void>|undefined
        surfaces.acknowledge(last.subscriptionId,()=>{selfClose=source.close()})
        await expect(selfClose).rejects.toThrow('writer cannot close')
        ;(await surfaces.snapshot({subscriptionId:last.subscriptionId,epoch:last.stamp.epoch})).write(value=>expect(value.kind).toBe('snapshot'))
        const fault=Object.freeze({original:'ACK writer failed'})
        expect(()=>surfaces.acknowledge(last.subscriptionId,()=>{throw fault})).toThrow()
        await expect(surfaces.snapshot({subscriptionId:last.subscriptionId,epoch:last.stamp.epoch})).rejects.toThrow()
        await surfaces.unsubscribe({subscriptionId:last.subscriptionId})
    }
    finally {
        await surfaces.close();
        await source.close();
        await service.close();
        await broker.close();
        await c.close();
        await rm(root, { recursive: true, force: true });
    }
}, 15000);
