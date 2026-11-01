import type { WorkspaceRuntime } from './sdk-runtime.ts';
import type { DesktopEvent } from '../shared/bridge.ts';
import type { SurfaceLease, SurfaceNotice } from '../../../desktop-gateway/src/observation/types.ts';
import { fields, opaque, session, integer } from '../../../desktop-gateway/src/observation/validation.ts';
const connections = new WeakMap<object, {
    next: number;
    tail: Promise<unknown>;
}>();
/** Native window capability; never supplied by renderer input. */
export function createNativeSurfaceObservation(runtimeFor: (id: string) => Promise<WorkspaceRuntime>, current: (id: string) => WorkspaceRuntime | undefined, send: (event: DesktopEvent) => void) {
    type Entry = {
        workspaceId: string;
        runtime: WorkspaceRuntime;
        key: string;
        scope: {
            surface: 'execution';
            sessionId: string;
        };
        lease?: SurfaceLease;
        active: boolean;
        flight: Promise<SurfaceLease>;
        closing?: Promise<void>;
    };
    const entries = new Set<Entry>(), tokens = new Map<string, Entry>(), early = new Map<string, SurfaceNotice>();
    let closed = false, acquisitions = 0;
    let closing:Promise<void>|undefined
    const live = (e: Entry) => { if (closed || !e.active || current(e.workspaceId) !== e.runtime)
        throw Error('Native surface runtime retired'); };
    function release(e: Entry): Promise<void> {
        e.active = false;
        if (e.closing)
            return e.closing;
        const flight = (async () => { await e.flight.catch(() => { }); if (current(e.workspaceId) !== e.runtime) {
            const settled = e.runtime.whenClosed?.();
            if (!settled)
                throw Error('Original surface connection cleanup remains unavailable');
            await settled;
            if (e.lease)
                tokens.delete(e.lease.subscriptionId);
            entries.delete(e);
            return;
        } let lease = e.lease; if (!lease) {
            const connection = connections.get(e.runtime.client)!;
            const flight = connection.tail.then(() => e.runtime.client.request('desktop/surface/subscribe', { ...e.scope, requestKey: e.key },30_000));
            connection.tail = flight.catch(() => { });
            lease = await flight as SurfaceLease;
            e.lease = lease;
        } await e.runtime.client.request('desktop/surface/unsubscribe', { subscriptionId: lease.subscriptionId },30_000); tokens.delete(lease.subscriptionId); entries.delete(e); })();
        e.closing = flight;
        void flight.catch(() => { if (e.closing === flight)
            e.closing = undefined; });
        return flight;
    }
    return {
        async request(raw: unknown): Promise<unknown> {
            const p = fields(raw, ['kind', 'workspaceId', 'sessionId', 'surface', 'subscriptionId', 'epoch', 'offset', 'limit']), workspaceId = session(p.workspaceId);
            if (p.kind === 'desktop/surface/subscribe') {
                if (Object.keys(p).some(k => !['kind', 'workspaceId', 'surface', 'sessionId'].includes(k)) || p.surface !== 'execution' || closed || entries.size + acquisitions >= 32)
                    throw Error('Invalid native surface subscription');
                const id = session(p.sessionId);
                acquisitions++;
                let runtime: WorkspaceRuntime;
                try {
                    runtime = await runtimeFor(workspaceId);
                }
                finally {
                    acquisitions--;
                }
                if (closed || current(workspaceId) !== runtime || !runtime.info.capabilities['desktop-surface-events']?.includes('1'))
                    throw Error('Surface observation unavailable');
                let connection = connections.get(runtime.client);
                if (!connection) {
                    connection = { next: 0, tail: Promise.resolve() };
                    connections.set(runtime.client, connection);
                }
                if (connection.next === Number.MAX_SAFE_INTEGER)
                    throw Error('Surface request keys exhausted');
                const key = 'r1:' + ++connection.next, ready = Promise.withResolvers<SurfaceLease>(), e: Entry = { workspaceId, runtime, key, scope: { surface: 'execution', sessionId: id }, active: true, flight: ready.promise };
                void ready.promise.catch(() => { });
                entries.add(e);
                const issue = async () => { let result: SurfaceLease; try {
                    result = await runtime.client.request('desktop/surface/subscribe', { ...e.scope, requestKey: key },30_000) as SurfaceLease;
                }
                catch (error) {
                    if (!(error instanceof Error) || !error.message.includes('timed out'))
                        throw error;
                    result = await runtime.client.request('desktop/surface/subscribe', { ...e.scope, requestKey: key },30_000) as SurfaceLease;
                } e.lease = result; tokens.set(opaque(result.subscriptionId), e); live(e); if (result.requestKey !== key || result.scope.sessionId !== id)
                    throw Error('Surface acknowledgement mismatch'); const pending = early.get(result.subscriptionId); early.delete(result.subscriptionId); if (pending) {
                    if (pending.stamp.epoch !== result.stamp.epoch)
                        throw Error('Surface epoch mismatch');
                    send({ kind: 'sdk/notification', workspaceId, method: 'desktop/surface/changed', params: pending });
                } return result; };
                const flight = connection.tail.then(issue);
                connection.tail = flight.catch(() => { });
                void flight.then(ready.resolve, error => { e.active = false; ready.reject(error); });
                return ready.promise;
            }
            const token = opaque(p.subscriptionId), e = tokens.get(token);
            if (!e || e.workspaceId !== workspaceId)
                throw Error('Surface window token unavailable');
            if (p.kind === 'desktop/surface/unsubscribe') {
                if (Object.keys(p).some(k => !['kind', 'workspaceId', 'subscriptionId'].includes(k)))
                    throw Error('Invalid surface unsubscribe');
                await release(e);
                return { unsubscribed: true };
            }
            live(e);
            if (p.kind !== 'desktop/surface/snapshot' || Object.keys(p).some(k => !['kind', 'workspaceId', 'subscriptionId', 'epoch', 'offset', 'limit'].includes(k)) || opaque(p.epoch) !== e.lease!.stamp.epoch)
                throw Error('Surface snapshot mismatch');
            const query={ subscriptionId: token, epoch: p.epoch, offset: integer(p.offset, 0, Number.MAX_SAFE_INTEGER, 0), limit: integer(p.limit, 1, 20, 10) }
            let result:unknown
            try{result=await e.runtime.client.request('desktop/surface/snapshot',query,30_000)}catch(error){if(!(error instanceof Error)||!error.message.includes('timed out'))throw error;live(e);result=await e.runtime.client.request('desktop/surface/snapshot',query,30_000)}
            live(e);
            return result;
        },
        event(event: DesktopEvent): boolean {
            if (event.kind === 'sdk/disconnected') {
                for (const e of entries)
                    if (e.workspaceId === event.workspaceId)
                        e.active = false;
                return true;
            }
            if (event.kind !== 'sdk/notification' || event.method !== 'desktop/surface/changed')
                return true;
            const p = fields(event.params, ['subscriptionId', 'stamp', 'kind', 'reason']), stamp = fields(p.stamp, ['epoch', 'revision']);
            opaque(p.subscriptionId);
            opaque(stamp.epoch);
            integer(stamp.revision, 0, Number.MAX_SAFE_INTEGER, 0);
            if (stamp.revision === undefined || !['invalidate', 'reset', 'retired'].includes(String(p.kind)) || (p.reason !== undefined && !['source-unavailable', 'scope-changed', 'owner-retired', 'overflow'].includes(String(p.reason))))
                throw Error('Invalid surface notification');
            const notice = p as SurfaceNotice, e = tokens.get(notice.subscriptionId);
            if (!e) {
                if ([...entries].some(item => item.active && item.workspaceId === event.workspaceId && !item.lease)) {
                    if (!early.has(notice.subscriptionId)&&early.size >= 32)
                        throw Error('Surface early-notice capacity');
                    const previous=early.get(notice.subscriptionId),rank={invalidate:0,reset:1,retired:2}
                    if(!previous||rank[notice.kind]>=rank[previous.kind])early.set(notice.subscriptionId, notice);
                }
                return false;
            }
            live(e);
            if (e.workspaceId !== event.workspaceId || e.lease!.stamp.epoch !== notice.stamp.epoch)
                return false;
            if (notice.kind === 'retired')
                e.active = false;
            return true;
        },
        close():Promise<void> {
            if(closing)return closing
            closed=true;for(const e of entries)e.active=false;early.clear()
            const flight=(async()=>{const outcomes=await Promise.allSettled([...entries].map(release));const errors=outcomes.flatMap(o=>o.status==='rejected'?[o.reason]:[]);if(errors.length)throw new AggregateError(errors,'Native surface cleanup incomplete')})()
            closing=flight;void flight.catch(()=>{if(closing===flight)closing=undefined});return flight
        }
    };
}
