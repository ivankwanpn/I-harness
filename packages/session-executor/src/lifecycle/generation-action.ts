import { randomUUID } from 'node:crypto'
import { generationLimits, type GenerationAcceptanceDraft, type GenerationActionEvent, type GenerationActionState, type GenerationAttemptEvent, type GenerationCandidate, type GenerationEvent, type GenerationLane, type SessionEvent, type SessionView } from '@i-harness/core-session'
import { modelExecutionSource, assertOwnedPreparedTerminal, createGenerationControl, generationError, NO_GENERATION_RETRY, type ExecutionConfirmation, type GenerationControl, type GenerationReservation, type ModelClient, type PreparedModelRequest } from '@i-harness/llm-seam'
import { isMockClient, mockExecutionClient, mockPreparedClient } from '@i-harness/llm-mock'
import type { AgentGenerationAction } from '@i-harness/core-agent'
import type { generationClock } from './generation-clock.ts'
import type { GenerationIssue } from '@i-harness/llm-seam'

type Reserved = Extract<GenerationAttemptEvent, { op: 'reserve' }>
type Settlement = Extract<GenerationAttemptEvent, { op: 'settle' }> | Extract<GenerationActionEvent, { op: 'close' | 'local-settle' }>
export interface GenerationActionDocument {
  readonly view: SessionView; readonly ownerSessionId: string; readonly incarnation: string
  assertOpen(): void
  read(actionId: string): GenerationActionState | undefined
  append(events: readonly GenerationEvent[], current: () => boolean): Promise<void>
  settle(event: Settlement): Promise<void>
  phase(recovery: Extract<SessionEvent, { type: 'context/recovery' }>, phase: Omit<Extract<GenerationActionEvent, { op: 'phase' }>, 'seq' | 'recoverySeq'>, current: () => boolean): Promise<void>
}
export interface GenerationActionPolicy {
  maxAttempts?: number
  localTest?: { enabled: boolean; selectedClient(): ModelClient | undefined }
}

/** Durable state owns limits. Private fields retain only one live ticket,
 * known-unsent proof and its exact process-local single-use capabilities. */
