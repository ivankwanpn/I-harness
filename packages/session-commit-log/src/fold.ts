import type { SessionEvent } from '@i-harness/core-session'
import { CommitFormatError } from './errors.ts'
import type { CommitRecord } from './format.ts'

export type CommitDocument = { readonly digest: string; readonly bytes: number }
export type CommitSeed = { readonly parent: string; readonly cut: number; readonly digest: string }

export type CommitView = {
  readonly header: Readonly<Record<string, unknown>>
  readonly entries: readonly SessionEvent[]
  readonly meta: Readonly<Record<string, unknown>>
  readonly documents: ReadonlyMap<string, CommitDocument>
  readonly intents: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  /** Committed fact batches: batch id -> its prefix digest (insertion order). */
  readonly batches: ReadonlyMap<string, string>
  readonly seed?: CommitSeed
  readonly deleted: boolean
}

/** Derive the session view from committed records; the log is the only truth. */
export function foldCommits(records: readonly CommitRecord[], previous?: CommitView): CommitView {
  let header: Readonly<Record<string, unknown>> | undefined = previous?.header
  let entries: SessionEvent[] = previous ? previous.entries as SessionEvent[] : []
  const meta: Record<string, unknown> = previous ? previous.meta as Record<string, unknown> : {}
  const documents = previous ? previous.documents as Map<string, CommitDocument> : new Map<string, CommitDocument>()
  const intents = previous ? previous.intents as Map<string, Readonly<Record<string, unknown>>> : new Map<string, Readonly<Record<string, unknown>>>()
  const batches = previous ? previous.batches as Map<string, string> : new Map<string, string>()
  let seed: CommitSeed | undefined = previous?.seed
  let deleted = previous?.deleted ?? false
  for (const record of records) {
    for (const entry of record.entries) entries.push(entry)
    for (const op of record.ops) {
      switch (op.kind) {
        case 'header': header ??= op.value; break
        case 'meta': Object.assign(meta, op.patch); break
        case 'doc': documents.set(op.key, op.side); break
        case 'doc-clear': documents.delete(op.key); break
        case 'intent': intents.set(op.id, op.intent); break
        case 'batch': batches.set(op.id, op.prefixDigest); break
        case 'seed': seed ??= Object.freeze({ parent: op.parent, cut: op.cut, digest: op.digest }); break
        case 'intent-done': intents.delete(op.id); break
        case 'rewind':
          if (op.toSeq > entries.length) throw new CommitFormatError('ops', `rewind toSeq ${op.toSeq} exceeds ${entries.length} committed entries`)
          entries = entries.slice(0, op.toSeq); break
        case 'delete': deleted = true; break
      }
    }
  }
  if (!header) throw new CommitFormatError('ops', 'commit log has no header op')
  return { header, entries, meta, documents, intents, batches, ...(seed ? { seed } : {}), deleted }
}
