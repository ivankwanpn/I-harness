// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { act, render, cleanup, fireEvent } from '@testing-library/react';
const electron = vi.hoisted(() => ({ bridge: undefined as any, invoke: undefined as any, listeners: new Set<(...args: any[]) => void>() }));
const io = vi.hoisted(() => ({ reads: 0, scans: 0, opens: 0 }));
vi.mock('node:fs/promises', async (original) => {
    const fs = await original<typeof import('node:fs/promises')>();
    return { ...fs,
        readFile: (...args: Parameters<typeof fs.readFile>) => { io.reads++; return fs.readFile(...args); },
        readdir: (...args: Parameters<typeof fs.readdir>) => { io.scans++; return fs.readdir(...args); },
        open: (...args: Parameters<typeof fs.open>) => { io.opens++; return fs.open(...args); }
    };
});
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_name: string, bridge: unknown) { electron.bridge = bridge; } }, ipcRenderer: { invoke(...args: any[]) { return electron.invoke(...args); }, on(_channel: string, listener: any) { electron.listeners.add(listener); }, removeListener(_channel: string, listener: any) { electron.listeners.delete(listener); } } }));
it.each(['healthy','lost-ACK'] as const)('mounts actual source/router/SDK/runtime/native IPC/preload/ExecutionPane with %s and stays silent for ten healthy minutes', async mode => {
    let hidden=false
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden})

    let stage=0;async function finite<T>(work: Promise<T>): Promise<T> { const step=++stage, started=process.hrtime.bigint();let done = false; const result = work.finally(() => { done = true; }); void result.catch(() => { }); while (!done) { if(Number(process.hrtime.bigint()-started)/1e9>10)throw Error(`Connected fixture stalled at stage ${step}`);
        await new Promise(resolve => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(0);
    } return result; }
    async function sequence<T extends readonly unknown[]>(loaders: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> { const values: unknown[] = []; for (const load of loaders) values.push(await load()); return values as unknown as T; }
    let close = async () => { };
    try {
        const [{ mkdtemp, rm }, { join }, { PassThrough }, sdk, { createSdkServer }, { createJsonlBackend }, { composeJsonlTaskTransitionCoordinator }, { taskDocumentStorageContract }, { createSessionService }, { createProjectScopeBroker }, { createDesktopExecution }, { createExecutionHostObservation }, { createDesktopRouter, createGatewayWrite }, { createWorkspaceRuntimeManager }, { registerDesktopIpc }, { ExecutionPane }] = await sequence([()=>import('node:fs/promises'), ()=>import('node:path'), ()=>import('node:stream'), ()=>import('@i-harness/sdk'), ()=>import('@i-harness/sdk/server'), ()=>import('../../session-persistence-jsonl/src/index.ts'), ()=>import('../../session-persistence-jsonl/src/task-document-factory.ts'), ()=>import('../../subagent/src/task/storage-contract.ts'), ()=>import('../../session-executor/src/index.ts'), ()=>import('../../desktop-gateway/src/project-scope.ts'), ()=>import('../../desktop-gateway/src/execution.ts'), ()=>import('../../desktop-gateway/src/execution-host-observation.ts'), ()=>import('../../desktop-gateway/src/router.ts'), ()=>import('../src/main/sdk-runtime.ts'), ()=>import('../src/main/ipc.ts'), ()=>import('../src/renderer/session/ExecutionPane.tsx')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'mounted-source-')), c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract);
        let models = 0;
        const service = createSessionService({ workspace: root, coordinator: c, model: { async *stream() { models++; yield { type: 'end' as const }; } } }), broker = createProjectScopeBroker(c, root), execution = createDesktopExecution(c, service), source = createExecutionHostObservation(c, broker, service, execution);
        await finite(c.create({ sessionId: 's' }));
        const assembly = await finite(service.assemblyFor('s')), action = assembly.managedDocument!.beginAction();
        await finite(action.facts.code.record({ type: 'code/cell', cellId: 'cell', state: 'started', source: 'original managed cell' }));
        let dropped=false;const ackDropped=Promise.withResolvers<void>(),subscriptions=vi.spyOn(source,'subscribe')
        const input = new PassThrough(), output = new PassThrough(), client = new sdk.HarnessClient(output, input), send = (frame: any) => {if(mode==='lost-ACK'&&!dropped&&frame.result?.requestKey){dropped=true;ackDropped.resolve();return true}return output.write(sdk.encodeFrame(frame))}, handlers = { execution, executionObservation: source }, base = createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), router = createDesktopRouter(base, send, handlers);
        input.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) {
            void router.handleLine(line).then(async () => {
                if (JSON.parse(line).method === 'shutdown') {
                    await router.close(); output.end(); exited.resolve();
                }
            });
        } });
        const workspace = { id: 'w', label: 'fixture', path: root }, exited = Promise.withResolvers<void>(), runtimes = createWorkspaceRuntimeManager({ sessionsRoot: root, launch: () => ({ client, exited: exited.promise }) });
        const requests = vi.spyOn(client, 'request'), reads = vi.spyOn(execution, 'read'), profiles = vi.spyOn(c, 'profile'), snapshots = vi.spyOn(c as typeof c & {
            snapshot: NonNullable<typeof c.snapshot>;
        }, 'snapshot'), assemblies = vi.spyOn(service, 'assemblyFor');
        let holdNextSnapshot=false,heldReply:any;const responseHeld=Promise.withResolvers<any>(),noticeReached=Promise.withResolvers<void>(),resumeReply=Promise.withResolvers<void>(),order:string[]=[]
        const window = { isDestroyed: () => false, webContents: { send(_channel: string, event: any) {
                if(heldReply&&event.kind==='sdk/notification'&&event.method==='desktop/surface/changed'&&event.params.stamp.revision>heldReply.stamp.revision){order.push('notice after response');noticeReached.resolve()}
                for (const listener of electron.listeners)listener({}, event);
            } } }, ipc = { handle(_channel: string, listener: any) { electron.invoke = async(_name: string, request: any) => {
                const result=await listener({ sender: window.webContents }, request)
                if(holdNextSnapshot&&request.kind==='desktop/surface/snapshot'){holdNextSnapshot=false;heldReply=result;order.push('authorized response');responseHeld.resolve(result);await resumeReply.promise;heldReply=undefined;order.push('consumer continuation')}
                return result
            }; }, removeHandler() { } };
        const unregister = registerDesktopIpc(window as never, { catalog: { get: (id: string) => id === 'w' ? workspace : undefined } as never, runtimes }, ipc);
        await import('../src/preload/index.ts');
        close = async () => { resumeReply.resolve();cleanup(); action.finish(); await source.close(); await router.close(); exited.resolve(); await unregister(); await broker.close(); await c.close(); await client.close(); await runtimes.close(); input.destroy(); output.destroy(); await rm(root, { recursive: true, force: true }); };
        const mounted = render(<ExecutionPane bridge={electron.bridge} workspaceId="w" sessionId="s"/>);
        if(mode==='lost-ACK'){
            await finite(ackDropped.promise)
            await finite(action.facts.code.record({type:'code/output',cellId:'cell',content:'before first snapshot, while ACK was lost'}))
            await act(async()=>{await vi.advanceTimersByTimeAsync(30_000)})
        }
        await finite((async () => { for (let i = 0; i < 1000 && !mounted.container.textContent?.includes('original managed cell'); i++)
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); })());
        expect(mounted.container.textContent).toContain('original managed cell');
        expect(requests.mock.calls.some(([method]) => method === 'desktop/surface/subscribe')).toBe(true);
        if(mode==='lost-ACK'){expect(requests.mock.calls.filter(([method])=>method==='desktop/surface/subscribe').map(([,params])=>(params as {requestKey:string}).requestKey)).toEqual(['r1:1','r1:1']);expect(subscriptions).toHaveBeenCalledTimes(1)}
        await act(async () => { await finite(action.facts.code.record({ type: 'code/output', cellId: 'cell', content: { type: 'text', text: 'connected output' } })); await finite((async () => { while (reads.mock.calls.length < 2)
            await new Promise(resolve => setImmediate(resolve)); })()); });
        fireEvent.click(mounted.getByRole('tab',{name:'輸出'}))
        await finite((async()=>{for(let i=0;i<1000&&!mounted.container.textContent?.includes('connected output');i++)await act(async()=>{await new Promise(resolve=>setImmediate(resolve))})})())
        expect(mounted.container.textContent).toContain('connected output')
        const queue=service.queueState('s')
        await act(async()=>{
            await finite(action.facts.code.record({type:'code/cell',cellId:'later',state:'started',source:'second actual managed cell'}))
            await finite(action.facts.code.record({type:'code/call',cellId:'cell',callId:'nested',name:'fixture-call',args:{path:'fixture'}}))
            await finite(action.facts.code.record({type:'code/result',cellId:'cell',callId:'nested',name:'fixture-call',output:'connected nested result'}))
        })
        fireEvent.click(mounted.getByRole('tab',{name:'巢狀呼叫'}))
        await finite((async()=>{for(let i=0;i<1000&&!mounted.container.textContent?.includes('connected nested result');i++)await act(async()=>{await new Promise(resolve=>setImmediate(resolve))})})())
        expect(mounted.container.textContent).toContain('connected nested result');expect(service.queueState('s')).toEqual(queue)
        fireEvent.click(mounted.getByRole('tab',{name:'程式'}));expect(mounted.container.textContent).toContain('second actual managed cell')
        fireEvent.click(mounted.getByRole('tab',{name:'輸出'}))
        const priorReads=reads.mock.calls.length;holdNextSnapshot=true;fireEvent.click(mounted.getByRole('button',{name:'重新整理'}))
        const originalResponse=await finite(responseHeld.promise);expect(originalResponse.kind).toBe('snapshot')
        await finite(action.facts.code.record({type:'code/output',cellId:'cell',content:'newer than held renderer response'}));await finite(noticeReached.promise)
        await act(async()=>{resumeReply.resolve()})
        await finite((async()=>{for(let i=0;i<1000&&!mounted.container.textContent?.includes('newer than held renderer response');i++)await act(async()=>{await new Promise(resolve=>setImmediate(resolve))})})())
        expect(order).toEqual(['authorized response','notice after response','consumer continuation']);expect(mounted.container.textContent).toContain('newer than held renderer response');expect(reads.mock.calls.length-priorReads).toBe(2)
        // Runtime health owns one heartbeat. The mounted observation adds no poller.
        expect(vi.getTimerCount()).toBe(1)
        const counts = [requests.mock.calls.filter(([method]) => method !== 'ping').length, reads.mock.calls.length, profiles.mock.calls.length, snapshots.mock.calls.length, assemblies.mock.calls.length];
        io.reads = 0;
        io.scans = 0;
        io.opens = 0;
        await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
        expect([requests.mock.calls.filter(([method]) => method !== 'ping').length, reads.mock.calls.length, profiles.mock.calls.length, snapshots.mock.calls.length, assemblies.mock.calls.length]).toEqual(counts);
        expect(io).toEqual({ reads: 0, scans: 0, opens: 0 });
        expect(models).toBe(0);
        expect(vi.getTimerCount()).toBe(1);
        await act(async()=>{hidden=true;document.dispatchEvent(new Event('visibilitychange'));await finite((async()=>{while(!requests.mock.calls.some(([method])=>method==='desktop/surface/unsubscribe'))await new Promise(resolve=>setImmediate(resolve))})())})
        const released=requests.mock.calls.findIndex(([method])=>method==='desktop/surface/unsubscribe')
        await finite(requests.mock.results[released]!.value)
        const hiddenReads=reads.mock.calls.length
        await act(async()=>{await vi.advanceTimersByTimeAsync(600_000)})
        expect(reads.mock.calls).toHaveLength(hiddenReads)
        await act(async()=>{hidden=false;document.dispatchEvent(new Event('visibilitychange'));await finite((async()=>{while(reads.mock.calls.length===hiddenReads)await new Promise(resolve=>setImmediate(resolve))})())})
        const fail = () => { throw Error('original window forwarding failed'); };
        electron.listeners.add(fail);
        await act(async () => { expect((await finite(action.facts.code.record({ type: 'code/output', cellId: 'cell', content: 'late changed' }))).kind).toBe('committed'); await finite((async () => { while (runtimes.peek!('w'))
            await new Promise(resolve => setImmediate(resolve)); })()); });
        electron.listeners.delete(fail);
        expect(runtimes.peek!('w')).toBeUndefined();
        expect(mounted.container.textContent).toContain('Project execution scope changed');
        mounted.unmount();
        await finite(Promise.resolve());
        expect(requests.mock.calls.some(([method]) => method === 'desktop/surface/unsubscribe')).toBe(true);
    }
    finally {
        await finite(close());
        vi.useRealTimers();
    }
}, 75000);
