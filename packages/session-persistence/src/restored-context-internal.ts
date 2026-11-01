import type { PreparedConversationArchive } from '@i-harness/core-session/internal/restoration';
/** Read-only private attachment, never a partial Session or a fact owner. */
export interface ManagedRestoredContextRead {
    readonly identity: object;
    prepare(): Promise<PreparedConversationArchive>;
    close(): Promise<void>;
}
const acquisitions = new WeakMap<object, {
    acquire(id: string): Promise<ManagedRestoredContextRead>;
    assertAdmission(id: string): void;
}>();
/** Original coordinator assembly installs its captured owner once. */
export function associateRestoredContextAcquisition(coordinator: object, original: {
    acquire(id: string): Promise<ManagedRestoredContextRead>;
    assertAdmission(id: string): void;
}) {
    if (acquisitions.has(coordinator))
        throw new TypeError('Restored context acquisition already associated');
    const acquire = original.acquire.bind(original), assertAdmission = original.assertAdmission.bind(original);
    acquisitions.set(coordinator, { acquire, assertAdmission });
}
export async function acquireRestoredContext(coordinator: object, id: string): Promise<ManagedRestoredContextRead> {
    const original = acquisitions.get(coordinator);
    if (!original)
        throw new TypeError('Original restored coordinator required');
    original.assertAdmission(id);
    const read = await original.acquire(id);
    try {
        original.assertAdmission(id);
        return read;
    }
    catch (primary) {
        try {
            await read.close();
        }
        catch (cleanup) {
            throw new AggregateError([primary, cleanup], 'Restored acquisition admission and cleanup failed');
        }
        throw primary;
    }
}
