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
            retired = false; return { fence() { p.closed = true; retired = true; }, async settle() { await settle(); participants.delete(p); if (participants.size > 0 && [...participants].every(p => !p.closed) && ![...resources].some(r => r.failed))
                retired = false; } }; } };
    function run<T>(path: string, work: (handle: FileHandle, extent: number) => Promise<T>, subordinate = false): Promise<T> {
        try {
            if (!subordinate)
                admission();
            else if ([...resources].some(r => r.failed))
                throw Error('ARCHIVE_READ_UNAVAILABLE');
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
                if (!subordinate)
                    admission();
                const initial = await handle.stat({ bigint: true });
                const extent = Number(initial.size);
                if (!Number.isSafeInteger(extent))
                    throw Error('Archive extent unsupported');
                result = await work(handle, extent);
                if (!subordinate)
                    admission();
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
    return { run, association };
}
