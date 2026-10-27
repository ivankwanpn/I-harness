import { isNondurableSession, type SessionEventView, type FactOwner, type ManagedAction, type ProducerFactOutcome } from '@i-harness/core-session'
import type { AgentInputOptions, AgentGenerationLifecycle } from '@i-harness/core-agent'
import type { ChildAgentEntry } from '../agent-table.ts'
import type { SubagentToolDeps } from '../tools/types.ts'
import { childFactOwner } from '../child/document.ts'
import { residentOwnerFor, inOriginalInvocation, invokeOriginal, refusedReentry, type RetainedResidentResource } from './resident-lifetime.ts'

type Inbox = Extract<SessionEventView, { type: 'subagent/inbox' }>
export interface FollowupGenerationIntent {
  readonly start: { readonly wall: number; readonly monotonic: number }
  readonly timeoutMs?: number
  readonly maxAttempts?: number
}
export interface FollowupGeneration { options?: AgentInputOptions; close(): Promise<void> }

/** An original result method has its own acknowledgment, not drive success. */
class OriginalResult {
  private settleOriginal?: () => Promise<unknown>
  private flight?: Promise<unknown>
  acknowledged = false
  private value: unknown
  constructor(handle: NonNullable<ChildAgentEntry['resultCapture']>, private owner?: object) { this.settleOriginal = handle.settle.bind(handle) }
  settle(): Promise<import('../task/result.ts').TaskResultProjection> {
    if (this.acknowledged) return Promise.resolve(this.value as import('../task/result.ts').TaskResultProjection)
    if (this.flight) return this.flight as Promise<import('../task/result.ts').TaskResultProjection>
    const attempt = Promise.withResolvers<unknown>()
    this.flight = attempt.promise
    void attempt.promise.then(value => {
      this.value = value; this.acknowledged = true; this.flight = undefined
      // A live entry's latest result must not retain a chain of completed
      // execution records through their previous-result handles.
      this.settleOriginal = undefined; this.owner = undefined
    }, () => { this.flight = undefined })
    const owner = this.owner!, settle = this.settleOriginal!
    void invokeOriginal(owner, async () => settle()).then(attempt.resolve, attempt.reject)
    return attempt.promise as Promise<import('../task/result.ts').TaskResultProjection>
  }
}

