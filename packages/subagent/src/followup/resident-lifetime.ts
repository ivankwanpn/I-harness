import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildAgentEntry } from '../agent-table.ts'
import type { SubagentToolDeps } from '../tools/types.ts'
import { isNondurableSession } from '@i-harness/core-session'
import {readOriginalTeamCleanup} from '../team-cleanup.ts'

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
  private readonly initialSetups = new Set<import('../child/instruction-context.ts').InitialChildSetup>()
  private readonly results = new WeakMap<NonNullable<ChildAgentEntry['resultCapture']>, () => Promise<unknown>>()
  private flight?: Promise<void>
  private cleanupAttempt?: { borrowers: number; generations: Map<RetainedResidentResource, Promise<void>>; publications: Map<ResidentPreparation, Promise<void>> }
  /** Keep rejected generation joins alive through every alias participating
   * in one external close. A later explicit close gets a fresh attempt. */
  beginCleanupAttempt(): () => void {
    if (!this.cleanupAttempt) {
      const generations = new Map<RetainedResidentResource, Promise<void>>()
      const publications = new Map<ResidentPreparation, Promise<void>>()
      // A normal finally may already own the flight before a direct entry
      // disposer starts. Snapshot that admission without starting new work.
      for (const record of this.records) {
        const original = record.generationCleanup
        if (record.kind === 'generation' && original) generations.set(record, original)
        // A normal finally may already be settling this preparation before
        // the outer scope exists. Preserve that outcome across delayed records.
        if (record instanceof ResidentPreparation && record.publicationSettlement) publications.set(record, record.publicationSettlement)
      }
      this.cleanupAttempt = { borrowers: 0, generations, publications }
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
  joinPublicationSettlement(record: ResidentPreparation, settle: () => Promise<void>): Promise<void> {
    const scope = this.cleanupAttempt
    if (!scope) return settle()
    const original = scope.publications.get(record)
    if (original) return original
    const attempt = Promise.withResolvers<void>()
    // Admission precedes callbacks, and rejection remains in the scope until
    // its final borrower exits. A later explicit attempt gets a new map.
    scope.publications.set(record, attempt.promise)
    void Promise.resolve().then(settle).then(attempt.resolve, attempt.reject)
    return attempt.promise
  }
  retain(record: RetainedResidentResource): void {
    if (this.retired) throw Object.assign(new Error('Resident owner retired'), { code: 'FACT_CLOSED' })
    this.records.add(record)
  }
  retainInitial(setup: import('../child/instruction-context.ts').InitialChildSetup): () => void {
    if (this.retired) { setup.retire(); throw Object.assign(new Error('Resident owner retired'), { code: 'FACT_CLOSED' }) }
    this.initialSetups.add(setup)
    return () => { this.initialSetups.delete(setup) }
  }
  retire(): void { if (this.retired) return; this.retired = true; for (const record of this.records) record.retire(); for (const setup of this.initialSetups) setup.retire() }
  inInvocation(): boolean { return inOriginalInvocation(this) || [...this.records, ...this.initialSetups].some(record => inOriginalInvocation(record)) }
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
  preparation(entry: ChildAgentEntry, view: ChildAgentEntry['session'], owner: ChildAgentEntry['factOwner']): ResidentPreparation | undefined {
    for (const record of this.records) if (record instanceof ResidentPreparation && record.entry === entry && record.view === view && record.factOwner === owner) return record
  }
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
      const results = await Promise.allSettled([...records.map(record => record.close()), ...[...this.initialSetups].map(setup => setup.close())])
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
  private instructionLease?: import('../child/instruction-context.ts').ChildInstructionContext
  private retireInstruction?: () => void
  private closeInstruction?: () => Promise<void>
  private settleInstruction?: () => Promise<void>
  private publicationFlight?: Promise<void>
  private settleDocument?: () => Promise<void>
  private instructionRetired = false
  private instructionClosed = false
  private readonly path: string
  private readonly offTable: () => void
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
    this.path = entry.path
    this.view = entry.session; this.factOwner = entry.factOwner
    this.coordinator = deps.childSessions?.coordinator; this.sessionId = entry.sessionId
    this.closeDocument = this.coordinator?.closeManagedDocument.bind(this.coordinator)
    this.activationCurrent = deps.residentActivation?.current.bind(deps.residentActivation)
    this.bindFactOwner(this.factOwner)
    residentOwnerFor(deps).retain(this)
    this.offTable = deps.table.subscribe(() => {
      if (this.phase === 'closed' || this.permanent) return
      if (deps.table.get(this.path) !== entry || entry.session !== this.view || entry.factOwner !== this.factOwner || entry.closing) this.retire()
    })
  }
  bindFactOwner(owner: ChildAgentEntry['factOwner']): void {
    this.factOwner = owner
    const document = owner as import('@i-harness/session-persistence').ManagedDocument | undefined
    if (!this.revokeDocument && this.coordinator && document?.view === this.view && typeof document.revokeNewWork === 'function') this.revokeDocument = document.revokeNewWork.bind(document)
    if (!this.settleDocument && document?.view === this.view && typeof document.settleFinishedActions === 'function') this.settleDocument = document.settleFinishedActions.bind(document)
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
  get instruction() { return this.instructionLease }
  set instruction(value) {
    this.instructionLease = value
    this.retireInstruction = value?.retire.bind(value)
    this.closeInstruction = value?.close.bind(value)
    this.settleInstruction = typeof value?.settleOriginals === 'function' ? value.settleOriginals.bind(value) : undefined
    // An admitted factory may return after synchronous retirement callbacks.
    // Retain that original before fencing and closing it.
    if (this.phase === 'retired' || this.permanent) this.retireInstructions()
  }
  get publicationSettlement(): Promise<void> | undefined { return this.publicationFlight }
  settleOriginals(): Promise<void> {
    return residentOwnerFor(this.deps).joinPublicationSettlement(this, () => {
      if (this.publicationFlight) return this.publicationFlight
      const attempt = Promise.withResolvers<void>()
      this.publicationFlight = attempt.promise
      void attempt.promise.then(() => { this.publicationFlight = undefined }, () => { this.publicationFlight = undefined })
      void Promise.resolve().then(async () => {
        if (!this.instructionLease) return
        if (!this.settleInstruction) throw Object.assign(new Error('Original instruction settlement capability unavailable'), { code: 'GENERATION_UNSUPPORTED' })
        await this.settleInstruction()
      }).then(attempt.resolve, attempt.reject)
      return attempt.promise
    })
  }
  async settleFinishedActions(): Promise<void> {
    if (isNondurableSession(this.view)) return
    if (!this.settleDocument) throw Object.assign(new Error('Original document settlement capability unavailable'), { code: 'GENERATION_UNSUPPORTED' })
    await this.settleDocument()
  }
  private retireInstructions(): void {
    if (!this.retireInstruction || this.instructionRetired) return
    this.instructionRetired = true
    this.retireInstruction()
  }
  current(): boolean {
    return !residentOwnerFor(this.deps).retired && (this.phase === 'preparing' || this.phase === 'installed')
      && this.activationCurrent?.() !== false && this.deps.table.get(this.path) === this.entry
      && this.entry.session === this.view && this.entry.factOwner === this.factOwner && this.factOwner?.view === this.view && !this.entry.closing
      && this.entry.dispose === this.dispose
      && (this.phase !== 'installed' || this.entry.toolRegistry === this.registry && (!this.sessionId || this.deps.agents.get(this.sessionId) === this.agent))
  }
  retire(): void {
    if (this.phase === 'closed' || this.permanent) return
    this.permanent = true; this.phase = 'retired'
    this.retireInstructions()
    if (this.deps.table.get(this.path) === this.entry && this.entry.session === this.view && this.entry.factOwner === this.factOwner) {
      const cleanup=readOriginalTeamCleanup(this.deps.table,this.path,this.entry)
      if(cleanup)cleanup.markClosing();else this.deps.table.update(this.path, this.entry, { closing: true }); this.entry.controller.abort()
    }
    this.revokeDocument?.()
  }
  failed(): void { if (this.phase !== 'closed') { this.phase = 'retired'; this.retireInstructions() } }
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
      if (this.instruction && !this.instructionClosed) { await this.closeInstruction?.(); this.instructionClosed = true }
      this.resultLifetime = false
      if (this.permanent && this.sessionId && !this.documentClosed) { await this.closeDocument?.(this.sessionId); this.documentClosed = true }
      if (this.ctx && !this.contextClosed) { await this.unmountContext?.(); this.contextClosed = true }
      if (this.sessionId && this.deps.agents.get(this.sessionId) === this.agent) this.deps.agents.remove(this.sessionId)
      if (this.entry.dispose === this.dispose && !this.permanent) this.entry.dispose = undefined
      this.phase = 'closed'; this.offTable(); residentOwnerFor(this.deps).records.delete(this)
    }).then(attempt.resolve, attempt.reject)
    return attempt.promise
  }
}
