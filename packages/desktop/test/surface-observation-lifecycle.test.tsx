// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useExecutionObservation } from '../src/renderer/observation/use-observation.ts';
import type { DesktopBridge, DesktopEvent } from '../src/shared/bridge.ts';
afterEach(cleanup);
it('retains one native-ready reconnect boundary while an old same-label snapshot is still held',async()=>{
 Object.defineProperty(document,'hidden',{configurable:true,value:false});let listener:(event:DesktopEvent)=>void=()=>{},next=0
 const old=Promise.withResolvers<unknown>(),request=vi.fn(async(p:any):Promise<unknown>=>{if(p.kind==='desktop/capabilities')return {'desktop-surface-events':['1']};if(p.kind==='desktop/surface/subscribe')return {subscriptionId:'s'+ ++next,requestKey:'r1:'+next,scope:{surface:'execution',sessionId:'same'},stamp:{epoch:'e'+next,revision:0}};if(p.kind==='desktop/surface/unsubscribe')return {unsubscribed:true};if(p.subscriptionId==='s1')return old.promise;return {kind:'snapshot',subscriptionId:'s2',stamp:{epoch:'e2',revision:0},value:{sessionId:'same',cells:[{source:'fresh owner',canTerminate:false}]}}})
 const bridge:DesktopBridge={request,onEvent(fn){listener=fn;return()=>{}}}
 function Fixture(){const view=useExecutionObservation(bridge,'w','same',0);return <p>{view.state?.cells[0]?.source}</p>}
 render(<Fixture/>);await waitFor(()=>expect(request.mock.calls.some(([p])=>p.kind==='desktop/surface/snapshot')).toBe(true))
 act(()=>{listener({kind:'sdk/disconnected',workspaceId:'w',message:'old child closed'});listener({kind:'sdk/ready',method:'sdk/ready',workspaceId:'w',runtimeGeneration:1})})
 await act(async()=>{old.resolve({kind:'snapshot',subscriptionId:'s1',stamp:{epoch:'e1',revision:99},value:{sessionId:'same',cells:[{source:'old owner',canTerminate:true}]}})})
 await screen.findByText('fresh owner');expect(screen.queryByText('old owner')).toBeNull();expect(request.mock.calls.filter(([p])=>p.kind==='desktop/capabilities')).toHaveLength(2);expect(request.mock.calls.filter(([p])=>p.kind==='desktop/surface/subscribe')).toHaveLength(2)
})
it('uses one explicit limited read on absent capability and manual refresh, with no live controls or timer fallback',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'hidden',{configurable:true,value:false})
 const request=vi.fn(async(p:any)=>p.kind==='desktop/capabilities'?{}:{sessionId:'s',live:true,cells:[{source:'saved',live:true,canTerminate:true}]}),bridge:DesktopBridge={request,onEvent:()=>()=>{}}
 function Fixture(){const view=useExecutionObservation(bridge,'w','s',0);return <><p>{view.state?.cells[0]?.source}</p><button disabled={!view.state?.cells[0]?.canTerminate}>stop</button><button onClick={()=>void view.refresh()}>refresh</button></>}
 try{await act(async()=>{render(<Fixture/>)});expect(screen.getByText('saved')).toBeTruthy();expect((screen.getByText('stop') as HTMLButtonElement).disabled).toBe(true);expect(request.mock.calls.map(([p])=>p.kind)).toEqual(['desktop/capabilities','desktop/session/execution/read'])
 await act(async()=>{await vi.advanceTimersByTimeAsync(600_000)});expect(request).toHaveBeenCalledTimes(2)
 await act(async()=>{fireEvent.click(screen.getByText('refresh'))});expect(request.mock.calls.map(([p])=>p.kind)).toEqual(['desktop/capabilities','desktop/session/execution/read','desktop/session/execution/read']);expect(vi.getTimerCount()).toBe(0)
 }finally{cleanup();vi.useRealTimers()}
})
it.each(['read-first','mutation-first'] as const)('fences a pre-mutation snapshot and reconciles once with %s settlement without retrying the operation',async order=>{
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 const old=Promise.withResolvers<unknown>(),mutation=Promise.withResolvers<void>();let reads=0
 const lease={subscriptionId:'token',requestKey:'r1:1',scope:{surface:'execution',sessionId:'s'},stamp:{epoch:'epoch',revision:0}}
 const snapshot=(source:string,canTerminate:boolean)=>({kind:'snapshot',subscriptionId:'token',stamp:lease.stamp,value:{sessionId:'s',live:true,cells:[{id:'cell',source,canTerminate}]}})
 const request=vi.fn(async(p:any)=>{if(p.kind==='desktop/capabilities')return {'desktop-surface-events':['1']};if(p.kind==='desktop/surface/subscribe')return lease;if(p.kind==='desktop/surface/unsubscribe')return {unsubscribed:true};if(++reads===2)return old.promise;return reads===1?snapshot('initial',true):snapshot('after',false)})
 const run=vi.fn(()=>mutation.promise),bridge:DesktopBridge={request,onEvent:()=>()=>{}}
 function Fixture(){const view=useExecutionObservation(bridge,'w','s',0);return <><p>{view.state?.cells[0]?.source}</p><button onClick={()=>void view.refresh()}>refresh</button><button disabled={!view.state?.cells[0]?.canTerminate} onClick={()=>void view.act(run)}>stop</button></>}
 render(<Fixture/>);await screen.findByText('initial');fireEvent.click(screen.getByText('refresh'));await waitFor(()=>expect(reads).toBe(2));fireEvent.click(screen.getByText('stop'))
 if(order==='mutation-first')await act(async()=>{mutation.resolve()})
 await act(async()=>{old.resolve(snapshot('obsolete',true))});expect((screen.getByText('stop') as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText('obsolete')).toBeNull()
 if(order==='read-first')await act(async()=>{mutation.resolve()});await screen.findByText('after');expect(run).toHaveBeenCalledTimes(1);expect(reads).toBe(3)
})
it('refuses late scope/epoch responses, releases hidden leases and reconnects only from native ready', async () => {
    let listener: (event: DesktopEvent) => void = () => { }, next = 0, hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const old = Promise.withResolvers<unknown>(), leases = new Map<string, any>();
    const request = vi.fn(async (p: any): Promise<unknown> => { if(p.kind==='desktop/capabilities')return {'desktop-surface-events':['1']};
        if (p.kind === 'desktop/surface/subscribe') {
            const lease = { subscriptionId: 's' + ++next, requestKey: 'r1:' + next, scope: { surface: 'execution', sessionId: p.sessionId }, stamp: { epoch: 'e' + next, revision: 0 } };
            leases.set(lease.subscriptionId, lease);
            return lease;
        }
        if (p.kind === 'desktop/surface/unsubscribe')
            return { unsubscribed: true };
        const lease = leases.get(p.subscriptionId);
        if (lease.subscriptionId === 's1')
            return old.promise;
        return { kind: 'snapshot', subscriptionId: lease.subscriptionId, stamp: lease.stamp, value: { sessionId: lease.scope.sessionId, live: true, cells: [{ id: 'cell', source: lease.subscriptionId, canTerminate: true, live: true }] } };
    });
    const bridge: DesktopBridge = { request, onEvent(fn) { listener = fn; return () => { listener = () => { }; }; } };
    function Fixture({ id }: {
        id: string;
    }) { const view = useExecutionObservation(bridge, 'w', id, 0); return <><p>{view.state?.cells[0]?.source}</p><button disabled={!view.state?.cells[0]?.canTerminate} onClick={() => void view.refresh()}>refresh</button><p>{view.error}</p></>; }
    const view = render(<Fixture id="original"/>);
    await waitFor(() => expect(request.mock.calls.some(([p]) => p.kind === 'desktop/surface/snapshot')).toBe(true));
    view.rerender(<Fixture id="other"/>);
    await screen.findByText('s2');
    await act(async () => { old.resolve({ kind: 'snapshot', subscriptionId: 's1', stamp: { epoch: 'e1', revision: 99 }, value: { cells: [{ source: 'stale', canTerminate: true }] } }); });
    expect(screen.queryByText('stale')).toBeNull();
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: 'desktop/surface/unsubscribe', workspaceId: 'w', subscriptionId: 's2' }));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    const before = request.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(request.mock.calls).toHaveLength(before);
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await screen.findByText('s3');
    act(() => listener({ kind: 'sdk/disconnected', workspaceId: 'w', message: 'offline' }));
    await screen.findByText('offline');
    const offline = request.mock.calls.filter(([p]) => p.kind === 'desktop/surface/subscribe').length;
    act(() => listener({ kind: 'sdk/notification', workspaceId: 'w', method: 'session/status', params: {} }));
    expect(request.mock.calls.filter(([p]) => p.kind === 'desktop/surface/subscribe')).toHaveLength(offline);
    act(() => listener({ kind: 'sdk/ready', method: 'sdk/ready', workspaceId: 'w', runtimeGeneration: 1 }));
    await screen.findByText('s4');
    const baseline = request.mock.calls.length;
    act(() => listener({ kind: 'sdk/notification', workspaceId: 'w', method: 'desktop/surface/changed', params: { subscriptionId: 's4', stamp: { epoch: 'e1', revision: 100 }, kind: 'retired' } }));
    expect(request.mock.calls).toHaveLength(baseline);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
    await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: 'desktop/surface/unsubscribe', workspaceId: 'w', subscriptionId: 's4' }));
});
