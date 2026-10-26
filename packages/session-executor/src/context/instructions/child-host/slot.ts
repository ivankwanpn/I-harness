import type { SessionRequestContext } from '@i-harness/core-agent'
import type { ChildInstructionContext, ChildInstructionContextInput } from '@i-harness/subagent'
import type { InstructionReadScope } from '@i-harness/fs'
import type { InstructionTarget } from '@i-harness/instructions'
import { createRuntimeContext, type RuntimeContextService } from '@i-harness/runtime-context'
import { createRuntimeContextSource } from '../../../lifecycle/action-facts.ts'
import { createMainInstructionManager } from '../manager.ts'
import { observedRejection, reentrantClose, trackOperation, unavailable, type Operation } from './operations.ts'

export interface CleanupFlight {
  work: Promise<void>
  result?: PromiseSettledResult<void>
  reported: boolean
  automatic: boolean
  slot: InstructionSlot
}

type Manager = ReturnType<typeof createMainInstructionManager>
type ManagerOptions = Parameters<typeof createMainInstructionManager>[0]
export interface SlotOwner {
  available(): boolean
  invoking(): boolean
  invoke<T>(original: () => T): T
  admit(flight: CleanupFlight): void
  remove(slot: InstructionSlot): void
}

/** A reserved record exists before callbacks and survives every unacknowledged
 * original. An absent handle becomes final only after construction exits. */
export class InstructionSlot {
  readonly operations = new Set<Operation>()
  readonly lease: ChildInstructionContext
  retired = false
  constructing = true
  failed = false
  constructionFailure: { value: unknown; delivered: boolean } | undefined
  flight: CleanupFlight | undefined
  private runtime: RuntimeContextService | undefined
  private manager: Manager | undefined
  private runtimeClosed = false
  private managerClosed = false

  constructor(readonly input: ChildInstructionContextInput, private readonly owner: SlotOwner) {
    const context: SessionRequestContext = {
      reconcile: signal => {
        if (!this.available()) return observedRejection(unavailable())
        return trackOperation(this.operations, () => this.owner.invoke(() => this.manager!.reconcile(signal))).work
      },
      capture: () => this.available() ? this.manager!.capture() : undefined,
      current: evidence => this.available() && this.manager!.current(evidence),
      // Already-issued settlements preserve the original manager's rules.
      retain: evidence => this.owner.invoke(() => this.manager!.retain(evidence)),
      succeeded: handoff => this.owner.invoke(() => this.manager!.succeeded(handoff)),
      promotedHumanRequest: () => {
        if (!this.available()) throw unavailable()
        this.owner.invoke(() => this.manager!.promotedHumanRequest())
      },
      close: () => this.close(),
    }
    this.lease = { requestContext: context, retire: () => this.retire(), close: () => this.close() }
  }

  available(): boolean { return !this.constructing && this.live() }
  private live(): boolean {
    return !this.retired && this.owner.available() && this.owner.invoke(() => this.input.lifetime.available()) && !this.retired && this.owner.available()
  }
  retire(): void { this.retired = true }
  get clean(): boolean { return !this.constructing && (!this.runtime || this.runtimeClosed) && (!this.manager || this.managerClosed) }

  retryConstructionCleanup(): void {
    // CF04: no caller received a lease. A refused same-owner create may admit
    // one deferred retry of the remaining originals, never a replacement.
    if (this.failed && !this.constructing && !this.clean && this.flight?.result?.status === 'rejected') this.attempt(true)
  }

  construct(options: Omit<ManagerOptions, 'available' | 'publish'>): ChildInstructionContext {
    try {
      if (!this.live()) throw unavailable()
      this.runtime = createRuntimeContext(this.input.session, createRuntimeContextSource(this.input.factOwner))
      this.manager = createMainInstructionManager({ ...options,
        available: () => this.live(),
        publish: (signal, retain) => this.runtime!.render(signal, retain),
      })
      this.runtime.registerSection('instructions', this.manager.text)
      if (!this.live()) throw unavailable()
      return this.lease
    } catch (value) {
      this.failed = true; this.retire()
      this.constructionFailure = { value, delivered: false }
      // Admission happens now; original cleanup waits for construction unwind.
      this.attempt(true)
      this.constructionFailure.delivered = true
      throw value
    } finally { this.constructing = false }
  }

  observe(target: InstructionTarget): Promise<InstructionReadScope> {
    if (!this.available()) return Promise.resolve({ status: 'unavailable', reason: 'mapping-unavailable' })
    return trackOperation(this.operations, () => this.owner.invoke(() => this.manager!.observe(target))).work.then(result =>
      this.available() ? result : { status: 'unavailable', reason: 'mapping-unavailable' })
  }

  close(): Promise<void> {
    this.retire()
    if (this.constructing || this.owner.invoking()) return observedRejection(reentrantClose())
    const existing = this.flight
    // Concurrent callers join an explicit attempt. An automatically admitted
    // constructor cleanup is joined before one explicit remaining-phase retry.
    if (existing && !existing.result && !existing.automatic) return this.deliver(existing)
    if (existing && !existing.result) return existing.work.then(() => {}, () => {}).then(() => this.clean ? undefined : this.deliver(this.attempt(false)))
    if (this.clean) return Promise.resolve()
    return this.deliver(this.attempt(false))
  }

  private deliver(flight: CleanupFlight): Promise<void> {
    const delivered = flight.work.catch(error => { flight.reported = true; throw error })
    void delivered.catch(() => {})
    return delivered
  }

  private attempt(automatic: boolean): CleanupFlight {
    const deferred = Promise.withResolvers<void>()
    const flight: CleanupFlight = { work: deferred.promise, reported: false, automatic, slot: this }
    this.flight = flight
    // Install result/rejection observation and independent host admission before
    // any original method, including methods that synchronously call close.
    void flight.work.then(() => {
      flight.result = { status: 'fulfilled', value: undefined }
      if (this.clean && (!this.failed || this.constructionFailure?.delivered)) this.owner.remove(this)
    }, reason => { flight.result = { status: 'rejected', reason } })
    this.owner.admit(flight)
    void Promise.resolve().then(async () => {
      const originals = [...this.operations]
      await Promise.allSettled(originals.map(original => original.work))
      if (this.constructing) throw reentrantClose()
      if (this.runtime && !this.runtimeClosed) {
        await this.owner.invoke(() => this.runtime!.close()); this.runtimeClosed = true
      }
      if (this.manager && !this.managerClosed) {
        await this.owner.invoke(() => this.manager!.close()); this.managerClosed = true
      }
    }).then(deferred.resolve, deferred.reject)
    return flight
  }
}
