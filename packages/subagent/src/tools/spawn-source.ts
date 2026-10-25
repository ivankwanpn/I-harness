import { committedFactSeqs, FactRecoveryRequiredError, type CapturedActionFact, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionEvent, type SubagentDeliveryLaunchDraft } from '@i-harness/core-session'
import type { RetainedOutcomeSink } from '@i-harness/core-tools'
import type { TaskRecord } from '../task-protocol.ts'
import { OriginalTerminalRecoveryError } from '../task-notification.ts'

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
  let resultPublished = false
  let terminalSignalled = false
  let recoverySignalled = false, terminalOutcome: ProducerFactOutcome | undefined, taskSaveFailure: unknown
  let settling = false
  const terminalReady = Promise.withResolvers<void>()
  void terminalReady.promise.catch(() => {})
  let captureFailure: Readonly<{ cause: unknown; observedOutcome?: unknown }> | undefined
  let prepareEnd: (() => Promise<{ event: Extract<SessionEvent, { type: 'subagent/end' }>; output?: ReturnType<typeof spawnObservation> }>) | undefined
  let preparingEnd: Promise<void> | undefined

  const prepareTerminal = async () => {
    if (terminal || !prepareEnd) return
    const pending = preparingEnd ??= (async () => {
      const prepared = await prepareEnd!()
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
    if (background) { retained.ready(identity()); resultPublished = true }
    else if (terminalSaved && taskSaved && terminalOutput) { retained.ready(terminalOutput); resultPublished = true }
    else retained.unavailable()
  }
  const saveTask = async () => {
    if (taskSaved) return
    if (!taskSave) throw new FactRecoveryRequiredError()
    const pending = saving ??= taskSave().then(() => { taskSaved = true })
    try { await pending } catch (error) { taskSaveFailure = error; throw error } finally { if (saving === pending) saving = undefined }
  }
  const completed = () => {
    if (terminalSaved && taskSaved && !terminalSignalled) {
      terminalSignalled = true
      try { onTerminalCommitted?.() } catch { /* Observers cannot replace the original outcome. */ }
    }
    publishResult()
  }
  const terminalFailure = (errors: unknown[]) => {
    const failure = Object.assign(new AggregateError(errors, 'Spawn completion needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    if (taskSaved && terminalOutcome && (terminalOutcome.kind === 'unknown' || terminalOutcome.kind === 'recovery-required')) {
      if (!recoverySignalled) { recoverySignalled = true; try { onTerminalRecovery?.() } catch { /* Original outcome remains authoritative. */ } }
      return new OriginalTerminalRecoveryError(terminalOutcome, failure)
    }
    return failure
  }
  const settleTerminal = async () => {
    await prepareTerminal()
    if (captureFailure || !terminal) throw Object.assign(new FactRecoveryRequiredError(), { cause: captureFailure })
    const results = await Promise.allSettled([
      terminalSaved ? Promise.resolve() : terminal.reconcile().then(outcome => { terminalOutcome = outcome; committedFactSeqs(outcome); terminalSaved = true }),
      saveTask(),
    ])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw terminalFailure(errors)
    completed()
  }
  const source = action.registerSettlementSource(async () => {
    if (!unused) await settleTerminal()
  }, reconcileStart)
  retained?.beforeRead(async () => {
    await reconcileStart()
    if (terminal || prepareEnd) await settleTerminal()
    publishResult()
  })
  return {
    async reconcileTerminal() {
      // This hook never calls prepareEnd or captures a new terminal/result.
      if (!terminal) return
      source.assertHeld()
      let outcome = await terminal.observe()
      if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required') outcome = await terminal.reconcile()
      terminalOutcome = outcome
      const errors: unknown[] = []
      try { committedFactSeqs(outcome); terminalSaved = true } catch (error) { errors.push(error) }
      if (!taskSaved) {
        if (saving) try { await saving } catch (error) { errors.push(error) }
        else errors.push(taskSaveFailure ?? new FactRecoveryRequiredError())
      }
      if (errors.length) throw terminalFailure(errors)
      completed(); terminalReady.resolve(); await source.close()
    },
    bindTask(id: string, save: () => Promise<void>) { taskId = id; taskSave = save },
    settling() { settling = true },
    published(info: PublishedChild) {
      published = Object.freeze({ ...info })
      base = Object.freeze({ agent_path: info.path, job_id: info.jobId, task_id: taskId! })
      // Host notification cannot interrupt the actual publication boundary.
      try { retained?.observed() } catch (cause) { captureFailure = Object.freeze({ cause, observedOutcome: published }) }
    },
    hasPublished() { return published !== undefined },
    assertLaunch() { action.assertOpen() },
    settlementHeld() { try { source.assertHeld(); return true } catch { return false } },
    identity,
    async releaseUnused() { unused = true; await source.close() },
    async start(event: Extract<SessionEvent, { type: 'subagent/start' }>, binding?: SubagentDeliveryLaunchDraft) {
      start ??= action.captureSubagentStart(event, binding)
      committedFactSeqs(await start.admit())
      action.assertOpen()
    },
    async end(event: Extract<SessionEvent, { type: 'subagent/end' }>, output?: ReturnType<typeof spawnObservation>) {
      terminalEvent ??= Object.freeze({ ...event })
      terminal ??= source.delivery.capture(terminalEvent)
      terminalOutput ??= output
      try { await settleTerminal(); terminalReady.resolve(); await source.close() }
      catch (error) { terminalReady.reject(error); throw error }
    },
    async prepareEnd(prepare: NonNullable<typeof prepareEnd>) {
      prepareEnd ??= prepare
      settling = true
      try { await settleTerminal(); terminalReady.resolve(); await source.close() }
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
}
