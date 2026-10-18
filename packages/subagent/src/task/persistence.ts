import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { TaskProtocolDocument } from './types.ts'

export function taskDocKey(stateId: string): string {
  // A colon creates an NTFS alternate data stream in the JSONL backend.
  return `task-${stateId}`
}

/** Sole ordered writer for this registry's existing auxiliary document. */
export class TaskPersistence {
  #chain: Promise<void> = Promise.resolve()
  constructor(readonly coordinator: SessionCoordinator | undefined, readonly stateId: string | undefined, readonly strict: boolean, readonly snapshot: () => TaskProtocolDocument) {}
  save(): Promise<void> {
    if (!this.coordinator || !this.stateId) return Promise.resolve()
    const document = this.strict ? this.snapshot() : undefined
    const next = this.#chain.then(() => {
      if (this.strict) {
        if (!this.coordinator!.putDocumentStrict) throw new Error('Strict result retention is unavailable')
        return this.coordinator!.putDocumentStrict(taskDocKey(this.stateId!), document)
      }
      return this.coordinator!.putDocument(taskDocKey(this.stateId!), this.snapshot())
    })
    this.#chain = next.catch(() => {})
    return next
  }
  async flush(): Promise<void> {
    for (;;) {
      const pending = this.#chain
      await pending
      if (pending === this.#chain) return
    }
  }
}
