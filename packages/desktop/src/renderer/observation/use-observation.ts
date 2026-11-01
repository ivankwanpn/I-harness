import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, DesktopEvent } from '../../shared/bridge.ts';
import type { DesktopExecutionView } from '../../../../desktop-gateway/src/execution.ts';
import type { SurfaceLease, SurfaceNotice, ExecutionSurfaceSnapshot } from '../../../../desktop-gateway/src/observation/types.ts';
/** One mounted execution scope, one retained lease and finite catch-up. */
export function useExecutionObservation(bridge: Pick<DesktopBridge, 'request'> & Partial<Pick<DesktopBridge, 'onEvent'>>, workspaceId: string, sessionId: string, offset: number, resetPage?: () => void) {
    const [state, setState] = useState<DesktopExecutionView>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
    const generation = useRef(0), writeTicket = useRef(0), refreshRef = useRef<(afterMutation?:boolean) => Promise<void>>(async () => { }), pending = useRef(false);
    const resetRef = useRef(resetPage);
    resetRef.current = resetPage;
    useEffect(() => {
        const current = ++generation.current;
        pending.current=false;setBusy(false);writeTicket.current++
        let stopped = false, offline = false, lease: SurfaceLease | undefined, subscribing: Promise<void> | undefined, reading: Promise<void> | undefined, dirty = false, early: SurfaceNotice | undefined, latest = 0;
        let negotiated=false,limited=false,connectionTicket=0,reconnect=false,lastReset=-1,mutationBoundary=false
        const valid = () => !stopped && generation.current === current && !offline && !document.hidden;
        const unsafe = () => setState(value => value ? { ...value, cells: value.cells.map(cell => ({ ...cell, canTerminate: false, live: false })) } : value);
        const failure = (reason: unknown) => { if (!stopped) {
            unsafe();
            setError(reason instanceof Error ? reason.message : String(reason));
        } };
        const release = async () => { const owned = lease; lease = undefined; if (owned)
            await bridge.request({ kind: 'desktop/surface/unsubscribe', workspaceId, subscriptionId: owned.subscriptionId }); };
        const notice = (value: SurfaceNotice) => {
            if (!lease) {
                if (!early || ({ invalidate: 0, reset: 1, retired: 2 }[value.kind] >= ({ invalidate: 0, reset: 1, retired: 2 }[early.kind])))
                    early = value;
                return;
            }
            if (value.subscriptionId !== lease.subscriptionId || value.stamp.epoch !== lease.stamp.epoch || value.stamp.revision < latest || (value.stamp.revision===latest&&value.kind==='invalidate') || (value.kind==='reset'&&value.stamp.revision<=lastReset))
                return;
            if(value.kind==='reset')lastReset=value.stamp.revision
            if (value.kind === 'reset' || value.stamp.revision > latest + 1) {
                if(offset!==0)writeTicket.current++;
                resetRef.current?.();
            }
            latest = value.stamp.revision;
            unsafe();
            dirty = true;
            if (value.kind === 'retired') {
                failure(Error('Execution source unavailable; refresh to authorize again'));
                void release().catch(failure);
                return;
            }
            if (!pending.current)
                void refresh();
        };
        async function acquire() {
            if (lease || subscribing || (negotiated&&limited) || !valid())
                return subscribing;
            const connection=connectionTicket
            subscribing = (async () => {
                if(!negotiated){const capabilities=await bridge.request({kind:'desktop/capabilities',workspaceId}) as Record<string,unknown>;if(!valid()||connection!==connectionTicket)return;const versions=capabilities['desktop-surface-events'];limited=!Array.isArray(versions)||!versions.includes('1');negotiated=true}
                if(limited)return
                if(!bridge.onEvent)throw Error('Execution observation unavailable')
                const result = await bridge.request({ kind: 'desktop/surface/subscribe', workspaceId, sessionId, surface: 'execution' }) as SurfaceLease;
                if (!valid()||connection!==connectionTicket) {
                    await bridge.request({ kind: 'desktop/surface/unsubscribe', workspaceId, subscriptionId: result.subscriptionId });
                    return;
                }
                if (result.scope.sessionId !== sessionId || result.scope.surface !== 'execution')
                    throw Error('Execution scope mismatch');
                lease = result;
                lastReset=-1
                latest = result.stamp.revision;
                if (early) {
                    const captured = early;
                    early = undefined;
                    notice(captured);
                }
            })();
            try {
                await subscribing;
            }
            finally {
                subscribing = undefined;
            }
        }
        async function refresh(afterMutation=false) {
            dirty = true;
            if(afterMutation&&reading)mutationBoundary=true
            if (reading || pending.current || !valid())
                return reading;
            const connection=connectionTicket
            reading = (async () => {
                try {
                    await acquire();
                    if(!valid()||connection!==connectionTicket)return
                    if(limited){dirty=false;const value=await bridge.request({kind:'desktop/session/execution/read',workspaceId,sessionId,offset,limit:10}) as DesktopExecutionView;if(valid()&&connection===connectionTicket){setState({...value,live:false,cells:value.cells.map(cell=>({...cell,live:false,canTerminate:false}))});setError('Limited inspection; live controls require execution observation.')}return}
                    for (let follow = 0; follow < 2 && dirty && valid() && lease; follow++) {
                        dirty = false;
                        const ticket = writeTicket.current, owned = lease, result = await bridge.request({ kind: 'desktop/surface/snapshot', workspaceId, subscriptionId: owned.subscriptionId, epoch: owned.stamp.epoch, offset, limit: 10 }) as ExecutionSurfaceSnapshot;
                        if (!valid() || lease !== owned||connection!==connectionTicket)
                            return;
                        if (ticket !== writeTicket.current) {
                            dirty = true;
                            return;
                        }
                        if (result.subscriptionId !== owned.subscriptionId || result.stamp.epoch !== owned.stamp.epoch)
                            throw Error('Execution snapshot scope mismatch');
                        if (result.kind === 'snapshot' && result.stamp.revision >= latest) {
                            latest = result.stamp.revision;
                            setState(result.value);
                            setError(undefined);
                        }
                        else {
                            unsafe();
                            dirty = result.kind === 'reset';
                            if (result.kind === 'unavailable')
                                throw Error('Execution source unavailable');
                        }
                    }
                    if(dirty&&valid()&&!pending.current)failure(Error('Execution is updating; refresh after the next change.'))
                }
                catch (reason) {
                    if(connection===connectionTicket)failure(reason);
                }
            })();
            try {
                await reading;
            }
            finally {
                reading = undefined;
                if((reconnect||mutationBoundary)&&valid()&&!pending.current){reconnect=false;mutationBoundary=false;void refresh()}
            }
        }
        refreshRef.current = refresh;
        const off = bridge.onEvent?.((event: DesktopEvent) => {
            if (event.kind === 'sdk/disconnected' && event.workspaceId === workspaceId) {
                offline = true;
                connectionTicket++;negotiated=false;limited=false;early=undefined
                unsafe();
                void release().catch(failure);
                failure(Error(event.message));
            }
            else if (event.kind === 'sdk/ready' && event.workspaceId === workspaceId) {
                const replacing=offline||negotiated||!!lease
                if(replacing){connectionTicket++;negotiated=false;limited=false;early=undefined;unsafe();void release().catch(failure)}
                offline = false;
                if(reading){if(replacing)reconnect=true;return}
                void refresh();
            }
            else if (event.kind === 'sdk/notification' && event.workspaceId === workspaceId && event.method === 'desktop/surface/changed')
                notice(event.params as SurfaceNotice);
        });
        const visibility = () => { if (document.hidden) {
            unsafe();
            void release().catch(failure);
        }
        else
            void refresh(); };
        document.addEventListener('visibilitychange', visibility);
        setState(undefined);
        setError(undefined);
        void refresh();
        return () => { stopped = true; generation.current++; off?.(); document.removeEventListener('visibilitychange', visibility); void release().catch(() => { }); };
    }, [bridge, workspaceId, sessionId, offset]);
    async function act(run: () => Promise<unknown>, after?: (value: unknown) => void) {
        if (pending.current)
            return false;
        pending.current = true;
        writeTicket.current++;
        setBusy(true);
        const ticket = generation.current;
        setState(value => value ? { ...value, cells: value.cells.map(cell => ({ ...cell, canTerminate: false })) } : value);
        try {
            const result = await run();
            if (ticket !== generation.current)
                return false;
            after?.(result);
            return true;
        }
        catch (reason) {
            if (ticket === generation.current)
                setError(reason instanceof Error ? reason.message : String(reason));
            return false;
        }
        finally {
            if (ticket === generation.current) {
                pending.current = false;
                setBusy(false);
                await refreshRef.current(true);
            }
        }
    }
    return { state, error, busy, refresh: () => refreshRef.current(), act, generation };
}
