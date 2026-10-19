import { randomUUID } from 'node:crypto'
import type { ManagedArtifactRef, RetainedResultRevision, ResultExecution } from '@i-harness/core-session'
import type { ResultFinalization, ToolExec } from '@i-harness/core-tools'
import type { TaskOutcome, RecoveryReason } from './types.ts'

export interface TaskResultBody { resultText?: string; error?: string }
export interface TaskResultProjection extends TaskResultBody { result?: RetainedTaskResult }
export interface TaskResultTarget extends TaskResultProjection { id: string; parentSessionId: string; outcome?: TaskOutcome; recoveryReason?: RecoveryReason }
export type RetainedTaskResult = RetainedResultRevision
export interface TaskResultPageArgs { offset?: number; maxBytes?: number; revision?: string; refRevision?: string; refId?: string }
export interface TaskResultPage {
  codec: 'json-utf8-v1'; resultRevision: string; ref: ManagedArtifactRef
  offset: number; nextOffset: number | null; eof: boolean
  data: { kind: 'text'; text: string }
}
export interface TaskResultStore {
  /** True only when this composition can actually read retained bytes back.
   * An adapter object existing is not proof of a durable reader. */
  available?(): boolean
  forSource?(context?: ToolExec, current?: () => boolean): Promise<TaskResultStore>
  capture(task: Readonly<TaskResultTarget>, body: TaskResultBody, revision: string, execution?: ResultExecution, current?: () => boolean): ResultFinalization
  read(task: Readonly<TaskResultTarget>, ref: ManagedArtifactRef, args: { offset?: number; maxBytes?: number }): Promise<{ ref: ManagedArtifactRef; offset: number; nextOffset: number | null; eof: boolean; data: { kind: 'text'; text: string } | { kind: 'bytes'; base64: string } }>
}

/** Ordinary fields are previews. This never scans/encodes the full body. */
export function taskBodyPreview(body: TaskResultBody): TaskResultBody {
  const fields = Object.keys(body) as (keyof TaskResultBody)[]
  const output: TaskResultBody = {}
  for (const field of fields) {
    let value = body[field]!.slice(0, Math.floor(1800 / Math.max(1, fields.length)))
    if (value.length && /[\uD800-\uDBFF]/.test(value.at(-1)!)) value = value.slice(0, -1)
    while (Buffer.byteLength(JSON.stringify(value)) > 1800 / fields.length) {
      value = value.slice(0, Math.floor(value.length / 2))
      if (value.length && /[\uD800-\uDBFF]/.test(value.at(-1)!)) value = value.slice(0, -1)
    }
    output[field] = value
  }
  return output
}

/** Owns original pending captures, separately from bounded durable task rows. */
export class TaskResultOwner {
  readonly #captures = new Map<string, { revision: string; capture: ResultFinalization }>()
  readonly #preparing = new Map<string, Promise<TaskResultStore>>()
  readonly #stores = new Map<string, TaskResultStore>()
  constructor(readonly store: TaskResultStore) {}
  /** The same capability the real store declares; never inferred from shape. */
  available(): boolean { return this.store.available?.() === true }
  async prepare(task: TaskResultTarget, context?: ToolExec, current?: () => boolean): Promise<TaskResultStore> {
    let pending = this.#preparing.get(task.id)
    if (!pending) {
      pending = this.store.forSource?.(context, current) ?? Promise.resolve(this.store)
      this.#preparing.set(task.id, pending)
    }
    const store = await pending
    this.#stores.set(task.id, store)
    return store
  }
  capture(task: TaskResultTarget, body: TaskResultBody, execution?: ResultExecution, current?: () => boolean): void {
    const revision = randomUUID()
    const capture = (this.#stores.get(task.id) ?? this.store).capture(task, body, revision, execution, current)
    this.#captures.set(task.id, { revision, capture })
    task.result = { version: 1, revision, kind: 'pending' }
    Object.assign(task, taskBodyPreview(body))
  }
  async settle(task: TaskResultTarget): Promise<void> {
    const pending = this.#captures.get(task.id)
    if (!pending) {
      if (task.result?.kind === 'pending') throw Object.assign(new Error('Original task body capture unavailable after restart'), { code: 'FACT_RECOVERY_REQUIRED' })
      return
    }
    const result = await pending.capture.settle()
    if (result.kind !== 'ready') throw Object.assign(new Error('Task result retention requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    // Ordinary task fields already carry the aggregate child preview. Keep
    // the closed descriptor free of a second preview copy in every mirror.
    task.result = { version: 1, revision: pending.revision, kind: 'retained', envelope: { ...result.envelope, preview: '' } }
    this.#captures.delete(task.id)
    this.#preparing.delete(task.id); this.#stores.delete(task.id)
  }
  read(task: TaskResultTarget, args: TaskResultPageArgs): Promise<TaskResultPage> { return readTaskResultPage(this.store, task, args) }
}

export async function readTaskResultPage(store: Pick<TaskResultStore, "read">, task: TaskResultTarget, args: TaskResultPageArgs): Promise<TaskResultPage> {
    const result = task.result
    if (!result || result.kind !== 'retained' || result.envelope.retention.kind !== 'artifact') throw new Error('Retained task body unavailable')
    const ref = result.envelope.retention.ref
    if (args.revision !== undefined && args.revision !== result.revision || args.refRevision !== undefined && args.refRevision !== ref.revision || args.refId !== undefined && args.refId !== ref.id) throw new Error('Task result revision changed; restart pagination')
    if (ref.codec !== 'json-utf8-v1') throw new Error('Task result codec unavailable')
    const cap = Math.min(args.maxBytes ?? 16384, 16384)
    if (!Number.isSafeInteger(cap) || cap < 1024) throw new Error('Task result budget must be an integer >=1024')
    const metadata = { codec: ref.codec, resultRevision: result.revision }
    const overhead = Buffer.byteLength(JSON.stringify(metadata)) + 2
    const page = await store.read(task, ref, { offset: args.offset ?? 0, maxBytes: cap - overhead })
    if (page.data.kind !== 'text') throw new Error('Task result text codec unavailable')
    const output: TaskResultPage = { ...page, ...metadata, data: page.data }
    if (Buffer.byteLength(JSON.stringify(output)) > cap) throw new Error('Task result page exceeds budget')
    return output
}
