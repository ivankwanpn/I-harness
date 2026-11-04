import { randomUUID } from 'node:crypto';
import type { createExecutionHostObservation } from '../execution-host-observation.ts';
import type { ExecutionSurfaceQuery, SurfaceLease, SurfaceNotice, ExecutionSurfaceSnapshot, SurfaceStamp } from './types.ts';
import { fields, opaque, session, integer } from './validation.ts';
type Source = ReturnType<typeof createExecutionHostObservation>;
type PrivateLease = Awaited<ReturnType<Source['subscribe']>>;
/** One original Gateway connection owns this bounded consumer ledger. */
export function createSurfaceSubscriptions(source: Source, notify: (notice: SurfaceNotice) => void) {
    type Entry = {
        id: string;
        key: string;
        scope: ExecutionSurfaceQuery;
        lease?: PrivateLease;
        admitted?: SurfaceLease;
        flight: Promise<SurfaceLease>;
        stamp: SurfaceStamp;
        active: boolean;
        ack: boolean;
        pending?: SurfaceNotice;
        reading?: {
            page: string;
            flight: Promise<ExecutionSurfaceSnapshot>;
        };
        closing?: Promise<void>;
    };
    const entries = new Map<string, Entry>(), keys = new Map<string, Entry>();
    // Request keys whose acquisition failed. A retry with the same key (the
    // client's idempotency contract) must be able to start a fresh attempt, and
    // a failed attempt must not occupy one of the 32 live slots forever.
    const failedKeys = new Set<string>();
    let closed = false, high = 0;
    let closing:Promise<void>|undefined
    const publish = (entry: Entry, notice: SurfaceNotice) => {
        if (!entry.active && notice.kind !== 'retired')
            return;
        entry.stamp = notice.stamp;
        const rank = { invalidate: 0, reset: 1, retired: 2 };
        if (!entry.pending || rank[notice.kind] >= rank[entry.pending.kind])
            entry.pending = notice;
        if (!entry.ack)
            return;
        const next = entry.pending;
        entry.pending = undefined;
        try {
            notify(next);
        }
        catch (error) {
            entry.active = false;
            throw error;
        }
    };
    const check = (entry: Entry) => { if (closed || !entry.active || !entry.lease)
        throw Error('Surface owner retired'); };
    async function release(entry: Entry) { entry.active = false; await entry.flight.catch(() => { }); await entry.lease?.close(); entries.delete(entry.id); }
    function closeEntry(entry: Entry) { if (entry.closing)
        return entry.closing; const flight = release(entry); entry.closing = flight; void flight.catch(() => { if (entry.closing === flight)
        entry.closing = undefined; }); return flight; }
    function lookup(raw: unknown, allowed: readonly string[], released = false) { const p = fields(raw, allowed), id = opaque(p.subscriptionId), entry = entries.get(id) ?? (released ? [...keys.values()].find(item => item.id === id) : undefined); if (!entry)
        throw Error('Unknown surface lease'); return { p, entry }; }
    return {
        subscribe(raw: unknown): Promise<SurfaceLease> {
            const p = fields(raw, ['requestKey', 'surface', 'sessionId']), key = opaque(p.requestKey), id = session(p.sessionId);
            if (p.surface !== 'execution' || closed)
                throw Error('Surface observation unavailable');
            const match = /^r1:([1-9][0-9]*)$/.exec(key), sequence = match ? Number(match[1]) : NaN;
            if (!Number.isSafeInteger(sequence))
                throw Error('Invalid surface request key');
            const prior = keys.get(key);
            if (prior) {
                if (prior.scope.sessionId !== id)
                    throw Error('Conflicting surface request');
                return prior.flight;
            }
            if (sequence < high || (sequence === high && !failedKeys.has(key)) || entries.size >= 32)
                throw Error('Surface capacity or obsolete request');
            high = Math.max(high, sequence);
            if (keys.size >= 64) {
                const old = [...keys].find(([, item]) => !entries.has(item.id));
                if (!old)
                    throw Error('Surface idempotency capacity');
                keys.delete(old[0]);
                failedKeys.delete(old[0]);
            }
            const ready = Promise.withResolvers<SurfaceLease>(), entry: Entry = { id: randomUUID(), key, scope: { surface: 'execution', sessionId: id }, flight: ready.promise, stamp: { epoch: 'pending', revision: 0 }, active: true, ack: false };
            void ready.promise.catch(() => { });
            entries.set(entry.id, entry);
            keys.set(key, entry);
            // A failed acquisition releases its slot and its idempotency record:
            // the same requestKey may retry, and the 32-slot budget is not leaked.
            const fail = (error: unknown) => {
                if (entry.admitted) return;
                if (entry.active) { entry.active = false; failedKeys.add(key) }
                if (keys.get(key) === entry) keys.delete(key);
                entries.delete(entry.id);
                ready.reject(error);
            };
            void source.subscribe(id, notice => { if (!entry.active)
                return; if (notice.kind === 'retired')
                entry.active = false; publish(entry, { subscriptionId: entry.id, stamp: { epoch: notice.epoch, revision: notice.revision }, kind: notice.kind }); }).then(lease => {
                entry.lease = lease;
                if (closed || !entry.active) {
                    fail(Error('Surface retired during acquisition'));
                    return;
                }
                lease.withCurrent(stamp => { entry.stamp = stamp;entry.admitted={ subscriptionId: entry.id, requestKey: key, scope: entry.scope, stamp }; failedKeys.delete(key); ready.resolve(entry.admitted); });
            }, fail).catch(fail);
            return ready.promise;
        },
        acknowledge(id: string, write: (lease: SurfaceLease) => void) { const entry = entries.get(opaque(id)); if (!entry)
            throw Error('Unknown surface lease'); check(entry); entry.lease!.withCurrent(stamp => { entry.stamp = stamp; write(entry.admitted!); entry.ack = true;if(stamp.revision!==entry.admitted!.stamp.revision)publish(entry,{subscriptionId:entry.id,stamp,kind:'reset'}); }); if (entry.pending)
            publish(entry, entry.pending); },
        async snapshot(raw: unknown): Promise<{
            write(send: (value: ExecutionSurfaceSnapshot) => void): void;
        }> {
            const { p, entry } = lookup(raw, ['subscriptionId', 'epoch', 'offset', 'limit']);
            check(entry);
            if (opaque(p.epoch) !== entry.lease!.epoch)
                throw Error('Stale surface epoch');
            const page = { offset: integer(p.offset, 0, Number.MAX_SAFE_INTEGER, 0), limit: integer(p.limit, 1, 20, 10) }, identity = JSON.stringify(page);
            let result: ExecutionSurfaceSnapshot;
            if (entry.reading && entry.reading.page !== identity)
                result = { kind: 'reset', subscriptionId: entry.id, stamp: entry.stamp };
            else {
                if (!entry.reading) {
                    const flight = entry.lease!.snapshot(page).then(value => ({ kind: value.kind, subscriptionId: entry.id, stamp: { epoch: value.epoch, revision: value.revision }, ...value.kind === 'snapshot' ? { value: value.value } : {} } as ExecutionSurfaceSnapshot));
                    entry.reading = { page: identity, flight };
                    void flight.finally(() => { if (entry.reading?.flight === flight)
                        entry.reading = undefined; }).catch(() => { });
                }
                result = await entry.reading.flight;
            }
            return { write(send) { check(entry); entry.lease!.withCurrent(stamp => send(stamp.revision === result.stamp.revision ? result : { kind: 'reset', subscriptionId: entry.id, stamp })); } };
        },
        async unsubscribe(raw: unknown) { const { entry } = lookup(raw, ['subscriptionId'], true); await closeEntry(entry); return { unsubscribed: true as const }; },
        close():Promise<void> {
            if(closing)return closing
            closed=true;for(const entry of entries.values())entry.active=false
            const flight=(async()=>{const outcomes=await Promise.allSettled([...entries.values()].map(closeEntry));const errors=outcomes.flatMap(o=>o.status==='rejected'?[o.reason]:[]);if(errors.length)throw new AggregateError(errors,'Surface cleanup incomplete')})()
            closing=flight;void flight.catch(()=>{if(closing===flight)closing=undefined});return flight
        }
    };
}
