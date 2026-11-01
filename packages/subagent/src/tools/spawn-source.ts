import {registerOriginalSpawnRun,projectOriginalSpawnJob} from './source-run.ts'
import {bindRequiredTaskSettlement,type RequiredTaskSettlement} from '../task/required-settlement.ts'
import type {TaskTerminalizeInput} from '../task/types.ts'
import { committedFactSeqs, FactRecoveryRequiredError, type CapturedActionFact, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionEvent, type SubagentDeliveryLaunchDraft } from '@i-harness/core-session'
import type { RetainedOutcomeSink } from '@i-harness/core-tools'
import type { TaskRecord } from '../task-protocol.ts'
import { OriginalTerminalRecoveryError } from '../task-notification.ts'
import type { TaskRegistry } from '../task/types.ts'

export interface PublishedChild { path: string; jobId: string; sessionId?: string; modelLabel?: string }
type SpawnIdentity = Readonly<{ agent_path: string; job_id: string; task_id: string }>

export function spawnObservation(base: SpawnIdentity, task: TaskRecord) {
  return Object.freeze({
    ...base, status: task.status,
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.result ? { result_revision: task.result.revision, result_ref: task.result.kind === "retained" && task.result.envelope.retention.kind === "artifact" ? task.result.envelope.retention.ref : undefined } : {}),
    ...(task.resultText !== undefined ? { resultText: task.resultText } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    message: `subagent ${base.agent_path} settled: ${task.status}`,
  })
}

/** Retains the original start disposition, publication identity and real end.
 * Passive outcome reads never join a still-running child. */
