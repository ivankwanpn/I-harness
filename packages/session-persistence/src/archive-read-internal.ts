/** Constructor-private resource participation, never storage/read authority. */
export interface ArchiveReadResources {
    attach(): {
        fence(): void;
        assertPublicReadAdmission(): void;
        settle(): Promise<void>;
        withMutationRead<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
    };
}
const owners = new WeakMap<object, ArchiveReadResources>();
export function associateArchiveReadResources(backend: object, owner: ArchiveReadResources) {
    if (owners.has(backend))
        throw TypeError('Archive resources already associated');
    owners.set(backend, owner);
}
export function attachArchiveReadResources(backend: object) { return owners.get(backend)?.attach(); }
import type { JournalPrefix } from '@i-harness/core-session'
export type ArchiveHistoryPrefixRead = {readonly kind:'available';readonly prefix:Readonly<JournalPrefix>} | {readonly kind:'unavailable'}
const historyPrefixReaders = new WeakMap<object,(proof:object)=>Readonly<JournalPrefix>|undefined>()
/** Installed once by the same genuine JSONL constructor as archive resources.
 * The original producer recognizes proof identity in its own private WeakMap;
 * there is no caller-facing proof/prefix association or DTO registration. */
export function associateArchiveHistoryPrefixReader(backend:object,read:(proof:object)=>Readonly<JournalPrefix>|undefined):void {
  if(!owners.has(backend))throw new TypeError('Original archive backend required')
  if(historyPrefixReaders.has(backend))throw new TypeError('Archive history prefix reader already associated')
  if(typeof read!=='function')throw new TypeError('Original history prefix reader required')
  historyPrefixReaders.set(backend,read)
}
export function hasArchiveHistoryPrefixReader(backend:object):boolean{return historyPrefixReaders.has(backend)}
/** Metadata only. The consumer must first await the original proof's currentness. */
export function readArchiveHistoryPrefix(backend:object,proof:object):ArchiveHistoryPrefixRead {
  const read=historyPrefixReaders.get(backend);if(!read)return {kind:'unavailable'}
  const prefix=read(proof);return prefix?{kind:'available',prefix}:{kind:'unavailable'}
}
