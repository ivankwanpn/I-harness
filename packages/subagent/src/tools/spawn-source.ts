import { committedFactSeqs, FactRecoveryRequiredError, type CapturedActionFact, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionEvent } from '@i-harness/core-session'
import type { RetainedOutcomeSink } from '@i-harness/core-tools'
import type { TaskRecord } from '../task-protocol.ts'

export interface PublishedChild { path: string; jobId: string; sessionId?: string; modelLabel?: string }
type SpawnIdentity = Readonly<{ agent_path: string; job_id: string; task_id: string }>

export function spawnObservation(base: SpawnIdentity, task: TaskRecord) {
  return Object.freeze({
    ...base, status: task.status,
    ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
    ...(task.resultText !== undefined ? { resultText: task.resultText } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    message: `subagent ${base.agent_path} settled: ${task.status}`,
  })
}

/** Retains the original start disposition, publication identity and real end.
 * Passive outcome reads never join a still-running child. */
export function createSpawnSource(owner: FactOwner, signal?: AbortSignal, retained?: RetainedOutcomeSink, background = true) {
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
  let captureFailure: Readonly<{ cause: unknown; observedOutcome?: unknown }> | undefined

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
    try { await pending } finally { if (saving === pending) saving = undefined }
  }
  const settleTerminal = async () => {
    if (captureFailure || !terminal) throw Object.assign(new FactRecoveryRequiredError(), { cause: captureFailure })
    const results = await Promise.allSettled([
      terminalSaved ? Promise.resolve() : terminal.reconcile().then(outcome => { committedFactSeqs(outcome); terminalSaved = true }),
      saveTask(),
    ])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Spawn completion needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    publishResult()
  }
  const source = action.registerSettlementSource(async () => {
    if (!unused) await settleTerminal()
  }, reconcileStart)
  retained?.beforeRead(async () => {
    await reconcileStart()
    if (terminal) await settleTerminal()
    publishResult()
  })
  return {
    bindTask(id: string, save: () => Promise<void>) { taskId = id; taskSave = save },
    published(info: PublishedChild) {
      published = Object.freeze({ ...info })
      base = Object.freeze({ agent_path: info.path, job_id: info.jobId, task_id: taskId! })
      // Host notification cannot interrupt the actual publication boundary.
      try { retained?.observed() } catch (cause) { captureFailure = Object.freeze({ cause, observedOutcome: published }) }
    },
    hasPublished() { return published !== undefined },
    assertLaunch() { action.assertOpen() },
    identity,
    async releaseUnused() { unused = true; await source.close() },
    async start(event: Extract<SessionEvent, { type: 'subagent/start' }>) {
      start ??= action.captureSubagentStart(event)
      committedFactSeqs(await start.admit())
      action.assertOpen()
    },
    async end(event: Extract<SessionEvent, { type: 'subagent/end' }>, output?: ReturnType<typeof spawnObservation>) {
      terminalEvent ??= Object.freeze({ ...event })
      terminal ??= source.delivery.capture(terminalEvent)
      terminalOutput ??= output
      await settleTerminal()
      await source.close()
    },
    async foreground() {
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
      source.requireRecovery()
    },
    finish() { action.finish() },
  }
}
