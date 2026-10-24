import { AsyncLocalStorage } from 'node:async_hooks'
import { acquireSessionLock, lockPathFor, type SessionLock } from '@i-harness/fs-lock'

export interface WorkspaceMutationTurn { assertCurrent(): void }
export interface WorkspaceMutationOwner {
  mutate<T>(work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T>
  cleanup<T>(work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T>
  assertTurn(turn: WorkspaceMutationTurn): void
  join(): Promise<void>
  close(): Promise<void>
}

/** A failed native release is debt on the original handle. In particular, a
 * consumed held bit cannot turn a subsequent no-op into confirmed disposal. */
export class LeaseRetirement {
  private failure: unknown
  private uncertain = false
  private retired = false
  constructor(readonly lease: SessionLock) {}
  async close(): Promise<void> {
    if (this.retired) return
    if (this.uncertain) throw this.failure
    try {
      await this.lease.release()
      if (this.lease.held) throw new Error('Ownership lease release left the original lease held')
      this.retired = true
    } catch (failure) {
      this.failure = failure
      this.uncertain = !this.lease.held
      throw failure
    }
  }
}

export function failuresTogether(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, message)
}

const context = new AsyncLocalStorage<symbol>()

export function createWorkspaceMutationOwner(identity: { root: string; workspaceId: string }): WorkspaceMutationOwner {
  const key = Symbol('workspace mutation owner')
  const path = lockPathFor(identity.root, `context-output:${identity.workspaceId}`)
  const active = new Map<WorkspaceMutationTurn, SessionLock>()
  let serial: Promise<unknown> = Promise.resolve()
  let debt: LeaseRetirement | undefined
  let closing = false, closed = false, closeFlight: Promise<void> | undefined
  const assertOutside = () => { if (context.getStore() === key) throw new Error('Workspace mutation owner reentry is unavailable') }
  function assertTurn(turn: WorkspaceMutationTurn): void {
    const lease = active.get(turn)
    if (!lease?.held || context.getStore() !== key) throw new Error('Workspace mutation turn is stale or foreign')
  }
  function enqueue<T>(work: (turn: WorkspaceMutationTurn) => Promise<T>, cleanup: boolean): Promise<T> {
    try { assertOutside(); if (closed || closing && !cleanup) throw new Error('Workspace mutation owner is closed') }
    catch (failure) { return Promise.reject(failure) }
    const next = serial.then(async () => {
      if (debt) {
        if (!cleanup) throw new Error('Workspace mutation lease cleanup remains unresolved', { cause: debt })
        await debt.close(); debt = undefined
      }
      const lease = await acquireSessionLock({ lockPath: path })
      const retirement = new LeaseRetirement(lease)
      const turn: WorkspaceMutationTurn = Object.freeze({ assertCurrent: () => assertTurn(turn) })
      active.set(turn, lease)
      const failures: unknown[] = []
      let result!: T
      await context.run(key, async () => {
        try { result = await work(turn) } catch (failure) { failures.push(failure) }
        finally { active.delete(turn) }
      })
      try { await retirement.close() } catch (failure) { debt = retirement; failures.push(failure) }
      failuresTogether(failures, 'Workspace mutation and original lease cleanup failed')
      return result
    })
    serial = next.catch(() => {})
    return next
  }
  const join = async () => { assertOutside(); await serial }
  return {
    mutate: work => enqueue(work, false), cleanup: work => enqueue(work, true), assertTurn, join,
    close() {
      try { assertOutside() } catch (failure) { return Promise.reject(failure) }
      if (closed) return Promise.resolve()
      closing = true
      if (!closeFlight) closeFlight = (async () => {
        await serial
        if (debt) { await debt.close(); debt = undefined }
        closed = true
      })().catch(failure => { closeFlight = undefined; throw failure })
      return closeFlight
    },
  }
}
