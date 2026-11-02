import { validSettlementEvent, validGenerationEvent, validInputPreparationEvent, validSoftTerminalDraft, type SettlementEventKind, type BatchKey, type CapturedFactGroup, type FactGroupDraft, type FactOutcome, type SettlementFacts, type SettlementCheckpointOwner } from '@i-harness/core-session'
import { retainSettlementCapture } from './settlement-fact.ts'
import { createSourceFacts } from './source-facts.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import {types} from 'node:util'
import {composeOriginalArtifactGuards,createArtifactCurrentGuard,isArtifactCurrentGuard,withImmediateArtifactCurrentChecks} from './artifact-path-association.ts'

type CloseContext = { source: object; active: boolean; parent?: CloseContext }
const closeContext = new AsyncLocalStorage<CloseContext>()
const originalSources = new WeakSet<object>()
const closeAcknowledgments = new WeakMap<object, { assertLive(): void; acknowledgment: Promise<void> }>()
export function captureOriginalSettlementCloseAck(source: object): Promise<void> | undefined {
  const original = closeAcknowledgments.get(source)
  if (!original) return undefined
  original.assertLive()
  return original.acknowledgment
}
export function isInsideOriginalSettlementClose(source: object): boolean {
  if (!originalSources.has(source)) return false
  for (let context = closeContext.getStore(); context; context = context.parent) if (context.active && context.source === source) return true
  return false
}

/** An already-registered real source retains its drain and capture handles
 * through failure. Successful release removes completed outcome retention. */
