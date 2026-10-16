import type { SessionEvent } from '../events/types.ts'
import type { FactOutcome, SeqRef } from './types.ts'
import type { AcceptedDraft, LifecycleFact, MetadataFact, UsageDraft, TeamFact } from './groups.ts'

type Event<K extends SessionEvent['type']> = Extract<SessionEvent, { type: K }>
export type CodeSettlementFact = Event<'code/result' | 'code/output'>
  | (Omit<Event<'code/cell'>, 'state'> & { state: 'completed' | 'failed' | 'terminated' | 'interrupted' })
export interface InputFacts<Outcome = FactOutcome> {
  scheduled(dispatches: readonly Event<'schedule/change'>[], admitted: Event<'agent/input/admitted'>): Promise<Outcome>
  admit(event: Event<'agent/input/admitted'>): Promise<Outcome>
  cancel(event: Event<'agent/input/cancelled'>): Promise<Outcome>
  start(promoted: Event<'agent/input/promoted'> | undefined, message: Event<'user/message'>): Promise<Outcome>
  claim(promoted: Event<'agent/input/promoted'>, message: Event<'user/message'>): Promise<Outcome>
}
export interface AgentFacts<Outcome = FactOutcome> {
  auditAssistant(event: Event<'assistant/message'>): Promise<Outcome>
  feedback(event: Event<'user/message'> & { source: { kind: 'plugin'; plugin: string } }): Promise<Outcome>
  lifecycle(event: LifecycleFact): Promise<Outcome>
  accept(assistant: Event<'assistant/message'>, accepted: AcceptedDraft): Promise<Outcome>
  usage(event: UsageDraft): Promise<Outcome>
}
export interface ToolFacts<Outcome = FactOutcome> {
  call(event: Event<'tool/call'>): Promise<Outcome>
  dispatch(callId: string, reference?: SeqRef<'tool/call'>): Promise<Outcome>
  result(event: Event<'tool/result'>): Promise<Outcome>
}
export interface CodeFacts<Outcome = FactOutcome> {
  record(event: Event<'code/cell' | 'code/call' | 'code/result' | 'code/output' | 'code/store'>): Promise<Outcome>
  dispatch(cellId: string, callId: string, reference: SeqRef<'code/call'>): Promise<Outcome>
}
export interface DeliveryFacts<Outcome = FactOutcome> {
  record(event: Event<'subagent/start' | 'subagent/end' | 'subagent/inbox' | 'job/status' | 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'>): Promise<Outcome>
}
export type DeliverySettlementFact = Exclude<Parameters<DeliveryFacts['record']>[0], Event<'subagent/start'>>
export type RequiredLifecycleFact = Event<'step/end' | 'turn/end' | 'step/failed' | 'reasoning'>
export interface MetadataFacts<Outcome = FactOutcome> {
  admit(event: MetadataFact): Promise<Outcome>; enterPlan(proposal: string): Promise<Outcome>
  importPolicy(modes: readonly Event<'sandbox/mode'>[]): Promise<Outcome>
}
export interface LegacyCompactionFacts<Outcome = FactOutcome> {
  commit(events: readonly Event<'compaction/start' | 'compaction/end' | 'compaction/summary' | 'compaction/reset' | 'compaction/prune' | 'rewind/point'>[]): Promise<Outcome>
}
/** Composition-only bundle. Each execution subsystem receives its narrow port. */
export interface FactPorts<Outcome = FactOutcome> {
  inputs: InputFacts<Outcome>; agent: AgentFacts<Outcome>; tools: ToolFacts<Outcome>; code: CodeFacts<Outcome>
  delivery: DeliveryFacts<Outcome>; metadata: MetadataFacts<Outcome>; compaction: LegacyCompactionFacts<Outcome>
}
export interface SettlementFacts<Outcome = FactOutcome> {
  assertHeld(): void
  close(): Promise<void>
  /** The registered real source retains an outcome it cannot finalize/capture.
   * This blocks new work without claiming an unknown journal issuance. */
  requireRecovery(): void
  retention: { capture(event: Event<'context/result-ref'>): CapturedSettlementFact<Outcome> }
  rewind: { capture(event: Event<'rewind/point'>): CapturedSettlementFact<Outcome> }
  tools: Pick<ToolFacts<Outcome>, 'result'> & { captureResult(event: Event<'tool/result'>): CapturedSettlementFact<Outcome> }
  code: { record(event: CodeSettlementFact): Promise<Outcome>; capture(event: CodeSettlementFact): CapturedSettlementFact<Outcome> }
  delivery: { record(event: DeliverySettlementFact): Promise<Outcome>; capture(event: DeliverySettlementFact): CapturedSettlementFact<Outcome> }
  lifecycle: Pick<AgentFacts<Outcome>, 'usage' | 'auditAssistant'> & { lifecycle(event: RequiredLifecycleFact): Promise<Outcome> }
}
export interface CapturedActionFact<Outcome = FactOutcome> {
  admit(): Promise<Outcome>
  reconcile(): Promise<Outcome>
  /** Read only the retained disposition; never allocate or perform I/O. */
  observe(): Promise<Outcome>
}
export interface CapturedSettlementFact<Outcome = FactOutcome> extends CapturedActionFact<Outcome> {
  /** Explicit source request only, after backend-proven absence. */
  retryAbsent(): Promise<Outcome>
}
/** Composition-only trusted input owner. Saving received text and cancelling
 * its pending inputs confer no authority to promote or start new work. */
export interface ReceivedInputSource<Outcome = ProducerFactOutcome> {
  close(): Promise<void>
  captureAdmitted(event: Event<'agent/input/admitted'>): CapturedSettlementFact<Outcome>
  captureCancellation(event: Event<'agent/input/cancelled'>): CapturedSettlementFact<Outcome>
}
export interface ManagedAction<Outcome = FactOutcome> {
  readonly signal: AbortSignal
  readonly facts: FactPorts<Outcome>
  captureCodeStore(event: Event<'code/store'>): CapturedActionFact<Outcome>
  captureTeamTransaction(events: readonly TeamFact[]): CapturedActionFact<Outcome>
  captureSubagentStart(event: Event<'subagent/start'>): CapturedActionFact<Outcome>
  assertOpen(): void
  stop(): void
  finish(): void
  registerSettlementSource(drain: () => Promise<void>, reconcilePending?: () => Promise<void>): SettlementFacts<Outcome>
}

export type NondurableFactOutcome = { kind: "memory-committed"; durability: "nondurable"; seqs: readonly number[] } | Extract<FactOutcome, { kind: "not-issued" }>
export type ProducerFactOutcome = FactOutcome | NondurableFactOutcome
export interface FactOwner<Outcome = ProducerFactOutcome> {
  readonly view: import("./types.ts").SessionView
  beginAction(signal?: AbortSignal): ManagedAction<Outcome>
  registerReceivedInputSource(drain: () => Promise<void>): ReceivedInputSource<Outcome>
  drain?(): Promise<void>
}
export type MetadataFactSource = MetadataFacts<ProducerFactOutcome> | ((signal?: AbortSignal) => MetadataFacts<ProducerFactOutcome>)
export type FeedbackFactSource = Pick<AgentFacts<ProducerFactOutcome>, 'feedback'> | ((signal?: AbortSignal) => Pick<AgentFacts<ProducerFactOutcome>, 'feedback'>)
