import { createHash } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, decodeFactBatch, stringifyJsonData, type Session, type SessionEvent } from '@i-harness/core-session'
import type { CommitLog } from '@i-harness/session-commit-log'
import type { HeldFactOwner, IssuingFactOwner, ManagedDocument } from '../coordinator/fact-types.ts'
import { heldFactOwner } from '../coordinator/fact-owner.ts'
import { createManagedDocument } from '../coordinator/managed-document.ts'
import type { Ownership } from '../coordinator/ownership.ts'
import type { PersistenceBackend, SessionMeta, CoordinatorOptions } from '../coordinator/types.ts'
import { buildSession, preflightSessionFormat } from '../format/validation.ts'

/** Prefix derivation shared by the fact-batch adapter and the document's start. */
export function commitPrefix(log: CommitLog): { eventCount: number; bodyBytes: number; prefixDigest: string } {
  const view = log.view()
  const last = [...view.batches.values()].at(-1)
  const digest = last ?? createHash('sha256').update(stringifyJsonData(log.header()) ?? '{}').digest('hex')
  return { eventCount: view.entries.length, bodyBytes: Buffer.byteLength(stringifyJsonData(view.entries) ?? '[]'), prefixDigest: digest }
}

function receipt(owner: { sessionId: string; incarnation: string }, key: ReturnType<typeof decodeFactBatch>['key'], prefixDigest: string) {
  return { owner: { ...owner }, key: { ...key }, lastSeq: key.firstSeq + key.count - 1, prefixDigest }
}

function createFactBackend(log: CommitLog): PersistenceBackend {
  const prefix = () => commitPrefix(log)
  return {
    id: 'jsonl',
    capabilities: { seekableRead: true, rawArtifacts: false },
    async appendOwnedBatch(_id: string, owner: IssuingFactOwner, _prefix: unknown, batch: { bytes: Uint8Array }) {
      const decoded = decodeFactBatch(batch.bytes)
      const current = prefix()
      if (decoded.key.previousPrefixDigest !== current.prefixDigest || decoded.key.firstSeq !== current.eventCount) return { kind: 'conflict' as const, key: decoded.key }
      owner.beforeIssue()
      await log.append({ entries: decoded.events, ops: [{ kind: 'batch', id: decoded.key.batchId, prefixDigest: decoded.prefixDigest }] })
      return { kind: 'committed' as const, receipt: receipt(owner.owner, decoded.key, decoded.prefixDigest) }
    },
    async reconcileOwnedBatch(_id: string, owner: { owner: { sessionId: string; incarnation: string } }, _prefix: unknown, batch: { bytes: Uint8Array }) {
      const decoded = decodeFactBatch(batch.bytes)
      const known = log.view().batches.get(decoded.key.batchId)
      if (known !== undefined) return known === decoded.prefixDigest ? { kind: 'committed' as const, receipt: receipt(owner.owner, decoded.key, known) } : { kind: 'conflict' as const, key: decoded.key }
      const current = prefix()
      if (decoded.key.previousPrefixDigest === current.prefixDigest && decoded.key.firstSeq === current.eventCount) return { kind: 'absent' as const, key: decoded.key }
      return { kind: 'conflict' as const, key: decoded.key }
    },
  } as unknown as PersistenceBackend
}

export type CommitManagedDeps = {
  readonly logs: Map<string, CommitLog>
  readonly metaOf: (log: CommitLog) => SessionMeta
  readonly ownership: Ownership
  readonly onReport?: (error: unknown) => void
}

export type CommitManagedContext = {
  readonly meta: SessionMeta
  readonly source: Session
  readonly prefix: ReturnType<typeof commitPrefix>
  readonly backend: PersistenceBackend
  readonly ownership: Ownership
}

export function createCommitManagedContext(_sessionId: string, log: CommitLog, deps: CommitManagedDeps): CommitManagedContext {
  const meta = deps.metaOf(log)
  const events: SessionEvent[] = log.view().entries.map(event => ({ ...event }))
  preflightSessionFormat(CURRENT_FORMAT_VERSION, events, meta)
  return { meta, source: buildSession(meta, events), prefix: commitPrefix(log), backend: createFactBackend(log), ownership: deps.ownership }
}

const closed = () => Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })

/** Open the managed document over an already-writable commit log and keep the
 *  log registered so every later append routes through the same lease. */
export function openCommitManagedDocument(sessionId: string, log: CommitLog, deps: CommitManagedDeps): ManagedDocument {
  const context = createCommitManagedContext(sessionId, log, deps)
  return createManagedDocument(sessionId, context.source, context.prefix, context.backend, context.ownership, {} as CoordinatorOptions, deps.onReport ?? (() => {}))
}

/** The execution attachment's document: constructed from the restored state so
 *  the document owns a delivery observation the execution state can fence. */
export function openCommitExecutionDocument(sessionId: string, log: CommitLog, deps: CommitManagedDeps, state: object, incarnation: string): ManagedDocument {
  const context = createCommitManagedContext(sessionId, log, deps)
  const held: HeldFactOwner = heldFactOwner({ sessionId, incarnation }, context.ownership, () => { if (!log.open) throw closed() })
  return createManagedDocument(
    sessionId, undefined, context.prefix, context.backend, context.ownership,
    {} as CoordinatorOptions, deps.onReport ?? (() => {}),
    undefined, undefined, undefined, undefined,
    { state, held, assertCurrent() { if (!log.open) throw closed() } } as never,
  )
}