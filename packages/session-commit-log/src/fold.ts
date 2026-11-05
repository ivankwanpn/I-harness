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
  readonly seed?: CommitSeed
  readonly deleted: boolean
}

/** Derive the session view from committed records; the log is the only truth. */
export function foldCommits(records: readonly CommitRecord[]): CommitView {
  let header: Readonly<Record<string, unknown>> | undefined
  let entries: SessionEvent[] = []
  const meta: Record<string, unknown> = {}
  const documents = new Map<string, CommitDocument>()
  const intents = new Map<string, Readonly<Record<string, unknown>>>()
  let seed: CommitSeed | undefined
  let deleted = false
  for (const record of records) {
    entries.push(...record.entries)
    for (const op of record.ops) {
      switch (op.kind) {
        case 'header': header ??= op.value; break
        case 'meta': Object.assign(meta, op.patch); break
        case 'doc': documents.set(op.key, op.side); break
        case 'doc-clear': documents.delete(op.key); break
        case 'intent': intents.set(op.id, op.intent); break
        case 'seed': seed ??= { parent: op.parent, cut: op.cut, digest: op.digest }; break
        case 'intent-done': intents.delete(op.id); break
        case 'rewind':
          if (op.toSeq > entries.length) throw new CommitFormatError('ops', `rewind toSeq ${op.toSeq} exceeds ${entries.length} committed entries`)
          entries = entries.slice(0, op.toSeq); break
        case 'delete': deleted = true; break
      }
    }
  }
  if (!header) throw new CommitFormatError('ops', 'commit log has no header op')
  return { header, entries, meta, documents, intents, ...(seed ? { seed } : {}), deleted }
}
