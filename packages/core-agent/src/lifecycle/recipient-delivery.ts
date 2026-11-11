import { randomUUID } from 'node:crypto'
import { committedFactSeqs, deliveryInputId, FactRecoveryRequiredError, isManagedFactOwner, isNondurableSession, isStrictFactData, readDeliveries,
  type CapturedSettlementFact, type DeliveryAdmissionReceipt, type DeliveryCloseReceipt, type DeliveryLaunchPreparation,
  type FactOwner, type InputDisplay, type ProducerFactOutcome, type ReceivedInputSource, type SubagentDeliveryEvidence,
  type SubagentDeliveryKey, type ExecDeliveryEvidence, type ExecDeliveryKey, type CodeDeliveryEvidence, type CodeDeliveryKey, type DeliverySourceEvent, type DeliveryKey } from '@i-harness/core-session'
import { eligibleExecTerminal } from '@i-harness/core-session/internal/execution'
import { eligibleCodeTerminal, codeTerminalRef } from '@i-harness/core-session/internal/execution'
import { readOwnedDeliveryState } from '@i-harness/core-session/internal/execution'
import { assertDeliveryIssue } from '@i-harness/core-session/internal/execution'
import { DeliverySuppressedError, DeliverySourcesError } from './delivery-errors.ts'

export type DeliveryDrainDisposition =
  | { kind: 'settled' } | { kind: 'waiting-source' }
  | { kind: 'retryable'; phase: 'original-physical' | 'temporary-admission' }
  | { kind: 'blocked'; reason: 'invalid' | 'conflict' | 'unsupported' | 'retired' | 'out-of-scope' | 'explicit-absence-retry' | 'unclassified'; debt: 'retained' | 'none' }
  | { kind: 'suppressed'; reason: 'generation-closed' | 'cancelled' | 'claimed' }
type Pending = { fact: CapturedSettlementFact<ProducerFactOutcome>; outcome?: ProducerFactOutcome; running?: Promise<readonly number[] | undefined>; done?: readonly number[]; everIssued?: boolean; retired?: boolean }
export class RecipientDeliveryRecoveryError extends FactRecoveryRequiredError {
  constructor(readonly deliveryDisposition: DeliveryDrainDisposition, cause?: unknown) { super(); this.cause = cause }
}
const failed = (disposition: DeliveryDrainDisposition, cause?: unknown) => new RecipientDeliveryRecoveryError(disposition, cause)

/** The one recipient adapter shares its owner's already registered received
 * source. Retained captures own uncertain outcomes; committed indexes own truth. */