export function createSpawnSource(owner: FactOwner, signal?: AbortSignal, retained?: RetainedOutcomeSink, background = true, onTerminalCommitted?: () => void, onTerminalRecovery?: () => void) {
  let requiredTask:RequiredTaskSettlement|undefined,requiredRun:{project:import('../runtime-projection.ts').TerminalProjection;entry:import('../agent-table.ts').ChildAgentEntry;run:Promise<unknown>}|undefined
  const producer=Promise.withResolvers<TaskTerminalizeInput>();let producerInput:TaskTerminalizeInput|undefined;
  const action = owner.beginAction(signal)
  let start: CapturedActionFact<ProducerFactOutcome> | undefined
  let terminal: CapturedSettlementFact<ProducerFactOutcome> | undefined
  let terminalEvent: Readonly<Extract<SessionEvent, { type: 'subagent/end' }>> | undefined
  let published: Readonly<PublishedChild> | undefined
  let base: SpawnIdentity | undefined
  let taskId: string | undefined
  let terminalOutput: ReturnType<typeof spawnObservation> | undefined
  let taskSave: (() => Promise<void>) | undefined
  let saving: Promise<void> | undefined
  let taskSaved = false, terminalSaved = false, unused = false, retainPublished = false
  let sourceReleased=false
  let resultPublished = false
  let terminalSignalled = false
  let recoverySignalled = false, terminalOutcome: ProducerFactOutcome | undefined
  let settling = false
  let beginHandoff: ReturnType<TaskRegistry['bindForegroundHandoff']> | undefined
  let handoff: ReturnType<NonNullable<typeof beginHandoff>> | undefined
  let handoffAcknowledged = false, handoffReleased = false, handoffConsumerPending = false
  const terminalReady = Promise.withResolvers<void>()
  void terminalReady.promise.catch(() => {})
  let captureFailure: Readonly<{ cause: unknown; observedOutcome?: unknown }> | undefined
  let prepareEnd: (() => Promise<{ event: Extract<SessionEvent, { type: 'subagent/end' }>; output?: ReturnType<typeof spawnObservation> }>) | undefined
  let requiredPrepareEnd:NonNullable<typeof prepareEnd>|undefined
  let preparingEnd: Promise<void> | undefined
  let terminalSettlement: Promise<void> | undefined

  let localProjection:Promise<void>|undefined
  const projectRequiredTerminal=()=>{
    const pending=localProjection??=(async()=>{if(requiredTask){const original=await requiredTask.settle();requiredTask.assertProjectionCurrent();if(requiredRun)await requiredRun.project(original);else await projectOriginalSpawnJob(originalPublished,original);requiredTask.assertProjectionCurrent()}})()
    void pending.catch(()=>{if(localProjection===pending)localProjection=undefined});return pending
  }

  const prepareTerminal = async () => {
    if (terminal || !prepareEnd) return
    const pending = preparingEnd ??= (async () => {
      const prepared = await prepareEnd!()
      await projectRequiredTerminal()
      terminalEvent ??= Object.freeze({ ...prepared.event })
      terminal ??= source.delivery.capture(terminalEvent)
      terminalOutput ??= prepared.output
    })()
    try { await pending } finally { if (preparingEnd === pending) preparingEnd = undefined }
  }

  const reconcileStart = async () => {
    if (!start) return
    let outcome = await start.observe()
    if (outcome.kind === 'unknown' || outcome.kind === 'conflict' || outcome.kind === 'recovery-required') outcome = await start.reconcile()
    if (outcome.kind !== 'absent' && outcome.kind !== 'not-issued') committedFactSeqs(outcome)
  }
  const identity = () => {
    if (!base) throw new FactRecoveryRequiredError()
    return base
  }
  const publishResult = () => {
    if (!retainPublished || !retained || resultPublished) return
    if (handoff?.kind === 'parent' && !handoffReleased) retained.unavailable()
    else if (background || handoff?.kind === 'parent' || handoff?.kind === 'manual') { retained.ready(identity()); resultPublished = true }
    else if (terminalSaved && taskSaved && terminalOutput) { retained.ready(terminalOutput); resultPublished = true }
    else retained.unavailable()
  }
  const saveTask = async () => {
    if (taskSaved) return
    if (!taskSave) throw new FactRecoveryRequiredError()
    const pending = saving ??= taskSave().then(() => { taskSaved = true })
    try { await pending } finally { if (saving === pending) saving = undefined }
  }
  const completed = () => {
    if (terminalSaved && taskSaved && (!requiredTask||sourceReleased) && (handoff?.kind !== 'parent' || handoffReleased) && !terminalSignalled) {
      terminalSignalled = true
      try { onTerminalCommitted?.() } catch { /* Observers cannot replace the original outcome. */ }
    }
    publishResult()
  }
  const terminalFailure = (errors: unknown[]) => {
    const failure = Object.assign(new AggregateError(errors, 'Spawn completion needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    if (handoff?.kind === 'parent' && !recoverySignalled) {
      recoverySignalled = true
      try { onTerminalRecovery?.() } catch { /* Original owner retains both saves. */ }
    }
    if (taskSaved && terminalOutcome && (terminalOutcome.kind === 'unknown' || terminalOutcome.kind === 'recovery-required')) {
      if (!recoverySignalled) { recoverySignalled = true; try { onTerminalRecovery?.() } catch { /* Original outcome remains authoritative. */ } }
      return new OriginalTerminalRecoveryError(terminalOutcome, failure)
    }
    return failure
  }
  const settleTerminalOnce = async () => {
    await prepareTerminal()
    if (captureFailure || !terminal) throw Object.assign(new FactRecoveryRequiredError(), { cause: captureFailure })
    // The original Task acknowledgment is a prerequisite of first end issuance.
    await saveTask()
    const results=await Promise.allSettled([terminalSaved?Promise.resolve():terminal.reconcile().then(outcome=>{terminalOutcome=outcome;committedFactSeqs(outcome);terminalSaved=true})])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw terminalFailure(errors)
    if(requiredTask)await requiredTask.release()
    completed()
  }
  const settleTerminal = () => {
    const pending = terminalSettlement ??= settleTerminalOnce()
    void pending.finally(() => { if (terminalSettlement === pending) terminalSettlement = undefined }).catch(() => {})
    return pending
  }
  const source = action.registerSettlementSource(async () => {
    if (!unused) {if(requiredTask){prepareEnd??=requiredPrepareEnd;if(!producerInput)requiredRun?.entry.controller.abort()}await settleTerminal()}
  }, reconcileStart)
  let closing: Promise<void> | undefined
  const closeSource = () => {
    const pending = closing ??= source.close().then(()=>{sourceReleased=true;completed()})
    void pending.catch(() => { if (closing === pending) closing = undefined })
    return pending
  }
  retained?.beforeRead(async () => {
    await reconcileStart()
    if (terminal || prepareEnd) await settleTerminal()
    publishResult()
  })
  const result = {
    async bindRequiredTask(registry:TaskRegistry,task:TaskRecord) {
      requiredTask=await bindRequiredTaskSettlement(registry,task,source,async()=>{const input=await producer.promise;if(!requiredRun){if(published||input.outcome==='completed')throw Error('Original required run unavailable')}else if(requiredRun.entry.path!==task.agentPath)throw Error('Original required run replaced');return input})
      if(requiredTask){taskSave=async()=>{await requiredTask!.settle()};requiredPrepareEnd=async()=>{const settled=await requiredTask!.settle();return {event:{type:'subagent/end',version:1,taskId:task.id,outcome:settled.outcome!,...(settled.result?.kind==='retained'?{envelope:settled.result.envelope,resultRevision:settled.result.revision}:{}),...(settled.resultText!==undefined?{resultText:settled.resultText}:{}),...(settled.error!==undefined?{error:settled.error}:{})},output:spawnObservation(identity(),settled as TaskRecord)}}}
    },
    hasRequiredTask(){return requiredTask!==undefined},
    async terminalizeOriginal(input:TaskTerminalizeInput){if(!requiredTask)return undefined;if(!producerInput){producerInput=Object.freeze({...input});producer.resolve(producerInput)}prepareEnd??=requiredPrepareEnd;return requiredTask.settle()},
    async reconcileTerminal() {
      if (handoffConsumerPending) return
      if (handoff?.kind === 'parent' && !handoffAcknowledged) {
        await handoff.save.retry(); handoff.save.assertHandoff(); handoff.save.release(); handoffAcknowledged = true; handoffReleased = true
      }
      if (handoff?.kind === 'parent' && handoffAcknowledged && !handoffReleased) { handoff.save.assertHandoff(); handoff.save.release(); handoffReleased = true }
      // Resume the retained preparation owned by this original invocation. Its
      // registry consumer retries the exact captured save before end capture.
      if (terminalSaved && taskSaved) { if(requiredTask)await requiredTask.release();completed(); return }
      if (!terminal && prepareEnd) {
        if (terminalSettlement) try { await terminalSettlement } catch { /* Resume the same preparation below. */ }
        await settleTerminal(); terminalReady.resolve(); await closeSource(); return
      }
      if (!terminal) { completed(); return }
      source.assertHeld()
      if (terminalSettlement) {
        try { await terminalSettlement } catch { /* Reconcile the same captured terminal and save below. */ }
        if (terminalSaved && taskSaved) { if(requiredTask)await requiredTask.release();completed(); return }
      }
      let outcome = await terminal.observe()
      if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required') outcome = await terminal.reconcile()
      terminalOutcome = outcome
      const errors: unknown[] = []
      try { committedFactSeqs(outcome); terminalSaved = true } catch (error) { errors.push(error) }
      if (!taskSaved) {
        if (saving) {
          const pending = saving
          try { await pending } catch {
            if (saving === pending) saving = undefined
            try { await saveTask() } catch (error) { errors.push(error) }
          }
        }
        else try { await saveTask() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw terminalFailure(errors)
      completed(); terminalReady.resolve(); await closeSource()
    },
    bindTask(id: string, save: () => Promise<void>) { taskId = id; taskSave = save },
    bindHandoff(begin: ReturnType<TaskRegistry['bindForegroundHandoff']>) { beginHandoff = begin },
    async handoffToParent() {
      if (!beginHandoff) throw new FactRecoveryRequiredError()
      handoff ??= beginHandoff()
      if (handoff.kind === 'manual') return 'manual' as const
      if (handoff.kind === 'ready') return 'ready' as const
      handoffConsumerPending = true
      try { await handoff.save.done; handoff.save.assertHandoff() }
      catch (error) {
        handoffConsumerPending = false
        if (!recoverySignalled) { recoverySignalled = true; try { onTerminalRecovery?.() } catch { /* Original save remains held. */ } }
        throw error
      }
      handoffAcknowledged = true
      return 'parent' as const
    },
    assertHandoff() {
      if (handoff?.kind !== 'parent' || !handoffAcknowledged) throw new FactRecoveryRequiredError()
      handoff.save.assertHandoff()
    },
    consumeHandoff() {
      if (handoff?.kind !== 'parent' || !handoffAcknowledged || handoffReleased) throw new FactRecoveryRequiredError()
      handoff.save.release()
      handoffReleased = true
      handoffConsumerPending = false
      completed()
    },
    abandonHandoff() { handoffConsumerPending = false; try { onTerminalRecovery?.() } catch { /* Original save remains held. */ } },
    settling() { settling = true },
    published(info: PublishedChild) {
      published = Object.freeze({ ...info })
      base = Object.freeze({ agent_path: info.path, job_id: info.jobId, task_id: taskId! })
      // Host notification cannot interrupt the actual publication boundary.
      try { retained?.observed() } catch (cause) { captureFailure = Object.freeze({ cause, observedOutcome: published }) }
    },
    hasPublished() { return published !== undefined },
    assertLaunch() { if(result.published!==originalPublished)throw new FactRecoveryRequiredError();action.assertOpen() },
    settlementHeld() { try { source.assertHeld(); return true } catch { return false } },
    identity,
    async releaseUnused() { unused = true; await closeSource() },
    async start(event: Extract<SessionEvent, { type: 'subagent/start' }>, binding?: SubagentDeliveryLaunchDraft) {
      start ??= action.captureSubagentStart(event, binding)
      committedFactSeqs(await start.admit())
      action.assertOpen()
    },
    async end(event: Extract<SessionEvent, { type: 'subagent/end' }>, output?: ReturnType<typeof spawnObservation>) {
      await projectRequiredTerminal()
      terminalEvent ??= Object.freeze({ ...event })
      terminal ??= source.delivery.capture(terminalEvent)
      terminalOutput ??= output
      try { await settleTerminal(); terminalReady.resolve(); if (handoff?.kind !== 'parent' || handoffReleased) await closeSource() }
      catch (error) { terminalReady.reject(error); throw error }
    },
    async prepareEnd(prepare: NonNullable<typeof prepareEnd>) {
      prepareEnd ??= prepare
      settling = true
      try { await settleTerminal(); terminalReady.resolve(); if (handoff?.kind !== 'parent' || handoffReleased) await closeSource() }
      catch (error) { terminalReady.reject(error); throw error }
    },
    async foreground() {
      if (prepareEnd) await settleTerminal()
      else if (settling && !terminal) await terminalReady.promise
      await settleTerminal()
      if (!terminalOutput) throw new FactRecoveryRequiredError()
      return terminalOutput
    },
    recoverPublished(error: unknown) {
      retainPublished = true
      publishResult()
      return Object.assign(new FactRecoveryRequiredError(), { cause: error })
    },
    failed(cause: unknown, observedOutcome?: unknown) {
      captureFailure = Object.freeze({ cause, observedOutcome })
      terminalReady.reject(cause)
      source.requireRecovery()
    },
    finish() { action.finish() },
  }
  const originalPublished=result.published
  registerOriginalSpawnRun(result.published,()=>requiredTask!==undefined,(entry,run,project)=>{if(requiredRun)throw Error('Original spawn run replaced');requiredRun={entry,run,project}},()=>requiredTask!.assertProjectionCurrent(),projectRequiredTerminal)
  return result
}