class OriginalGeneration implements RetainedResidentResource {
  readonly kind = 'generation' as const
  readonly view: ChildAgentEntry['session']
  ownerAtCapture: FactOwner | undefined
  bodyExit = Promise.withResolvers<void>()
  readonly openingExit = Promise.withResolvers<void>()
  rawNext?: Promise<void>
  controller?: AbortController
  source?: import('../task/result.ts').TaskResultStore
  previousResult?: ChildAgentEntry['resultCapture']
  private previousSettlement?: OriginalResult
  private resultSettlement?: OriginalResult
  private action?: ManagedAction<ProducerFactOutcome>
  private lifecycle?: AgentGenerationLifecycle
  private generation?: NonNullable<AgentInputOptions['generation']>
  private closeOriginalGeneration?: NonNullable<AgentInputOptions['generation']>['close']
  private drainOriginalLifecycle?: AgentGenerationLifecycle['drain']
  private finishOriginalAction?: ManagedAction<ProducerFactOutcome>['finish']
  private generationClosed = false
  private lifecycleDrained = false
  private actionFinished = false
  private flight?: Promise<void>
  private opening = false
  private exited = false
  private retired = false
  private hasBody = false
  private openAttempted = false
  private sourceAdmitted = false
  private cleanupAcknowledged = false
  private readonly generationFactory: SubagentToolDeps['generationFactoryFor']
  bodyOutcome: { occurred: false } | { occurred: true; value: unknown } = { occurred: false }
  constructor(readonly deps: SubagentToolDeps, readonly entry: ChildAgentEntry, readonly input: Inbox, readonly intent: FollowupGenerationIntent) {
    this.view = entry.session; this.ownerAtCapture = entry.factOwner
    this.generationFactory = deps.generationFactoryFor?.bind(deps)
  }
  matches(entry: ChildAgentEntry, input: Inbox): boolean {
    return entry === this.entry && entry.session === this.view && entry.factOwner === this.ownerAtCapture && input.seq === this.input.seq && input.messageId === this.input.messageId
  }
  begin(rawNext: Promise<void>): this {
    if (this.hasBody && (!this.exited || this.openAttempted || this.sourceAdmitted || this.flight)) throw Object.assign(new Error('Original inbox execution already admitted'), { code: 'GENERATION_CLOSED' })
    if (this.hasBody) this.bodyExit = Promise.withResolvers<void>()
    this.hasBody = true; this.exited = false
    this.cleanupAcknowledged = false
    this.rawNext = rawNext; void rawNext.catch(() => {})
    return this
  }
  exitBody(outcome: typeof this.bodyOutcome = { occurred: false }): void {
    this.bodyOutcome = outcome; this.exited = true; this.bodyExit.resolve()
    if (!this.opening) this.openingExit.resolve()
  }
  retire(): void { this.retired = true; this.controller?.abort() }
  invoke<T>(work: () => T): T { return invokeOriginal(this, work) }
  settlePrevious(handle: ChildAgentEntry['resultCapture']): Promise<unknown> {
    if (!handle) return Promise.resolve()
    if (!this.previousSettlement) {
      this.previousResult = handle; this.previousSettlement = new OriginalResult(handle, this)
      residentOwnerFor(this.deps).retainResult(handle, this.previousSettlement.settle.bind(this.previousSettlement))
    }
    return this.previousSettlement.settle()
  }
  retainResult(handle: NonNullable<ChildAgentEntry['resultCapture']>): void {
    this.resultSettlement = new OriginalResult(handle, this)
    residentOwnerFor(this.deps).retainResult(handle, this.resultSettlement.settle.bind(this.resultSettlement))
  }
  settleResult(): Promise<import('../task/result.ts').TaskResultProjection> { return this.resultSettlement!.settle() }
  async settleResults(): Promise<void> {
    if (this.hasBody) await this.bodyExit.promise
    const results = await Promise.allSettled([this.previousSettlement?.settle(), this.resultSettlement?.settle()])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original inbox result settlement incomplete')
    this.releaseIfClean()
  }
  private releaseIfClean(): void {
    const fenced = this.retired || this.deps.table.get(this.entry.path) !== this.entry || this.entry.session !== this.view || this.entry.factOwner !== this.ownerAtCapture
    if (this.cleanupAcknowledged && this.previousSettlement?.acknowledged !== false && this.resultSettlement?.acknowledged !== false
      && (fenced || (this.entry.lastInboxSeq ?? -1) >= (this.input.seq ?? 0))) residentOwnerFor(this.deps).records.delete(this)
  }
  admitSource(): void { this.sourceAdmitted = true }
  preparationCleanup(): Promise<void> | undefined { return residentOwnerFor(this.deps).preparationCleanup(this.entry) }
  async open(controller: AbortController, current: () => boolean): Promise<FollowupGeneration> {
    if (this.openAttempted || this.retired) throw Object.assign(new Error('Original generation is closed'), { code: 'GENERATION_CLOSED' })
    this.openAttempted = true; this.opening = true; this.controller = controller
    try {
      const owner = await invokeOriginal(this, () => childFactOwner(this.entry, this.deps.childSessions?.coordinator))
      if (!this.ownerAtCapture && !this.deps.residentActivation) this.ownerAtCapture = owner
      if (!current()) return { close: () => this.close() }
      if (isNondurableSession(owner.view)) return { close: () => this.close() }
      if (!this.entry.sessionId || !this.generationFactory) throw Object.assign(new Error('Child generation ownership is unavailable'), { code: 'GENERATION_UNSUPPORTED' })
      this.action = invokeOriginal(this, () => owner.beginAction(controller.signal))
      this.finishOriginalAction = this.action.finish.bind(this.action)
      if (!current()) return { close: () => this.close() }
      const factory = this.generationFactory
      this.lifecycle = invokeOriginal(this, () => factory(owner, this.entry.sessionId!, () => this.entry.executionModel?.())(this.action!))
      this.drainOriginalLifecycle = this.lifecycle.drain.bind(this.lifecycle)
      if (!current()) return { close: () => this.close() }
      const origin = { kind: 'delegated-input' as const, ref: 'inbox' as const, seq: this.input.seq!, messageId: this.input.messageId }
      this.generation = await invokeOriginal(this, () => this.lifecycle!.open('main', origin, { signal: controller.signal, start: this.intent.start, timeoutMs: this.intent.timeoutMs, maxAttempts: this.intent.maxAttempts }))
      this.closeOriginalGeneration = this.generation.close.bind(this.generation)
      return { options: { generation: this.generation, delegatedOrigin: origin, provenance: this.input.provenance! }, close: () => this.close() }
    } finally { this.opening = false; this.openingExit.resolve() }
  }
  close(): Promise<void> {
    if (inOriginalInvocation(this)) { this.retire(); return refusedReentry() }
    return residentOwnerFor(this.deps).joinGenerationCleanup(this, () => this.closeOriginals())
  }
  get generationCleanup(): Promise<void> | undefined { return this.flight }
  private closeOriginals(): Promise<void> {
    if (this.flight) return this.flight
    const attempt = Promise.withResolvers<void>()
    this.flight = attempt.promise
    void attempt.promise.then(() => { this.flight = undefined }, () => { this.flight = undefined })
    void invokeOriginal(this, async () => {
      if (this.hasBody) await this.bodyExit.promise
      if (this.opening) await this.openingExit.promise
      if (this.generation && !this.generationClosed) { await this.closeOriginalGeneration!(this.controller?.signal.aborted ? 'stopped' : 'failed'); this.generationClosed = true }
      if (this.lifecycle && !this.lifecycleDrained) { await this.drainOriginalLifecycle!(); this.lifecycleDrained = true }
      if (this.action && !this.actionFinished) { this.finishOriginalAction!(); this.actionFinished = true }
      this.cleanupAcknowledged = true
      this.releaseIfClean()
    }).then(attempt.resolve, attempt.reject)
    return attempt.promise
  }
}

