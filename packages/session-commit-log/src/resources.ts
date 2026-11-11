import type { FileHandle } from 'node:fs/promises'
import { types } from 'node:util'
import { LeaseRetirement } from '@i-harness/fs-lock/internal/lease-retirement'

export interface CommitLogCleanup { close(): Promise<void> }

/** An original cleanup capability survives an initialization or close failure. */
export class CommitLogCleanupError extends AggregateError {
  readonly code = 'COMMIT_LOG_CLEANUP_REQUIRED'
  constructor(errors: readonly unknown[], readonly cleanup: CommitLogCleanup) {
    const messages = errors.flatMap(error => {
      if (!error || typeof error !== 'object' || types.isProxy(error)) return []
      const message = Object.getOwnPropertyDescriptor(error, 'message')
      return message && 'value' in message && typeof message.value === 'string' ? [message.value] : []
    })
    const detail = messages.join(' / ')
    const message = messages.length === 1 && detail.startsWith('Commit log resource cleanup')
      ? detail : `Commit log resource cleanup is unresolved${detail ? ` (${detail})` : ''}`
    super(errors, message, { cause: errors[0] })
    this.name = 'CommitLogCleanupError'
  }
}

/** One log owns its acquired leases and file handles, including failed opens. */
export class CommitLogResources implements CommitLogCleanup {
  private readonly resources = new Set<LeaseRetirement>()
  private readonly closing = new Map<LeaseRetirement, Promise<void>>()

  retain(resource: LeaseRetirement): LeaseRetirement {
    this.resources.add(resource)
    return resource
  }

  file(handle: FileHandle): LeaseRetirement {
    const close = handle.close.bind(handle)
    return this.retain(new LeaseRetirement({ get held() { return handle.fd >= 0 }, release: close }))
  }

  async withFile<T>(handle: FileHandle, work: () => Promise<T>): Promise<T> {
    return this.withResource(this.file(handle), work)
  }

  async withResource<T>(resource: LeaseRetirement, work: () => Promise<T>): Promise<T> {
    let failed = false, primary: unknown, value!: T
    try { value = await work() } catch (error) { failed = true; primary = error }
    try { await this.release(resource) }
    catch (cleanup) {
      throw new CommitLogCleanupError(failed ? [primary, cleanup] : [cleanup], { close: () => this.release(resource) })
    }
    if (failed) throw primary
    return value
  }

  release(resource: LeaseRetirement): Promise<void> {
    if (!this.resources.has(resource)) return Promise.resolve()
    const pending = this.closing.get(resource)
    if (pending) return pending
    // Register the flight before invoking an original close callback, which
    // can synchronously reenter the owner's cleanup path.
    const flight = Promise.resolve().then(() => resource.close()).then(() => {
      this.resources.delete(resource)
    }, error => {
      throw new CommitLogCleanupError([error], { close: () => this.release(resource) })
    })
    this.closing.set(resource, flight)
    void flight.finally(() => this.closing.delete(resource)).catch(() => {})
    return flight
  }

  assertHealthy(): void {
    const failed = [...this.resources].filter(resource => resource.failed)
    if (failed.length) throw new CommitLogCleanupError(failed.map(resource => resource.error), {
      close: () => this.closeSelected(failed),
    })
  }

  private async closeSelected(resources: readonly LeaseRetirement[]): Promise<void> {
    // Later file handles retire before the lease that admitted them. A failed
    // close retains that lease until this same resource acknowledges disposal.
    for (const resource of [...resources].reverse()) {
      try { await this.release(resource) }
      catch (error) { throw new CommitLogCleanupError([error], { close: () => this.closeSelected(resources) }) }
    }
  }

  close(): Promise<void> { return this.closeSelected([...this.resources]) }
}
