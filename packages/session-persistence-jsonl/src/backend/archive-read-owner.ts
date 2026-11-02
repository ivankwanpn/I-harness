import { AsyncLocalStorage } from 'node:async_hooks';
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { ArchiveReadResources } from '@i-harness/session-persistence/internal/archive-read';
type Resource = {
    handle: FileHandle;
    close: () => Promise<void>;
    failed: boolean;
    error?: unknown;
    consumed: boolean;
    flight?: Promise<void>;
};
/** Original per-backend ledger. Failed descriptors remain reachable after caller rejection. */
export function createArchiveReadOwner() {
    const resources = new Set<Resource>(), pending = new Set<Promise<unknown>>(), participants = new Set<{
        closed: boolean;
    }>();
    let retired = false;
    // Only the original coordinator's transition closure installs this finite,
    // exact-session scope. It does not reopen public or managed read admission.
    const mutationReads = new AsyncLocalStorage<{ sessionId: string; active: boolean }>();
    function admission() { if (retired || [...resources].some(r => r.failed))
        throw Error('ARCHIVE_READ_UNAVAILABLE'); }
    async function close(r: Resource) {
        if (!resources.has(r))
            return;
        if (r.flight)
            return r.flight;
        if (r.consumed)
            throw r.error;
        const flight = (async () => { try {
            await r.close();
            resources.delete(r);
        }
        catch (error) {
            r.failed = true;
            r.error = error;
            r.consumed = r.handle.fd < 0;
            throw error;
        } })();
        r.flight = flight;
        try {
            await flight;
        }
        finally {
            if (r.flight === flight)
                r.flight = undefined;
        }
    }
    async function settle() { while (pending.size)
        await Promise.allSettled([...pending]); const results = await Promise.allSettled([...resources].map(close)); const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []); if (errors.length)
        throw new AggregateError(errors, 'Archive read cleanup unresolved'); }
    const association: ArchiveReadResources = { attach() { const p = { closed: false }; participants.add(p); if (![...resources].some(r => r.failed) && [...participants].every(p => !p.closed))
            retired = false; return { async withMutationRead<T>(sessionId: string, work: () => Promise<T>) {
                const scope = { sessionId, active: true };
                return mutationReads.run(scope, async () => { try { return await work(); } finally { scope.active = false; } });
            }, assertPublicReadAdmission() { if (p.closed) throw Error('ARCHIVE_READ_UNAVAILABLE'); admission(); }, fence() { p.closed = true; retired = true; }, async settle() { await settle(); participants.delete(p); if (participants.size > 0 && [...participants].every(p => !p.closed) && ![...resources].some(r => r.failed))
                retired = false; } }; } };
    function run<T>(path: string, work: (handle: FileHandle, extent: number) => Promise<T>, subordinate = false, sessionId?: string, structural = false): Promise<T> {
        const scope = mutationReads.getStore();
        const internal = sessionId !== undefined && scope?.active === true && scope.sessionId === sessionId;
        const check = () => {
            // A raw backend observation may outlive coordinator retirement,
            // but never a still-closing participant or original handle debt.
            const structuralCurrent = structural && ![...participants].some(p => p.closed);
            if (!subordinate && !internal && !structuralCurrent) admission();
            else if ((internal && !scope!.active) || [...resources].some(r => r.failed)) throw Error('ARCHIVE_READ_UNAVAILABLE');
        };
        try {
            check();
        }
        catch (e) {
            return Promise.reject(e);
        }
        const flight = Promise.resolve().then(async () => {
            let resource: Resource | undefined, failed = false, primary: unknown, result: T | undefined;
            try {
                const handle = await open(path, 'r');
                resource = { handle, close: handle.close.bind(handle), failed: false, consumed: false };
                resources.add(resource);
                check();
                const initial = await handle.stat({ bigint: true });
                const extent = Number(initial.size);
                if (!Number.isSafeInteger(extent))
                    throw Error('Archive extent unsupported');
                result = await work(handle, extent);
                check();
                const final = await handle.stat({ bigint: true }), current = await stat(path, { bigint: true });
                if (final.dev !== initial.dev || final.ino !== initial.ino || current.dev !== initial.dev || current.ino !== initial.ino || final.size < initial.size || current.size < initial.size)
                    throw Error('Archive observation changed');
            }
            catch (e) {
                failed = true;
                primary = e;
            }
            const errors: unknown[] = [];
            if (resource)
                try {
                    await close(resource);
                }
                catch (e) {
                    errors.push(e);
                }
            if (failed && !errors.length)
                throw primary;
            if (failed || errors.length)
                throw new AggregateError([...(failed ? [primary] : []), ...errors], 'Archive read failed');
            return result!;
        });
        pending.add(flight);
        void flight.finally(() => pending.delete(flight)).catch(() => { });
        return flight;
    }
    /** Same original ledger, but lifetime belongs to an already-held writer.
     * Registration precedes open; retirement never supplies writer authority. */
    function openHeld(path:string,assertHeld:()=>void) {
        const healthy=()=>{assertHeld();if([...resources].some(r=>r.failed))throw Error('Archive read cleanup unresolved')};
        healthy();
        let resource:Resource|undefined,initial:import('node:fs').BigIntStats|undefined,extent=0,retiredScope=false;
        const reads=new Set<Promise<unknown>>();
        const track=<T>(flight:Promise<T>)=>{pending.add(flight);void flight.finally(()=>pending.delete(flight)).catch(()=>{});return flight};
        const opening=track(Promise.resolve().then(async()=>{
            healthy();const handle=await open(path,'r');resource={handle,close:handle.close.bind(handle),failed:false,consumed:false};resources.add(resource);
            healthy();initial=await handle.stat({bigint:true});healthy();
            if(!initial.isFile()||initial.size<0n||initial.size>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Archive extent unsupported');
            extent=Number(initial.size);
        }));
        const check=()=>{if(retiredScope)throw Error('Owned dependency scope retired');healthy();if(resource&&!resources.has(resource))throw Error('Owned dependency descriptor retired')};
        return {assertCurrent:check,read<T>(work:(handle:FileHandle,extent:number)=>Promise<T>):Promise<T>{
            check();const flight=track(Promise.resolve().then(async()=>{await opening;check();const result=await work(resource!.handle,extent);check();
                const final=await resource!.handle.stat({bigint:true}),current=await stat(path,{bigint:true});check();
                if(!initial||final.dev!==initial.dev||final.ino!==initial.ino||current.dev!==initial.dev||current.ino!==initial.ino||final.size!==initial.size||current.size!==initial.size)throw Error('Owned dependency archive changed');return result;
            }));reads.add(flight);void flight.finally(()=>reads.delete(flight)).catch(()=>{});return flight;
        },async close(){retiredScope=true;await opening.catch(()=>{});await Promise.allSettled([...reads]);if(resource)await close(resource)}};
    }
    return { run, association, openHeld };
}
