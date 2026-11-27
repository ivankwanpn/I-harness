import type { JournalPrefix, SessionEvent, SessionView } from '@i-harness/core-session'
import type { PersistenceBackend } from './coordinator/types.ts'
import type { HeldFactOwner } from './coordinator/fact-types.ts'

/** Constructor-private resource participation, never storage/read authority. */
export interface ArchiveReadResources {
    attach(): {
        fence(): void;
        assertPublicReadAdmission(): void;
        settle(): Promise<void>;
        withMutationRead<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
    };
    /** The original decoder recognizes only its exact immutable cold view. */
    recognizesDecodedProcessHistory?(sessionId: string, initial: SessionView): boolean;
    /** Held native clean history already passed complete semantic validation. */
    recognizesCleanHistoryMaterialization?(proof: object): boolean;
}
const owners = new WeakMap<object, { owner: ArchiveReadResources; decodedRead: PersistenceBackend['read'] }>();

/** Original JSONL construction binds its read identity together with archive resources. */
export function associateArchiveReadResources(backend: object, owner: ArchiveReadResources, decodedRead: PersistenceBackend['read']) {
    if (owners.has(backend))
        throw TypeError('Archive resources already associated');
    owners.set(backend, { owner, decodedRead });
}
export function attachArchiveReadResources(backend: object) { return owners.get(backend)?.owner.attach(); }

/** Only the exact constructor-installed callable qualifies. Wrappers keep the ordinary checks. */
export function originalDecodedArchiveRead(backend: object): PersistenceBackend['read'] | undefined {
  const read = owners.get(backend)?.decodedRead
  if (read && Object.getOwnPropertyDescriptor(backend, 'read')?.value === read) return read
}

export function recognizesOriginalDecodedProcessHistory(backend: object, sessionId: string, initial: SessionView): boolean {
  return originalDecodedArchiveRead(backend) !== undefined
    && owners.get(backend)?.owner.recognizesDecodedProcessHistory?.(sessionId, initial) === true
}

export function recognizesOriginalCleanHistoryMaterialization(backend: object, proof: object): boolean {
    return originalDecodedArchiveRead(backend) !== undefined
        && owners.get(backend)?.owner.recognizesCleanHistoryMaterialization?.(proof) === true
}

/** The original archive owner lends only frame evidence and verified records. */
export interface ColdArchiveHistoryReader {
  readFull(sessionId: string): Promise<Awaited<ReturnType<PersistenceBackend['read']>> & { evidence?: object }>
  /** Internal page planner only. A detached page may retain this original decode
   * briefly for native writable preparation. Public snapshot uses readFull. */
  readFullForHistoryPage?(sessionId: string): Promise<(Awaited<ReturnType<PersistenceBackend['read']>> & {
    evidence?: object
    retainDecoded?(): void
  }) | undefined>
  /** Complete decoded history and its exact prefix from one sealed descriptor. */
  readSealedHistory?(sessionId: string): Promise<(Awaited<ReturnType<PersistenceBackend['read']>> & {
    prefix: Readonly<JournalPrefix>
  }) | undefined>
  /** Records are returned in increasing archive ordinal. */
  readWindow(sessionId: string, evidence: object, ordinals: ReadonlySet<number>): Promise<readonly SessionEvent[] | undefined>
}

const coldHistoryReaders = new WeakMap<object, ColdArchiveHistoryReader>()

export function associateColdArchiveHistoryReader(backend: object, reader: ColdArchiveHistoryReader): void {
  if (!originalDecodedArchiveRead(backend) || coldHistoryReaders.has(backend)) throw new TypeError('Original archive reader required')
  coldHistoryReaders.set(backend, reader)
}

export function originalColdArchiveHistoryReader(backend: object): ColdArchiveHistoryReader | undefined {
  return originalDecodedArchiveRead(backend) && coldHistoryReaders.get(backend)
}

export type ArchiveHistoryPrefixRead = {readonly kind:'available';readonly prefix:Readonly<JournalPrefix>} | {readonly kind:'unavailable'}
const historyPrefixReaders = new WeakMap<object,(proof:object, writer?: HeldFactOwner)=>Readonly<JournalPrefix>|undefined>()
/** Installed once by the same genuine JSONL constructor as archive resources.
 * The original producer recognizes proof identity in its own private WeakMap;
 * there is no caller-facing proof/prefix association or DTO registration. */
export function associateArchiveHistoryPrefixReader(backend:object,read:(proof:object,writer?:HeldFactOwner)=>Readonly<JournalPrefix>|undefined):void {
  if(!owners.has(backend))throw new TypeError('Original archive backend required')
  if(historyPrefixReaders.has(backend))throw new TypeError('Archive history prefix reader already associated')
  if(typeof read!=='function')throw new TypeError('Original history prefix reader required')
  historyPrefixReaders.set(backend,read)
}
export function hasArchiveHistoryPrefixReader(backend:object):boolean{return historyPrefixReaders.has(backend)}
/** Metadata only. The consumer must first await the original proof's currentness. */
export function readArchiveHistoryPrefix(backend:object,proof:object,writer?:HeldFactOwner):ArchiveHistoryPrefixRead {
  const read=historyPrefixReaders.get(backend);if(!read)return {kind:'unavailable'}
  const prefix=read(proof,writer);return prefix?{kind:'available',prefix}:{kind:'unavailable'}
}
