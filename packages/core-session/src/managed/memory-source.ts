import type { Session } from '../events/types.ts'
import type { FactGroupDraft } from './groups.ts'
import type { CapturedSettlementFact, NondurableFactOutcome, SettlementFacts, SettlementCheckpointOwner } from './ports.ts'
import { validSettlementEvent, type SettlementEventKind } from './settlement-event.ts'
import { captureMemoryFact, rejectedMemoryCapture } from './memory-capture.ts'
import { validGenerationEvent } from '../events/generation.ts'
import { validInputPreparationEvent } from '../events/input-preparation.ts'
import { validSoftTerminalDraft } from '../events/soft-reduction.ts'
import { bindMemorySettlementSource } from './source-scope.ts'
import { committedFactSeqs } from './outcome.ts'

/** Required standalone outcomes share the closed constructors and local source
 * lifetime, while remaining explicitly nondurable. */
export function createMemorySettlementSource(session: Session, drain: () => Promise<void>, reconcilePending?: () => Promise<void>, recovery?: { hold(source: object): void; release(source: object): void; requireRecovery(): void }, checkpointOwner?: SettlementCheckpointOwner): SettlementFacts<NondurableFactOutcome> {
  let active = true, closing: Promise<void> | undefined
  let revision = 0, holdEpoch = 0, heldRecovery = false, failed = false
  const stickyErrors: unknown[] = []
  let checkpointing: ReturnType<SettlementFacts['checkpoint']> | undefined
  let stages = Promise.resolve()
  const pendingFacts = new Map<CapturedSettlementFact<NondurableFactOutcome>, { revision: number }>()
  const owner = checkpointOwner && {
    readCut: checkpointOwner.readCut.bind(checkpointOwner),
    settle: checkpointOwner.settle.bind(checkpointOwner),
    isCurrent: checkpointOwner.isCurrent.bind(checkpointOwner),
  }
  const recoveryError = (errors: unknown[] = []) => Object.assign(new AggregateError(errors, 'Required source needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
  const quarantine = () => { failed = true; recovery?.requireRecovery() }
  const retain = (fact: CapturedSettlementFact<NondurableFactOutcome>) => {
    const record = { revision: 0 }
    let disposition: NondurableFactOutcome | undefined
    const run = (method: keyof typeof fact) => async () => {
      assertHeld()
      const outcome = await fact[method]()
      if (!disposition || outcome.kind !== disposition.kind || outcome.kind === 'not-issued' && disposition.kind === 'not-issued' && outcome.code !== disposition.code) { revision++; record.revision++ }
      disposition = outcome
      if (outcome.kind === 'memory-committed' && pendingFacts.delete(owned)) { revision++; record.revision++ }
      return outcome
    }
    const owned = { admit: run('admit'), reconcile: run('reconcile'), observe: run('observe'), retryAbsent: run('retryAbsent') }
    pendingFacts.set(owned, record); revision++
    return owned
  }
  const invalid = () => { quarantine(); return retain(rejectedMemoryCapture()) }
  const memoryCapture = (draft: FactGroupDraft) => retain(captureMemoryFact(session, draft, assertHeld, false, quarantine))
  const stage = <T>(run: () => Promise<T>): Promise<T> => {
    const pending = stages.then(run)
    stages = pending.then(() => {}, () => {})
    return pending
  }
  const assertHeld = () => {
    if (!active) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })
  }
  const verify = async (retire?: () => void): ReturnType<SettlementFacts['checkpoint']> => {
    if (!owner) throw Object.assign(new Error('No original checkpoint owner'), { code: 'FACT_OWNER_UNSUPPORTED' })
    for (let pass = 0; pass < 2; pass++) {
      assertHeld()
      if (failed) throw recoveryError(stickyErrors)
      const cut = owner.readCut(), captureRevision = revision, epoch = holdEpoch, snapshot = [...pendingFacts.keys()]
      if (failed || cut.failed) throw recoveryError()
      const ownerCurrent = () => { assertHeld(); return !failed && owner.isCurrent(cut) && holdEpoch === epoch }
      const current = () => ownerCurrent() && revision === captureRevision
      try {
        if (reconcilePending) { await reconcilePending(); if (!current()) continue }
        let progress
        try { progress = await owner.settle() }
        catch (error) { stickyErrors.push(error); quarantine(); throw recoveryError(stickyErrors) }
        if (!current()) continue
        if (failed || cut.failed) throw recoveryError()
        if (cut.pending === 0 && cut.recoveryPending === 0 && progress.kind === 'advanced') {
          let expectedRevision = captureRevision
          for (const fact of snapshot) {
            if (!ownerCurrent() || revision !== expectedRevision) break
            const record = pendingFacts.get(fact), before = record?.revision ?? 0
            committedFactSeqs(await fact.reconcile())
            // This allowance is local to snapshot iteration. The pass's
            // original captureRevision still requires fresh verification.
            expectedRevision += (record?.revision ?? 0) - before
            if (!ownerCurrent() || revision !== expectedRevision) break
          }
          if (!current()) continue
        }
        assertHeld()
        if (!current()) continue
        if (failed || cut.failed || cut.recoveryPending !== 0 || pendingFacts.size)
          throw recoveryError(progress.kind === 'blocked' ? [progress.reason] : [])
        if (cut.pending > 0) {
          if (retire) throw recoveryError(progress.kind === 'blocked' ? [progress.reason] : [])
          if (!heldRecovery) throw recoveryError(progress.kind === 'blocked' ? [progress.reason] : [])
          recovery?.release(source); heldRecovery = false
          return { kind: 'progress' }
        }
        if (progress.kind === 'blocked') throw recoveryError([progress.reason])
        if (heldRecovery) { recovery?.release(source); heldRecovery = false }
        retire?.()
        return { kind: 'settled' }
      } catch (error) {
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
  const close = () => {
    if (!active) return Promise.resolve()
    if (closing) return closing
    const pending = Promise.resolve().then(async () => {
      if (owner) {
        await stage(verify)
        try { await drain() } catch (error) { throw recoveryError([error]) }
        await stage(() => verify(() => { active = false; recovery?.release(source) }))
        return
      }
      assertHeld()
      await reconcilePending?.()
      assertHeld()
      await drain(); active = false; recovery?.release(source)
    })
    closing = pending
    void pending.catch(() => { if (closing === pending) closing = undefined })
    return pending
  }
  const capture = (kind: SettlementEventKind, event: unknown, draft: FactGroupDraft) => {
    assertHeld()
    return validSettlementEvent(kind, event) ? memoryCapture(draft) : invalid()
  }
  const source: SettlementFacts<NondurableFactOutcome> = {
    recovery: { capture: event => capture('recovery', event, { kind: 'metadata', event }) },
    softReduction: { capture(event) {
      assertHeld()
      return validSoftTerminalDraft(event) && event.publication === 'none' ? memoryCapture({ kind: 'soft-reduction', event }) : invalid()
    } },
    inputPreparation: { capture(event) {
      assertHeld()
      return validInputPreparationEvent(event) && (event.op === 'completed' || event.op === 'failed')
        ? memoryCapture({ kind: 'input-preparation', event }) : invalid()
    } },
    generation: { capture(event) {
      assertHeld()
      return validGenerationEvent(event) && (event.type === 'context/attempt' && event.op === 'settle' || event.type === 'context/action' && (event.op === 'close' || event.op === 'local-settle'))
        ? memoryCapture({ kind: 'generation', events: [event] }) : invalid()
    } },
    assertHeld, close, checkpoint, requireRecovery() { assertHeld(); quarantine() }, holdRecovery() { assertHeld(); holdEpoch++; if (recovery) { recovery.hold(source); heldRecovery = true } },
    retention: { capture: event => capture('retention', event, { kind: 'result-reference', event }) },
    rewind: { capture: event => capture('rewind', event, { kind: 'legacy-compaction', events: [event] }) },
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
      lifecycle: event => capture('lifecycle', event, { kind: 'lifecycle', event }).admit(),
      usage: event => capture('usage', event, { kind: 'usage', event }).admit(),
      auditAssistant: event => capture('assistant-audit', event, { kind: 'assistant-audit', assistant: event }).admit(),
    },
  }
  bindMemorySettlementSource(session, source)
  return source
}
