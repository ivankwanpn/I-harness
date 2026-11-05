import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, decodeFactBatch, stringifyJsonData, type Session, type SessionEvent } from '@i-harness/core-session'
import type { CommitLog } from '@i-harness/session-commit-log'
import type { IssuingFactOwner, ManagedDocument } from '../coordinator/fact-types.ts'
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

/** The document's operation lane and held-owner assertion over the commit log. */
function createCommitOwnership(logs: Map<string, CommitLog>): Ownership {
  const lanes = new Map<string, Promise<unknown>>()
  const current = new AsyncLocalStorage<string>()
  return {
    lockEnabled: true,
    assertHeld(id: string) {
      const log = logs.get(id)
      if (!log?.open) throw Object.assign(new Error('Exclusive ownership claim is unavailable'), { code: 'FACT_OWNER_UNSUPPORTED' })
    },
    assertOutsideSessionOperation(id: string) {
      if (current.getStore() === id) throw new Error('TASK_DOCUMENT_CONFLICT')
    },
    async withSessionOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
      const previous = lanes.get(id) ?? Promise.resolve()
      const gate = Promise.withResolvers<void>()
      lanes.set(id, gate.promise)
      await previous
      try { return await current.run(id, operation) } finally { gate.resolve(); if (lanes.get(id) === gate.promise) lanes.delete(id) }
    },
  } as unknown as Ownership
}

export type CommitManagedDeps = {
  readonly logs: Map<string, CommitLog>
  readonly metaOf: (log: CommitLog) => SessionMeta
  readonly onReport?: (error: unknown) => void
}

/** Open the managed document over an already-writable commit log and keep the
 *  log registered so every later append routes through the same lease. */
export function openCommitManagedDocument(sessionId: string, log: CommitLog, deps: CommitManagedDeps): ManagedDocument {
  const meta = deps.metaOf(log)
  const events: SessionEvent[] = log.view().entries.map(event => ({ ...event }))
  preflightSessionFormat(CURRENT_FORMAT_VERSION, events, meta)
  const source: Session = buildSession(meta, events)
  const document = createManagedDocument(
    sessionId,
    source,
    commitPrefix(log),
    createFactBackend(log),
    createCommitOwnership(deps.logs),
    {} as CoordinatorOptions,
    deps.onReport ?? (() => {}),
  )
  return document
}