const intents = new WeakMap<FollowupGenerationIntent, OriginalGeneration>()
export function captureFollowupGenerationIntent(deps: SubagentToolDeps, entry: ChildAgentEntry, input: Inbox): FollowupGenerationIntent {
  const owner = residentOwnerFor(deps)
  for (const record of owner.generations(entry)) if (record instanceof OriginalGeneration && record.matches(entry, input)) return record.intent
  if (deps.residentActivation && entry.factOwner?.view !== entry.session) throw Object.assign(new Error('Restored inbox requires its exact FactOwner'), { code: 'FACT_OWNER_UNSUPPORTED' })
  const intent = Object.freeze({ start: Object.freeze({ wall: Date.now(), monotonic: performance.now() }), ...(deps.modelActionTimeoutMs !== undefined ? { timeoutMs: deps.modelActionTimeoutMs } : {}), ...(deps.modelActionMaxAttempts !== undefined ? { maxAttempts: deps.modelActionMaxAttempts } : {}) })
  const record = new OriginalGeneration(deps, entry, input, intent)
  owner.retain(record); intents.set(intent, record)
  return intent
}
export function beginFollowupExecution(intent: FollowupGenerationIntent | undefined, rawNext: Promise<void>): OriginalGeneration | undefined {
  if (!intent) return undefined
  const record = intents.get(intent)
  if (!record) throw new TypeError('Original inbox intent required')
  return record.begin(rawNext)
}
/** Opening never substitutes scalar-identical intent or repeats an origin. */
export async function openFollowupGeneration(deps: SubagentToolDeps, entry: ChildAgentEntry, input: Inbox, controller: AbortController, originalIntent?: FollowupGenerationIntent, executionCurrent: () => boolean = () => true): Promise<FollowupGeneration> {
  const intent = originalIntent ?? captureFollowupGenerationIntent(deps, entry, input)
  const record = intents.get(intent)
  if (!record || record.deps !== deps || !record.matches(entry, input)) throw new TypeError('Original inbox intent required')
  if (!originalIntent) record.exitBody()
  return record.open(controller, executionCurrent)
}