export function createSettlementSource(drain: () => Promise<void>, operations: {
  assertHeld(): void
  admitCaptured(group: CapturedFactGroup): Promise<FactOutcome>
  reconcile(key: BatchKey): Promise<FactOutcome>
  status(group: CapturedFactGroup): FactOutcome | undefined
  quarantineCapture(): void
  holdRecovery(): void
  releaseRecovery(): void
  onCloseRequested(): void
  captureMembers?(source:SettlementFacts):import('@i-harness/core-session/internal/execution').OriginalExecutionCaptureHooks
}, released: () => void, reconcilePending?: () => Promise<void>, checkpointOwner?: SettlementCheckpointOwner): SettlementFacts {
  let active = true, closeRequested = false, closing: Promise<void> | undefined
  const closeAck = Promise.withResolvers<void>()
  let holdEpoch = 0, heldRecovery = false, failed = false
  const stickyErrors: unknown[] = []
  let checkpointing: ReturnType<SettlementFacts['checkpoint']> | undefined
  let stages = Promise.resolve()
  const owner = checkpointOwner && {
    readCut: checkpointOwner.readCut.bind(checkpointOwner),
    settle: checkpointOwner.settle.bind(checkpointOwner),
    isCurrent: checkpointOwner.isCurrent.bind(checkpointOwner),
  }
  const recoveryError = (errors: unknown[] = []) => Object.assign(new AggregateError(errors, 'Required source needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
  const stage = <T>(run: () => Promise<T>): Promise<T> => {
    const pending = stages.then(run)
    stages = pending.then(() => {}, () => {})
    return pending
  }
  const heldField=types.isProxy(operations)?undefined:Object.getOwnPropertyDescriptor(operations,'assertHeld')
  const heldMethod=heldField&&'value'in heldField&&typeof heldField.value==='function'&&isArtifactCurrentGuard(heldField.value)?heldField.value as ()=>void:undefined
  const assertActive=()=>{if (!active) throw Object.assign(new Error('Settlement source is closed'), { code: 'FACT_CLOSED' })}
  const assertHeld = heldMethod ? composeOriginalArtifactGuards(
    createArtifactCurrentGuard(()=>{if(Object.getOwnPropertyDescriptor(operations,'assertHeld')?.value!==heldMethod)throw TypeError('Original settlement ownership assertion changed')}),
    heldMethod,createArtifactCurrentGuard(assertActive),
  ) : () => withImmediateArtifactCurrentChecks(()=>{operations.assertHeld();assertActive()})
  const quarantineCapture = () => { failed = true; operations.quarantineCapture() }
  const retained:Parameters<typeof import('./settlement-fact.ts').captureSettlementFact>[1] = { assertHeld, admit: operations.admitCaptured, reconcile: operations.reconcile, status: operations.status, quarantineCapture }
  const records = createSourceFacts(retained)
  // Only short settlement stages hold this lane. In particular, a producer's
  // lifecycle drain can wait for a seal while checkpoints continue to run.
  const verify = async (retire?: () => void): ReturnType<SettlementFacts['checkpoint']> => {
    if (!owner) throw Object.assign(new Error('No original checkpoint owner'), { code: 'FACT_OWNER_UNSUPPORTED' })
    for (let pass = 0; pass < 2; pass++) {
      assertHeld()
      if (failed) throw recoveryError(stickyErrors)
      const cut = owner.readCut(), revision = records.revision(), epoch = holdEpoch, snapshot = records.snapshot()
      if (failed || cut.failed) throw recoveryError()
      const ownerCurrent = () => { assertHeld(); return !failed && owner.isCurrent(cut) && holdEpoch === epoch }
      const current = () => ownerCurrent() && records.revision() === revision
      try {
        if (reconcilePending) { await reconcilePending(); if (!current()) continue }
        let progress
        try { progress = await owner.settle() }
        catch (error) { stickyErrors.push(error); quarantineCapture(); throw recoveryError(stickyErrors) }
        if (!current()) continue
        if (cut.failed || failed) throw recoveryError()
        if (cut.pending === 0 && cut.recoveryPending === 0 && progress.kind === 'advanced') {
          await records.drainSnapshot(snapshot, ownerCurrent)
          if (!current()) continue
        }
        assertHeld()
        if (!current()) continue
        if (failed || cut.failed || cut.recoveryPending !== 0 || !records.empty())
          throw recoveryError(progress.kind === 'blocked' ? [progress.reason] : [])
        if (cut.pending > 0) {
          if (retire) throw recoveryError(progress.kind === 'blocked' ? [progress.reason] : [])
          if (!heldRecovery) throw recoveryError(progress.kind === 'blocked' ? [progress.reason] : [])
          operations.releaseRecovery(); heldRecovery = false
          return { kind: 'progress' }
        }
        if (progress.kind === 'blocked') throw recoveryError([progress.reason])
        if (heldRecovery) { operations.releaseRecovery(); heldRecovery = false }
        retire?.()
        return { kind: 'settled' }
      } catch (error) {
        // Preserve falsey throws and the exact blocked reason, without retrying
        // a failed registered callback inside this checkpoint.
        if (error instanceof AggregateError && (error as AggregateError & { code?: string }).code === 'FACT_RECOVERY_REQUIRED') throw error
        throw recoveryError([error])
      }
    }
    throw recoveryError()
  }
  const checkpoint = () => {
    assertHeld()
    if (!owner) return Promise.reject(Object.assign(new Error('No original checkpoint owner'), { code: 'FACT_OWNER_UNSUPPORTED' }))
    if (checkpointing) return checkpointing
    const pending = stage(verify)
    checkpointing = pending
    void pending.then(() => { if (checkpointing === pending) checkpointing = undefined }, () => { if (checkpointing === pending) checkpointing = undefined })
    return pending
  }
  const capture = (kind: SettlementEventKind, event: unknown, group: FactGroupDraft) => {
    assertHeld()
    return validSettlementEvent(kind, event) ? records.capture(group)
      : records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, retained))
  }
  const close = () => {
    if (!active) return Promise.resolve()
    if (isInsideOriginalSettlementClose(source)) return Promise.reject(recoveryError([new Error('Original settlement close reentry')]))
    if (closing) return closing
    closeRequested = true
    const pending = Promise.resolve().then(async () => {
      const context: CloseContext = { source, active: true, parent: closeContext.getStore() }
      try { return await closeContext.run(context, async () => {
      operations.onCloseRequested()
      if (owner) {
        await stage(verify)
        try { await drain() } catch (error) { throw recoveryError([error]) }
        await stage(() => verify(() => { active = false; released() }))
        return
      }
      const errors: unknown[] = []
      assertHeld()
      try { await reconcilePending?.(); assertHeld() } catch (error) { errors.push(error) }
      try { await records.drain() } catch (error) { errors.push(error) }
      // A producer may depend on the unresolved original record. Preserve it
      // and return recovery before joining that dependent producer.
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source pre-drain needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
      try { await drain() } catch (error) { errors.push(error) }
      try { await records.drain() } catch (error) { errors.push(error) }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source drain needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
      active = false
      released()
      }) } finally { context.active = false }
    })
    closing = pending
    void pending.then(() => { closeAck.resolve() }, () => { if (closing === pending) closing = undefined })
    return pending
  }
  const source:SettlementFacts = {
    recovery: { capture: event => capture('recovery', event, { kind: 'metadata', event }) },
    softReduction: { capture(event) {
      assertHeld()
      return validSoftTerminalDraft(event) && event.publication === 'none' ? records.capture({ kind: 'soft-reduction', event })
        : records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, retained))
    } },
    inputPreparation: { capture(event) {
      assertHeld()
      return validInputPreparationEvent(event) && (event.op === 'completed' || event.op === 'failed')
        ? records.capture({ kind: 'input-preparation', event })
        : records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, retained))
    } },
    generation: { capture(event) {
      assertHeld()
      return validGenerationEvent(event) && (event.type === 'context/attempt' && event.op === 'settle' || event.type === 'context/action' && (event.op === 'close' || event.op === 'local-settle'))
        ? records.capture({ kind: 'generation', events: [event] })
        : records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, retained))
    } },
    assertHeld,
    close,
    checkpoint,
    requireRecovery() { assertHeld(); quarantineCapture() },
    holdRecovery() { assertHeld(); holdEpoch++; operations.holdRecovery(); heldRecovery = true },
    rewind: { capture: event => capture('rewind', event, { kind: 'legacy-compaction', events: [event] }) },
    retention: { capture: event => capture('retention', event, { kind: 'result-reference', event }) },
    tools: {
      result: event => capture('tool-result', event, { kind: 'tool', event }).admit(),
      captureResult: event => capture('tool-result', event, { kind: 'tool', event }),
    },
    code: {
      record: event => capture('code', event, { kind: 'code', event }).admit(),
      capture: event => capture('code', event, { kind: 'code', event }),
    },
    delivery: {
      record: event => capture('delivery', event, { kind: 'delivery', event }).admit(),
      capture: event => capture('delivery', event, { kind: 'delivery', event }),
    },
    lifecycle: {
      usage: event => capture('usage', event, { kind: 'usage', event }).admit(),
      auditAssistant: event => capture('assistant-audit', event, { kind: 'assistant-audit', assistant: event }).admit(),
      lifecycle: event => capture('lifecycle', event, { kind: 'lifecycle', event }).admit(),
    },
  } satisfies SettlementFacts
  originalSources.add(source)
  closeAcknowledgments.set(source, { assertLive() { if(closeRequested)throw Object.assign(new Error('Original settlement close observation retired'),{code:'FACT_CLOSED'});assertHeld() }, acknowledgment: closeAck.promise })
  retained.captureMembers=operations.captureMembers?.(source)
  return source
}
