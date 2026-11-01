/** Constructor-private resource participation, never storage/read authority. */
export interface ArchiveReadResources {
    attach(): {
        fence(): void;
        settle(): Promise<void>;
    };
}
const owners = new WeakMap<object, ArchiveReadResources>();
export function associateArchiveReadResources(backend: object, owner: ArchiveReadResources) {
    if (owners.has(backend))
        throw TypeError('Archive resources already associated');
    owners.set(backend, owner);
}
export function attachArchiveReadResources(backend: object) { return owners.get(backend)?.attach(); }
