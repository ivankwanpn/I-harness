import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildAgentEntry } from '../agent-table.ts'
import type { SubagentToolDeps } from '../tools/types.ts'

export interface RetainedResidentResource {
  readonly entry: ChildAgentEntry
  readonly kind: 'generation' | 'resident'
  retire(): void
  close(): Promise<void>
  readonly generationCleanup?: Promise<void>
  settleResults?(): Promise<void>
  rawNext?: Promise<void>
}
const invocations = new AsyncLocalStorage<ReadonlySet<object>>()
export function inOriginalInvocation(identity: object): boolean { return invocations.getStore()?.has(identity) === true }
export function invokeOriginal<T>(identity: object, work: () => T): T {
  return invocations.run(new Set([...(invocations.getStore() ?? []), identity]), work)
}
export function refusedReentry(): Promise<never> {
  const result = Promise.reject(Object.assign(new Error('Original cleanup cannot join its own invocation'), { code: 'FACT_RECOVERY_REQUIRED' }))
  void result.catch(() => {})
  return result
}
/** Associated with the existing named tool dependencies, never Session IDs. */
class ResidentLifetime {
  retired = false
  readonly records = new Set<RetainedResidentResource>()
  private readonly results = new WeakMap<NonNullable<ChildAgentEntry['resultCapture']>, () => Promise<unknown>>()
  private flight?: Promise<void>
  private cleanupAttempt?: { borrowers: number; generations: Map<RetainedResidentResource, Promise<void>> }
  /** Keep rejected generation joins alive through every alias participating
   * in one external close. A later explicit close gets a fresh attempt. */
  beginCleanupAttempt(): () => void {
    if (!this.cleanupAttempt) {
      const generations = new Map<RetainedResidentResource, Promise<void>>()
      // A normal finally may already own the flight before a direct entry
      // disposer starts. Snapshot that admission without starting new work.
      for (const record of this.records) {
        const original = record.generationCleanup
        if (record.kind === 'generation' && original) generations.set(record, original)
      }
      this.cleanupAttempt = { borrowers: 0, generations }
    }
    const attempt = this.cleanupAttempt
    attempt.borrowers++
    let finished = false
    return () => {
      if (finished) return
      finished = true
      if (--attempt.borrowers === 0 && this.cleanupAttempt === attempt) this.cleanupAttempt = undefined
    }
  }
  joinGenerationCleanup(record: RetainedResidentResource, close: () => Promise<void>): Promise<void> {
    const attempt = this.cleanupAttempt
    if (!attempt) return close()
    let original = attempt.generations.get(record)
    if (!original) { original = close(); attempt.generations.set(record, original) }
    return original
  }
  retain(record: RetainedResidentResource): void {
    if (this.retired) throw Object.assign(new Error('Resident owner retired'), { code: 'FACT_CLOSED' })
    this.records.add(record)
  }
  retire(): void { if (this.retired) return; this.retired = true; for (const record of this.records) record.retire() }
  inInvocation(): boolean { return inOriginalInvocation(this) || [...this.records].some(record => inOriginalInvocation(record)) }
  retainResult(handle: NonNullable<ChildAgentEntry['resultCapture']>, settle: () => Promise<unknown>): void {
    if (!this.results.has(handle)) this.results.set(handle, settle)
  }
  settleEntryResult(entry: ChildAgentEntry): Promise<unknown> {
    const handle = entry.resultCapture
    if (!handle) return Promise.resolve()
    const original = this.results.get(handle)
    return original ? original() : handle.settle()
  }
  generations(entry: ChildAgentEntry): RetainedResidentResource[] { return [...this.records].filter(r => r.kind === 'generation' && r.entry === entry) }
  async closeGenerations(entry: ChildAgentEntry): Promise<void> {
    const results = await Promise.allSettled(this.generations(entry).map(record => record.close()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original generation cleanup incomplete')
  }
  preparationCleanup(entry: ChildAgentEntry): Promise<void> | undefined {
    for (const record of this.records) if (record instanceof ResidentPreparation && record.entry === entry && record.phase === 'retired') return record.cleanup
  }
  close(): Promise<void> {
    this.retire()
    if (this.inInvocation()) return refusedReentry()
    if (this.flight) return this.flight
    const attempt = Promise.withResolvers<void>()
    this.flight = attempt.promise
    const finishCleanup = this.beginCleanupAttempt()
    void attempt.promise.then(() => { this.flight = undefined; finishCleanup() }, () => { this.flight = undefined; finishCleanup() })
    void invokeOriginal(this, async () => {
      const records = [...this.records]
      const results = await Promise.allSettled(records.map(record => record.close()))
      await Promise.allSettled(records.map(record => record.rawNext))
      const settlements = await Promise.allSettled(records.map(record => record.settleResults?.()))
      const failures = [...results, ...settlements].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Original resident cleanup incomplete')
    }).then(attempt.resolve, attempt.reject)
    return attempt.promise
  }
}
const owners = new WeakMap<SubagentToolDeps, ResidentLifetime>()
export function residentOwnerFor(deps: SubagentToolDeps): ResidentLifetime {
  let owner = owners.get(deps)
  if (!owner) { owner = new ResidentLifetime(); owners.set(deps, owner) }
  return owner
}

/** Only resources actually obtained by the original resident setup. */
export class ResidentPreparation implements RetainedResidentResource {
  readonly kind = 'resident' as const
  readonly setupExit = Promise.withResolvers<void>()
  readonly view: ChildAgentEntry['session']
  factOwner: ChildAgentEntry['factOwner']
  phase: 'preparing' | 'installed' | 'retired' | 'closed' = 'preparing'
  private childContext?: import('@i-harness/core-plugin').PluginContext
  private codeMount?: import('@i-harness/code-mode').CodeModeMount
  private unmountContext?: () => unknown
  private cancelMount?: (reason?: string) => Promise<void>
  private disposeMount?: () => Promise<void>
  readyMount?: () => Promise<void>
  agent?: NonNullable<ReturnType<SubagentToolDeps['agents']['get']>>
  registry?: import('@i-harness/core-tools').ToolRegistry
  resultLifetime = true
  setupOutcome: { occurred: false } | { occurred: true; value: unknown } = { occurred: false }
  cleanup?: Promise<void>
  private permanent = false
  private mountDisposed = false
  private documentClosed = false
  private contextClosed = false
  private flight?: Promise<void>
  private readonly coordinator: import('@i-harness/session-persistence').SessionCoordinator | undefined
  private readonly closeDocument?: (sessionId: string) => Promise<void>
  private revokeDocument?: () => void
  private readonly activationCurrent?: () => boolean
  private readonly sessionId: string | undefined
  readonly dispose = (): Promise<void> => {
    const finishCleanup = residentOwnerFor(this.deps).beginCleanupAttempt()
    this.retire()
    const closing = this.close().finally(finishCleanup)
    void closing.catch(() => {})
    return closing
  }
  readonly unmount = (): Promise<void> => this.dispose()
  constructor(readonly deps: SubagentToolDeps, readonly entry: ChildAgentEntry) {
    this.view = entry.session; this.factOwner = entry.factOwner
    this.coordinator = deps.childSessions?.coordinator; this.sessionId = entry.sessionId
    this.closeDocument = this.coordinator?.closeManagedDocument.bind(this.coordinator)
    this.activationCurrent = deps.residentActivation?.current.bind(deps.residentActivation)
    this.bindFactOwner(this.factOwner)
    residentOwnerFor(deps).retain(this)
  }
  bindFactOwner(owner: ChildAgentEntry['factOwner']): void {
    this.factOwner = owner
    const document = owner as import('@i-harness/session-persistence').ManagedDocument | undefined
    if (!this.revokeDocument && this.coordinator && document?.view === this.view && typeof document.revokeNewWork === 'function') this.revokeDocument = document.revokeNewWork.bind(document)
  }
  get ctx() { return this.childContext }
  set ctx(value) { this.childContext = value; this.unmountContext = value?.scope.unmount.bind(value.scope) }
  get mount() { return this.codeMount }
  set mount(value) {
    this.codeMount = value
    this.readyMount = value?.ready?.bind(value)
    this.cancelMount = value?.cancel.bind(value)
    this.disposeMount = value?.dispose.bind(value)
  }
  current(): boolean {
    return !residentOwnerFor(this.deps).retired && (this.phase === 'preparing' || this.phase === 'installed')
      && this.activationCurrent?.() !== false && this.deps.table.get(this.entry.path) === this.entry
      && this.entry.session === this.view && this.entry.factOwner === this.factOwner && !this.entry.closing
      && (this.phase !== 'installed' || !this.sessionId || this.deps.agents.get(this.sessionId) === this.agent)
  }
  retire(): void {
    if (this.phase === 'closed' || this.permanent) return
    this.permanent = true; this.phase = 'retired'
    if (this.deps.table.get(this.entry.path) === this.entry && this.entry.session === this.view && this.entry.factOwner === this.factOwner) {
      this.deps.table.update(this.entry.path, this.entry, { closing: true }); this.entry.controller.abort()
    }
    this.revokeDocument?.()
  }
  failed(): void { if (this.phase !== 'closed') this.phase = 'retired' }
  close(): Promise<void> {
    if (inOriginalInvocation(this)) { this.retire(); return refusedReentry() }
    if (this.flight) return this.flight
    const attempt = Promise.withResolvers<void>()
    this.flight = attempt.promise
    this.cleanup = attempt.promise
    const finishCleanup = residentOwnerFor(this.deps).beginCleanupAttempt()
    void attempt.promise.then(() => { this.flight = undefined; finishCleanup() }, () => { this.flight = undefined; finishCleanup() })
    void invokeOriginal(this, async () => {
      await this.setupExit.promise
      const failures: unknown[] = []
      if (this.mount && !this.mountDisposed) {
        try { await this.cancelMount?.('Original resident closed') } catch (error) { failures.push(error) }
        try { await this.disposeMount?.(); this.mountDisposed = true } catch (error) { failures.push(error) }
      }
      try { await residentOwnerFor(this.deps).closeGenerations(this.entry) } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Original resident producer cleanup incomplete')
      await residentOwnerFor(this.deps).settleEntryResult(this.entry)
      this.resultLifetime = false
      if (this.permanent && this.sessionId && !this.documentClosed) { await this.closeDocument?.(this.sessionId); this.documentClosed = true }
      if (this.ctx && !this.contextClosed) { await this.unmountContext?.(); this.contextClosed = true }
      if (this.sessionId && this.deps.agents.get(this.sessionId) === this.agent) this.deps.agents.remove(this.sessionId)
      if (this.entry.dispose === this.dispose && !this.permanent) this.entry.dispose = undefined
      this.phase = 'closed'; residentOwnerFor(this.deps).records.delete(this)
    }).then(attempt.resolve, attempt.reject)
    return attempt.promise
  }
}
