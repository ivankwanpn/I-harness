import type { SessionLock } from './index.ts'

/** The original resource retains a failed release until its own close is
 * acknowledged. A consumed held flag cannot acknowledge an uncertain close. */
export class LeaseRetirement {
  private failure: unknown
  private uncertain = false
  private retired = false
  private failedRelease = false

  constructor(readonly lease: SessionLock) {}

  get held(): boolean { return !this.retired && this.lease.held }
  get failed(): boolean { return this.failedRelease }
  get error(): unknown { return this.failure }

  assertSettled(): void {
    if (!this.retired) throw new Error('Original workspace lease cleanup unresolved')
  }

  release(): Promise<void> { return this.close() }

  async close(): Promise<void> {
    if (this.retired) return
    if (this.uncertain) throw this.failure
    try {
      await this.lease.release()
      if (this.lease.held) throw new Error('Ownership lease release left the original lease held')
      this.retired = true
      this.failedRelease = false
    } catch (failure) {
      this.failure = failure
      this.failedRelease = true
      this.uncertain = !this.lease.held
      throw failure
    }
  }
}