export function createRecipientDelivery(owner: FactOwner, source: ReceivedInputSource<ProducerFactOutcome>, suppliedId?: string) {
  let recipient = source.owner?.sessionId ?? suppliedId
  let retired = false, opening: Pending | undefined
  const admissions = new Map<string, Pending>(), closes = new Map<string, Pending>()
  const durability = isNondurableSession(owner.view) ? 'nondurable' as const : 'durable' as const
  const state = () => readOwnedDeliveryState(owner.view) ?? readDeliveries(owner.view)
  const bind = (id?: string) => {
    if (id === undefined) return
    if (recipient !== undefined && recipient !== id) throw new TypeError('Recipient source identity does not match host')
    recipient = id
  }
  bind(suppliedId)
  const current = () => !retired
  const assertCurrent = () => { if (retired) throw failed({ kind: 'blocked', reason: 'retired', debt: 'retained' }) }
  const settle = (record: Pending): Promise<readonly number[] | undefined> => {
    if (record.done) return Promise.resolve(record.done)
    if (record.retired) return Promise.resolve(undefined)
    if (record.running) return record.running
    const pending = (async () => {
      let outcome = record.outcome ? await record.fact.observe() : await record.fact.admit()
      // A later explicit same-owner settlement attempt may retry this original
      // never-issued capture after its real writer prerequisite changed. The
      // generic code itself never arms a timer or permits an absent reissue.
      if (record.outcome && outcome.kind === 'not-issued' && outcome.code === 'FACT_RECOVERY_REQUIRED') outcome = await record.fact.reconcile()
      record.outcome = outcome
      if (outcome.kind !== 'not-issued') record.everIssued = true
      if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required') { outcome = await record.fact.reconcile(); record.outcome = outcome }
      if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') return record.done = committedFactSeqs(outcome)
      // Task1's source retires only this observed, known never-issued guarded
      // negative. No committed sequence is invented, and issued debt stays held.
      if (!record.everIssued && outcome.kind === 'not-issued' && outcome.code === 'FACT_PRECONDITION_STALE') { record.retired = true; return undefined }
      const disposition: DeliveryDrainDisposition = outcome.kind === 'unknown' || outcome.kind === 'recovery-required'
        ? { kind: 'retryable', phase: 'original-physical' }
        : { kind: 'blocked', reason: outcome.kind === 'conflict' ? 'conflict' : outcome.kind === 'absent' ? 'explicit-absence-retry' : outcome.kind === 'not-issued' && outcome.code === 'FACT_INVALID_GROUP' ? 'invalid' : 'unclassified', debt: 'retained' }
      throw failed(disposition, outcome)
    })()
    record.running = pending
    void pending.then(() => { record.running = undefined }, () => { record.running = undefined })
    return pending
  }
  const settleCloses = async () => { for (const record of closes.values()) await settle(record) }
  const ownHuman = () => {
    const fence = state().lastFenceSeq() ?? -1
    const human = owner.view.events.findLast(e => e.type === 'agent/input/admitted' && e.intent === 'user' && !e.synthetic
      && e.provenance?.kind === 'human' && e.provenance.authority === 'request'
      && (e.provenance.originSessionId === undefined || e.provenance.originSessionId === recipient)
      && e.seq! >= (owner.view.header?.seedLength ?? 0) && e.seq! > fence)
    return { human, fence }
  }
  const certifiedCall = (callSeq: number, execCall?: { callId: string; kind?: 'code' }) => {
    const view = owner.view, call = view.events[callSeq]
    return !!(call?.type === 'tool/call' && (execCall ? (execCall.kind === 'code' ? ['code_exec'] : ['bash','pwsh','shell']).includes(call.name) && call.callId === execCall.callId : call.name === 'spawn_agent')
      && call.seq === callSeq && callSeq >= (view.header?.seedLength ?? 0)
      && view.events.some(e => e.type === 'tool/dispatch' && e.callId === call.callId && e.seq! > callSeq && (!execCall || e.eventSeq === undefined || e.eventSeq === callSeq)))
  }
  async function admitOriginal(binding: Readonly<DeliverySourceEvent>, key: DeliveryKey, evidence: SubagentDeliveryEvidence,
    presentation: { text: string; description: string; display: InputDisplay }, candidate: () => boolean = () => true): Promise<DeliveryAdmissionReceipt> {
    const inputId = deliveryInputId(key), original = state().receipt(key)
    // execPending intentionally excludes already receipted sources. Original
    // receipt identity precedes fresh admission eligibility and rerendering.
    if (original) return { inputId: original.event.inputId, disposition: original.disposition, durability }
    assertCurrent()
    const eligible = () => current() && state().activeGeneration()?.generationId === binding.generationId && candidate()
    if (!eligible()) throw new DeliverySuppressedError(inputId)
    let record = admissions.get(inputId)
    if (!record) {
      record = { fact: source.captureDeliveryAdmission({ type: 'agent/delivery-received', version: 1, key, sourceSeq: evidence.sourceSeq, terminalSeq: evidence.terminalSeq, inputId }, {
        type: 'agent/input/admitted', version: 1, inputId, text: presentation.text, delivery: 'steer', intent: 'system',
        provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: `session.delivery.${key.kind}` },
        synthetic: { description: presentation.description, scope: 'turn', display: presentation.display },
      }, eligible) }
      admissions.set(inputId, record)
    }
    await settle(record)
    admissions.delete(inputId)
    if (record.retired) {
      // The close acknowledgment can itself join this original admission.
      // Never recursively join that close from its notification operation.
      if (state().activeGeneration()?.generationId !== binding.generationId) throw new DeliverySuppressedError(inputId)
      throw failed({ kind: 'blocked', reason: retired ? 'retired' : 'out-of-scope', debt: 'none' })
    }
    const receipt = state().receipt(key)
    if (!receipt) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'retained' })
    return { inputId: receipt.event.inputId, disposition: receipt.disposition, durability }
  }
  async function admitExec(evidence: ExecDeliveryEvidence): Promise<DeliveryAdmissionReceipt> {
    if (!isStrictFactData(evidence) || evidence.kind !== 'exec' || Reflect.ownKeys(evidence).some(key => !['kind', 'sourceSeq', 'terminalSeq'].includes(String(key)))
      || !Number.isSafeInteger(evidence.sourceSeq) || evidence.sourceSeq < 0 || !Number.isSafeInteger(evidence.terminalSeq) || evidence.terminalSeq <= evidence.sourceSeq)
      throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
    await settleCloses()
    const binding = owner.view.events[evidence.sourceSeq], terminal = owner.view.events[evidence.terminalSeq]
    if (binding?.type !== 'agent/delivery-source' || binding.kind !== 'exec' || binding.seq !== evidence.sourceSeq || binding.sourceNamespace !== 'exec' || binding.recipientSessionId !== recipient
      || state().source('exec', binding.sourceId)?.seq !== binding.seq || terminal?.type !== 'exec/end' || terminal.seq !== evidence.terminalSeq
      || terminal.sourceSeq !== binding.seq || terminal.instanceId !== binding.sourceId || !eligibleExecTerminal(terminal)
      || !('dependency' in terminal) || terminal.dependency.retention.kind !== 'artifact') throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
    const key: ExecDeliveryKey = { kind: 'exec', recipientSessionId: binding.recipientSessionId, sourceNamespace: 'exec', sourceId: binding.sourceId, resultRevision: terminal.dependency.retention.ref.revision }
    const metadata = { instanceId: terminal.instanceId, execution: terminal.execution, exitCode: terminal.exitCode, timedOut: terminal.timedOut, frames: terminal.dependency }
    const text = `<exec_result>\n${JSON.stringify(metadata)}\nRetained frame reference only. Read through the current authorized result-read tools; reads may be unavailable.\n</exec_result>`
    return admitOriginal(binding, key, evidence, { text, description: `Exec ${binding.sourceId} ${terminal.execution.outcome}`, display: { kind: 'task', title: `Exec ${terminal.execution.outcome}`, body: text } },
      () => state().execPending().some(candidate => candidate.source.seq === binding.seq && candidate.terminal.seq === terminal.seq))
  }
  async function admitCode(evidence: CodeDeliveryEvidence): Promise<DeliveryAdmissionReceipt> {
    if (!isStrictFactData(evidence) || evidence.kind !== 'code' || Reflect.ownKeys(evidence).some(key => !['kind', 'sourceSeq', 'terminalSeq'].includes(String(key)))
      || !Number.isSafeInteger(evidence.sourceSeq) || evidence.sourceSeq < 0 || !Number.isSafeInteger(evidence.terminalSeq) || evidence.terminalSeq <= evidence.sourceSeq)
      throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
    await settleCloses()
    const binding = owner.view.events[evidence.sourceSeq], terminal = owner.view.events[evidence.terminalSeq]
    if (binding?.type !== 'agent/delivery-source' || binding.kind !== 'code' || binding.seq !== evidence.sourceSeq || binding.recipientSessionId !== recipient
      || state().source('code', binding.sourceId)?.seq !== binding.seq || terminal?.type !== 'code/end' || terminal.seq !== evidence.terminalSeq
      || terminal.sourceSeq !== binding.seq || terminal.cellId !== binding.cellId || !eligibleCodeTerminal(terminal)) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
    const ref = codeTerminalRef(terminal)
    if (!ref) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
    const key: CodeDeliveryKey = { kind: 'code', recipientSessionId: binding.recipientSessionId, sourceNamespace: 'code', sourceId: binding.sourceId, resultRevision: ref.revision }
    const text = `<code_result>\n${JSON.stringify({ cellId: binding.cellId, execution: terminal.execution, ref })}\nReference only. Read using the authorized context_output_read result reader.\n</code_result>`
    if (Buffer.byteLength(text, 'utf8') > 8192) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
    return admitOriginal(binding, key, evidence, { text, description: `Code ${terminal.execution.outcome}`, display: { kind: 'task', title: `Code ${terminal.execution.outcome}`, body: text } },
      () => state().codePending().some(candidate => candidate.source.seq === binding.seq && candidate.terminal.seq === terminal.seq))
  }
  async function prepareLaunch(namespace: string, sourceId: string, callSeq: number, execCall?: { callId: string; kind?:'code' }): Promise<DeliveryLaunchPreparation> {
      assertCurrent(); await settleCloses(); assertCurrent()
      if (opening) { await settle(opening); opening = undefined; assertCurrent() }
      if (isManagedFactOwner(owner.view, owner)) (owner as import('@i-harness/session-persistence').ManagedDocument).assertReady()
      if (!recipient) return { kind: 'unavailable', reason: 'recipient-not-bound' }
      if (!certifiedCall(callSeq, execCall)) return { kind: 'unavailable', reason: 'uncertified-call' }
      const original = state().source(namespace, sourceId)
      if (original) throw failed({ kind: 'blocked', reason: 'conflict', debt: 'none' })
      let generation = state().activeGeneration()
      let taskOpen: ReturnType<NonNullable<typeof source.captureTaskDeliveryOpen>> | undefined
      if (!generation) {
        const { human, fence } = ownHuman()
        if (!human) {
          if (fence >= 0) throw failed({ kind: 'blocked', reason: 'out-of-scope', debt: 'none' })
          return { kind: 'unavailable', reason: 'no-own-human-origin' }
        }
        // No await between deciding and retaining the sole original open.
        const event = { type: 'agent/delivery-generation' as const, version: 1 as const, op: 'open' as const, recipientSessionId: recipient, generationId: randomUUID(), originInputSeq: human.seq! }
        if (!execCall && source.captureTaskDeliveryOpen) taskOpen=source.captureTaskDeliveryOpen(event,current,{recipientSessionId:recipient,sourceNamespace:namespace,sourceId,callSeq})
        opening = { fact: taskOpen ?? source.captureDeliveryOpen(event,current) }
        const opened = await settle(opening); opening = undefined; assertCurrent()
        if (!opened) throw failed({ kind: 'blocked', reason: 'out-of-scope', debt: 'none' })
        generation = state().activeGeneration()
      }
      if (!generation) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
      if (taskOpen) return taskOpen.preparation()
      return { kind: 'bound', binding: { recipientSessionId: recipient, generationId: generation.generationId, sourceNamespace: namespace, sourceId, callSeq } }
    }
  const adapter = {
    bind,
    revoke() { retired = true },
    prepareLaunch(namespace: string, sourceId: string, callSeq: number) { return prepareLaunch(namespace,sourceId,callSeq) },
    supportsCodeLaunch(input: { view: import('@i-harness/core-session').SessionView; sessionId: string; callId: string; callSeq: number }): boolean {
      assertCurrent()
      if (input.view !== owner.view || input.sessionId !== recipient) throw TypeError('Original Code recipient required')
      if (!certifiedCall(input.callSeq, { callId: input.callId, kind: 'code' })) throw TypeError('Uncertified Code call')
      if (state().activeGeneration()) return true
      const { human, fence } = ownHuman()
      if (!human && fence >= 0) throw failed({ kind: 'blocked', reason: 'out-of-scope', debt: 'none' })
      return !!human
    },
    async prepareCodeLaunch(input:{view:import('@i-harness/core-session').SessionView;sessionId:string;callId:string;sourceId:string;callSeq:number;cellId:string}){
      if(input.view!==owner.view||input.sessionId!==recipient)throw TypeError('Original Code recipient required')
      const result=await prepareLaunch('code',input.sourceId,input.callSeq,{callId:input.callId,kind:'code'})
      if(result.kind!=='bound')throw new FactRecoveryRequiredError()
      return {binding:{...result.binding,sourceNamespace:'code' as const,cellId:input.cellId,delivery:'tool' as const},isCurrent:()=>{
        try{assertDeliveryIssue(owner.view,[{type:'agent/delivery-source',version:1,kind:'code',...result.binding,sourceNamespace:'code',cellId:input.cellId,delivery:'tool'}]);return current()&&state().activeGeneration()?.generationId===result.binding.generationId}catch{return false}
      }}
    },
    async prepareExecLaunch(input: { view: import('@i-harness/core-session').SessionView; sessionId: string; callId: string; sourceId: string; callSeq: number }) {
      if (input.view !== owner.view || input.sessionId !== recipient) throw new TypeError('Original Exec recipient required')
      const result=await prepareLaunch('exec',input.sourceId,input.callSeq,{callId:input.callId})
      return result.kind==='bound'?{...result,isCurrent:()=>{
        try{assertDeliveryIssue(owner.view,[{type:'agent/delivery-source',version:1,kind:'exec',...result.binding,sourceNamespace:'exec',delivery:'tool'}])}
        catch{return false}
        return current()&&state().activeGeneration()?.generationId===result.binding.generationId
      }}:result
    },
    async admit(evidence: SubagentDeliveryEvidence, presentation: { text: string; description: string; display: InputDisplay }): Promise<DeliveryAdmissionReceipt> {
      await settleCloses()
      const binding = owner.view.events[evidence.sourceSeq], terminal = owner.view.events[evidence.terminalSeq]
      if (binding?.type !== 'agent/delivery-source' || binding.kind !== 'subagent' || binding.seq !== evidence.sourceSeq || binding.recipientSessionId !== recipient
        || state().source(binding.sourceNamespace, binding.sourceId)?.seq !== binding.seq
        || terminal?.type !== 'subagent/end' || terminal.seq !== evidence.terminalSeq || terminal.seq! <= binding.seq! || terminal.taskId !== binding.sourceId
        || !terminal.resultRevision || !terminal.envelope || terminal.envelope.retention.kind === 'unavailable' || terminal.envelope.execution.dispatch !== 'dispatched'
        || !(terminal.outcome === 'completed' && terminal.envelope.execution.outcome === 'succeeded' || terminal.outcome === 'error' && terminal.envelope.execution.outcome === 'failed')) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'none' })
      const key: SubagentDeliveryKey = { recipientSessionId: binding.recipientSessionId, sourceNamespace: binding.sourceNamespace, sourceId: binding.sourceId, resultRevision: terminal.resultRevision, kind: 'subagent' }
      return admitOriginal(binding, key, evidence, presentation)
    },
    admitExec,
    admitCode,
    async reconcileCodeCandidates() {
      const failures: unknown[] = []
      for (const candidate of state().codePending()) {
        try { await admitCode({ kind: 'code', sourceSeq: candidate.source.seq!, terminalSeq: candidate.terminal.seq! }) }
        catch (cause) { if (!(cause instanceof DeliverySuppressedError)) failures.push(cause) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new DeliverySourcesError(failures)
    },
    /** Discovery belongs only to the already published service drain. The
     * receiver source's own settlement/close callback remains join-only. */
    async reconcileExecCandidates() {
      const failures: unknown[] = []
      for (const candidate of state().execPending()) {
        try { await admitExec({ kind: 'exec', sourceSeq: candidate.source.seq!, terminalSeq: candidate.terminal.seq! }) }
        catch (cause) { if (!(cause instanceof DeliverySuppressedError)) failures.push(cause) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new DeliverySourcesError(failures)
    },
    requestClose(reason: 'user-stop' | 'rewind') {
      const fenceId = randomUUID()
      // captureDeliveryClose installs the actual live fence synchronously.
      const record = { fact: source.captureDeliveryClose({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: recipient!, fenceId, reason }) }
      closes.set(fenceId, record)
      const settled = settle(record).then(seqs => {
        if (!seqs) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'retained' })
        return { fenceId, closeSeq: seqs[0]!, durability }
      })
      void settled.catch(() => {})
      return { fenceId, settled }
    },
    async settle() {
      await settleCloses()
      if (opening) { await settle(opening); opening = undefined }
      for (const [id, record] of admissions) { await settle(record); admissions.delete(id) }
    },
    async closeReceipt(fenceId: string): Promise<DeliveryCloseReceipt> {
      const record = closes.get(fenceId)
      if (!record) throw new TypeError('Unknown original delivery close')
      const seqs = await settle(record)
      if (!seqs) throw failed({ kind: 'blocked', reason: 'invalid', debt: 'retained' })
      return { fenceId, closeSeq: seqs[0]!, durability }
    },
  }
  return adapter
}
