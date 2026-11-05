import { createHash } from 'node:crypto'
import { stringifyJsonData } from '@i-harness/core-session'
import type {
  Confirmation, HeldTaskDocumentScope, RawTaskObservation, TaskDocumentAck, TaskDocumentBackendSession,
  TaskDocumentWitness, TaskDocumentWrite, TaskObservation, TaskWriteOutcome,
} from '../coordinator/task-document-types.ts'

export type CommitTaskDocumentPorts = {
  getDocument(key: string): Promise<unknown | undefined>
  putDocument(key: string, data: unknown): Promise<void>
}

const witnesses = new WeakMap<object, string>()
const acks = new WeakSet<object>()

export function isCommitTaskAck(value: object): boolean { return acks.has(value) }

function revisionOf(value: unknown): string {
  return createHash('sha256').update(stringifyJsonData(value) ?? 'null').digest('hex')
}

function witnessFor(revision: string): TaskDocumentWitness {
  const witness = Object.freeze({}) as TaskDocumentWitness
  witnesses.set(witness, revision)
  return witness
}

function revisionOfWitness(witness: TaskDocumentWitness): string {
  const revision = typeof witness === 'object' && witness !== null ? witnesses.get(witness) : undefined
  if (revision === undefined) throw new TypeError('Invalid task document witness')
  return revision
}

function acknowledgement(): TaskDocumentAck {
  const ack = Object.freeze({}) as TaskDocumentAck
  acks.add(ack)
  return ack
}

/** The task document is the same content-addressed document store the rest of
 *  the commit coordinator uses; the write protocol is one durable commit. */
export function openCommitTaskDocumentSession(scope: HeldTaskDocumentScope, ports: CommitTaskDocumentPorts): TaskDocumentBackendSession {
  const read = async (): Promise<TaskObservation> => {
    scope.assertActive()
    const value = await ports.getDocument(scope.key)
    scope.assertActive()
    return value === undefined ? { kind: 'absent' } : ({ kind: 'present', value, witness: witnessFor(revisionOf(value)) } as RawTaskObservation)
  }
  const write = (witness: TaskDocumentWitness, bytes: Uint8Array): TaskDocumentWrite => {
    const expected = revisionOfWitness(witness)
    let value: unknown
    try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch (cause) { value = undefined }
    const invalid = value === undefined
    const revision = invalid ? undefined : revisionOf(value)
    let outcome: TaskWriteOutcome | undefined
    const commit = async (): Promise<TaskWriteOutcome> => {
      if (outcome) return outcome
      if (invalid) return outcome = { kind: 'conflict', cleanupPending: false }
      scope.assertActive()
      const current = await ports.getDocument(scope.key)
      scope.assertActive()
      if (current !== undefined && revisionOf(current) !== expected) return outcome = { kind: 'conflict', cleanupPending: false }
      if (current === undefined && expected !== revisionOf(undefined)) return outcome = { kind: 'conflict', cleanupPending: false }
      await ports.putDocument(scope.key, value)
      scope.assertActive()
      return outcome = { kind: 'committed', ack: acknowledgement(), durability: 'file-synced-process-restart-v1', cleanupPending: false } as TaskWriteOutcome
    }
    return Object.freeze({
      issue: commit,
      retry: commit,
      async reconcile() {
        if (outcome) return outcome
        scope.assertActive()
        const current = await ports.getDocument(scope.key)
        if (current !== undefined && revision !== undefined && revisionOf(current) === revision) return outcome = { kind: 'committed', ack: acknowledgement(), durability: 'file-synced-process-restart-v1', cleanupPending: false } as TaskWriteOutcome
        return outcome = { kind: 'conflict', cleanupPending: false }
      },
      outcome() { return outcome },
    })
  }
  return Object.freeze({
    observe: read,
    async confirm(witness: TaskDocumentWitness): Promise<Confirmation> {
      const expected = revisionOfWitness(witness)
      const current = await read()
      if (current.kind === 'absent') return { kind: 'conflict', cleanupPending: false }
      const revision = revisionOf((current as RawTaskObservation).value)
      if (revision !== expected) return { kind: 'conflict', cleanupPending: false }
      return { kind: 'confirmed', ack: acknowledgement(), durability: 'file-synced-process-restart-v1', cleanupPending: false }
    },
    async settleResources() { /* one durable commit, no retained resources */ },
    stageWrite(witness: TaskDocumentWitness, bytes: Uint8Array) { return write(witness, bytes) },
  })
}