export class OwnedGenerationAction implements AgentGenerationAction {
  readonly actionId: string
  readonly openedSeq: number
  readonly signal: AbortSignal
  private knownUnsent: Reserved | undefined
  private latestIssued: { attemptId: string; confirmation: GenerationIssue } | undefined
  private pending = false
  private closing: Promise<void> | undefined
  private adopted = false
  private localIdentity: object | undefined
  private latestLocal: string | undefined
  constructor(private readonly initial: GenerationActionState, private readonly clock: ReturnType<typeof generationClock>, private readonly document: GenerationActionDocument, private readonly policy: GenerationActionPolicy) {
    this.actionId = initial.opened.actionId; this.openedSeq = initial.opened.seq!; this.signal = clock.signal
  }
  private state() { return this.document.read(this.actionId) }
  private envelope() { return { version: 1 as const, ownerSessionId: this.document.ownerSessionId, actionId: this.actionId, trustedAt: Math.max(this.clock.now(), this.state()?.trustedAt ?? 0) } }
  private current() {
    this.document.assertOpen()
    const current = this.state()
    if (!current || current.closed) throw generationError('GENERATION_CLOSED')
    this.clock.constrain(current.expiresAt); this.clock.check()
    return current
  }
  private stillCurrent = () => { try { this.current(); return true } catch { return false } }
  assertOpen() { this.current() }
  adopt(target: SessionView, inputId: string, preparationId: string, signal: AbortSignal) {
    this.current(); signal.throwIfAborted()
    const admission = this.document.view.events[this.initial.opened.origin.seq]
    const result = this.document.view.events.findLast(event => event.type === 'agent/input/preparation' && event.preparationId === preparationId)
    if (target !== this.document.view || this.adopted || this.initial.opened.purpose !== 'main' || !['input', 'observation-input'].includes(this.initial.opened.origin.kind)
      || admission?.type !== 'agent/input/admitted' || admission.inputId !== inputId
      || result?.type !== 'agent/input/preparation' || result.op !== 'completed' || result.actionId !== this.actionId || result.inputId !== inputId) throw generationError('GENERATION_STALE')
    this.adopted = true
  }
  adoptManual(target: SessionView, signal: AbortSignal) {
    this.current(); signal.throwIfAborted()
    const command = this.document.view.events[this.initial.opened.origin.seq]
    if (target !== this.document.view || this.adopted || this.initial.opened.purpose !== 'manual' || this.initial.opened.origin.kind !== 'command' || command?.type !== 'command/run') throw generationError('GENERATION_STALE')
    this.adopted = true
  }
  adoptDelegated(target: SessionView, origin: Extract<import('@i-harness/core-session').GenerationOrigin, { kind: 'delegated-input' }>, signal: AbortSignal) {
    this.current(); signal.throwIfAborted()
    const expected = this.initial.opened.origin, event = this.document.view.events[origin.seq]
    const matches = expected.kind === 'delegated-input' && expected.ref === origin.ref && expected.seq === origin.seq
      && (expected.ref === 'admitted' ? origin.ref === 'admitted' && expected.inputId === origin.inputId && event?.type === 'agent/input/admitted' && event.inputId === origin.inputId
        : origin.ref === 'inbox' && expected.messageId === origin.messageId && event?.type === 'subagent/inbox' && event.messageId === origin.messageId)
    if (target !== this.document.view || this.adopted || this.initial.opened.purpose !== 'main' || !matches
      || !target.header?.parentSession || origin.seq < (target.header.seedLength ?? 0)) throw generationError('GENERATION_STALE')
    this.adopted = true
  }
  async bind(prepared: PreparedModelRequest, source: 'owner' | 'summary' = 'owner') {
    const current = this.current(), candidateClient = this.policy.localTest?.selectedClient(), selected = candidateClient ? modelExecutionSource(candidateClient) : undefined, local = prepared.localExecutionIdentity
    if (local && (!this.policy.localTest?.enabled || !selected || !isMockClient(selected) || mockExecutionClient(local) !== selected || mockPreparedClient(prepared) !== selected)) throw generationError('GENERATION_UNSUPPORTED')
    const executionDomain = local ? 'local-test' as const : 'physical' as const
    if (!local) assertOwnedPreparedTerminal(prepared)
    if (current.bound) {
      if (current.bound.executionDomain !== executionDomain) throw generationError('GENERATION_UNSUPPORTED')
      this.localIdentity = local
      if (source === 'owner') {
        const next = generationLimits(this.initial.opened.purpose, prepared.retryPolicy ?? NO_GENERATION_RETRY, this.policy.maxAttempts)
        const limits = { total: Math.min(current.limits!.total, next.total), main: Math.min(current.limits!.main, next.main), recovery: Math.min(current.limits!.recovery, next.recovery), summary: Math.min(current.limits!.summary, next.summary) }
        if ((Object.keys(limits) as (keyof typeof limits)[]).some(key => limits[key] !== current.limits![key])) await this.document.append([{ ...this.envelope(), type: 'context/action', op: 'constrain', expiresAt: current.expiresAt, limits }], this.stillCurrent)
      }
      return
    }
    this.localIdentity = local
    const retry = prepared.retryPolicy ?? NO_GENERATION_RETRY, limits = generationLimits(this.initial.opened.purpose, retry, this.policy.maxAttempts)
    await this.document.append([{ ...this.envelope(), type: 'context/action', op: 'bind', executionDomain, retry, limits }], this.stillCurrent)
  }
  async bindAudio() {
    const current = this.current()
    if (current.opened.purpose !== 'media' || current.bound && current.bound.executionDomain !== 'physical') throw generationError('GENERATION_UNSUPPORTED')
    if (current.bound) return
    await this.document.append([{ ...this.envelope(), type: 'context/action', op: 'bind', executionDomain: 'physical', retry: NO_GENERATION_RETRY, limits: generationLimits('media', NO_GENERATION_RETRY) }], this.stillCurrent)
  }
  control(lane: GenerationLane, checkCurrent?: () => void): GenerationControl {
    return createGenerationControl({ signal: this.signal, reserve: candidate => this.reserve(candidate, lane, checkCurrent), invokeLocal: identity => this.invokeLocal(identity, lane, checkCurrent) })
  }
  private async reserve(candidate: GenerationCandidate, lane: GenerationLane, checkCurrent?: () => void): Promise<GenerationReservation> {
    const current = this.current(), bound = current.bound
    if (!bound || this.pending) throw generationError('GENERATION_UNCERTAIN')
    if (current.attempts.some(value => !value.disposition || value.disposition === 'issued' || value.disposition === 'unknown')) throw generationError('GENERATION_UNCERTAIN')
    if (bound.executionDomain !== 'physical') throw generationError('GENERATION_UNSUPPORTED')
    if ((current.opened.purpose === 'media') !== (candidate.payloadKind === 'audio-json-body')) throw generationError('GENERATION_UNSUPPORTED')
    this.pending = true
    let reservation: Reserved, rebinds = 0
    try {
      checkCurrent?.()
      if (this.knownUnsent) {
        reservation = this.knownUnsent
        rebinds = current.attempts.find(value => value.reservation.attemptId === reservation.attemptId)!.rebinds + 1
        if (rebinds > 3 || current.attempts.reduce((sum, attempt) => sum + attempt.rebinds, 0) >= 3) throw generationError('GENERATION_EXHAUSTED')
        await this.document.append([{ ...this.envelope(), ...candidate, type: 'context/attempt', op: 'rebind', attemptId: reservation.attemptId, incarnation: this.document.incarnation, rebind: rebinds }], this.stillCurrent)
        this.knownUnsent = undefined
      } else {
        const laneLimit = lane === 'auxiliary' ? current.limits!.total : current.limits![lane]
        if (current.attempts.length >= current.limits!.total || current.attempts.filter(value => value.reservation.lane === lane).length >= laneLimit) throw generationError('GENERATION_EXHAUSTED')
        reservation = { ...this.envelope(), ...candidate, type: 'context/attempt', op: 'reserve', attemptId: randomUUID(), ordinal: current.attempts.length + 1, lane, cause: lane === 'summary' ? 'piece' : lane === 'recovery' ? 'changed-input' : lane === 'auxiliary' ? 'auxiliary' : current.attempts.length ? 'retry' : 'initial', incarnation: this.document.incarnation }
        await this.document.append([reservation], this.stillCurrent)
      }
    } catch (error) { this.pending = false; throw error }
    let issued = false, settled = false, confirmation: GenerationIssue | undefined
    return Object.freeze({ issue: (value: GenerationIssue) => {
      this.current(); checkCurrent?.()
      const record = this.state()?.attempts.find(attempt => attempt.reservation.attemptId === reservation.attemptId)
      if (issued || settled || !record || record.rebinds !== rebinds || record.candidate.semanticId !== candidate.semanticId || record.candidate.payloadId !== candidate.payloadId
        || value.semanticId !== candidate.semanticId || value.payloadId !== candidate.payloadId || value.payloadKind !== candidate.payloadKind) throw generationError('GENERATION_STALE')
      issued = true; confirmation = value; this.latestIssued = { attemptId: reservation.attemptId, confirmation: value }
    }, settle: async (disposition: 'unsent' | 'unknown' | 'completed' | 'failed') => {
      if (settled) return
      settled = true
      await this.document.settle({ ...this.envelope(), type: 'context/attempt', op: 'settle', attemptId: reservation.attemptId, disposition: issued ? disposition === 'unsent' ? 'unknown' : disposition : 'unsent', ...(confirmation ? { sendId: confirmation.sendId } : {}) })
      this.pending = false
      if (!issued) this.knownUnsent = reservation
    } })
  }
  private async invokeLocal(identity: object, lane: GenerationLane, checkCurrent?: () => void): ReturnType<GenerationControl['invokeLocal']> {
    const current = this.current(), bound = current.bound
    if (!bound || bound.executionDomain !== 'local-test' || !this.localIdentity || identity !== this.localIdentity || this.pending) throw generationError('GENERATION_UNSUPPORTED')
    if (current.invocations.some(value => !value.disposition)) throw generationError('GENERATION_UNCERTAIN')
    const laneLimit = lane === 'auxiliary' ? current.limits!.total : current.limits![lane]
    if (current.invocations.length >= current.limits!.total || current.invocations.filter(value => value.invocation.lane === lane).length >= laneLimit) throw generationError('GENERATION_EXHAUSTED')
    this.pending = true
    const localInvocationId = randomUUID()
    try { await this.document.append([{ ...this.envelope(), type: 'context/action', op: 'local-invocation', localInvocationId, ordinal: current.invocations.length + 1, lane, incarnation: this.document.incarnation }], this.stillCurrent) }
    catch (error) { this.pending = false; throw error }
    let issued = false, settled = false
    return { issue: () => { this.current(); checkCurrent?.(); if (issued || settled) throw generationError('GENERATION_STALE'); issued = true; this.latestLocal = localInvocationId }, settle: async disposition => {
      if (settled) return
      settled = true
      await this.document.settle({ ...this.envelope(), type: 'context/action', op: 'local-settle', localInvocationId, disposition: issued ? disposition : 'unsent' })
      this.pending = false
    } }
  }
  acceptance(confirmation: ExecutionConfirmation | undefined): GenerationAcceptanceDraft {
    if (this.state()?.bound?.executionDomain === 'local-test') {
      const invocation = this.state()?.invocations.find(value => value.invocation.localInvocationId === this.latestLocal)
      if (!invocation || invocation.disposition !== 'completed' || confirmation) throw generationError('GENERATION_STALE')
      return { ...this.envelope(), type: 'context/action', op: 'accepted', executionDomain: 'local-test', localInvocationId: invocation.invocation.localInvocationId }
    }
    if (!this.latestIssued || !confirmation || this.latestIssued.confirmation.sendId !== confirmation.sendId) throw generationError('GENERATION_STALE')
    const attempt = this.state()?.attempts.find(value => value.reservation.attemptId === this.latestIssued!.attemptId)
    if (attempt?.disposition !== 'completed') throw generationError('GENERATION_UNCERTAIN')
    return { ...this.envelope(), type: 'context/action', op: 'accepted', executionDomain: 'physical', attemptId: this.latestIssued.attemptId, sendId: confirmation.sendId }
  }
  async close(disposition: Extract<GenerationActionEvent, { op: 'close' }>['disposition']) {
    const current = this.state()
    if (!current || current.closed) { this.clock.close(); return }
    this.closing ??= (async () => {
      try { await this.document.settle({ ...this.envelope(), type: 'context/action', op: 'close', disposition }) }
      finally { this.clock.close() }
    })()
    return this.closing
  }
  async phase(recovery: Extract<SessionEvent, { type: 'context/recovery' }>) {
    const current = this.current()
    if (!current.bound || current.phase) throw generationError('GENERATION_EXHAUSTED')
    await this.document.phase(recovery, { ...this.envelope(), type: 'context/action', op: 'phase' }, this.stillCurrent)
  }
}
