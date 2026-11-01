import { committedFactSeqs, FactRecoveryRequiredError } from '@i-harness/core-session'
import type { Callback, CellFacts, Pending, PumpResult } from './state.ts'
import { isOriginalPreparationFailure } from './state.ts'
import { bindOriginalCodeCommit } from './commit-proof.ts'

export const recoveryError = (reasons: unknown[]) => Object.assign(new AggregateError(reasons, 'Code Mode event settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })

/** One short lane, shared by the outer drive and every original cell owner.
 * A pass never waits for a source close, checkpoint or producer lifecycle. */
export function createOutputQueue(options: {
  changed(): void
  failed(record: Pending, reason: unknown): void
  hold(record: Pending): void
  completed(record: Pending): void
}) {
  const records = new Map<number, Pending>()
  const targets = new Set<CellFacts>()
  let head = 0, nextOrdinal = 0, pumping: Promise<PumpResult> | undefined
  const touch = (record: Pending) => { if (record.cell) record.cell.revision++; options.changed() }
  const invoke = (record: Pending, cb: Callback) => {
    if (cb.state === 'failed') throw recoveryError([cb.reason])
    if (cb.state === 'succeeded') return
    if (cb.state === 'running') throw new FactRecoveryRequiredError()
    cb.state = 'running'; touch(record)
    // The public callback contract is synchronous void. In particular a
    // reentrant caller may return the queued drive; it cannot join that drive
    // while this original record still owns the pump lane.
    try { cb.invoke?.(); cb.state = 'succeeded'; touch(record) }
    catch (reason) { cb.reason = reason; cb.state = 'failed'; options.failed(record, reason); touch(record); throw recoveryError([reason]) }
  }
  const commit = async (record: Pending) => {
    if (record.failure?.sticky) throw record.failure.reason
    for (const cb of [record.commit, record.cancel, record.settle]) if (cb.state === 'failed') throw recoveryError([cb.reason])
    if (!record.fact) {
      touch(record)
      if (record.capture) record.fact = record.capture()
      else { record.originalEvent = await record.prepare!(); record.fact = record.source!.code.capture(record.originalEvent) }
      record.prepare = undefined; record.capture = undefined; touch(record)
    }
    if (!record.disposed) {
      const firstIssue = !record.attempted; record.attempted = true; touch(record)
      const outcome = await (firstIssue ? record.fact.admit() : record.fact.reconcile())
      if (outcome.kind === 'not-issued' && outcome.code === 'FACT_INVALID_GROUP') {
        try { committedFactSeqs(outcome) }
        catch (reason) {
          record.failure = { reason, sticky: true }
          options.failed(record, reason)
          throw reason
        }
      }
      if (record.action?.signal.aborted && (outcome.kind === 'absent' || outcome.kind === 'not-issued')) record.cancelled = true
      else committedFactSeqs(outcome)
      record.disposed = true; touch(record)
      if (!record.cancelled) { record.nativeOutcome = outcome; bindOriginalCodeCommit(record, outcome) }
    }
    // Private, awaited, resumable phase. Public callback slots remain sync void.
    // A failed append keeps this exact fact/outcome/record, never admits again.
    if (!record.cancelled && record.descriptor && !record.descriptorDone) {
      const work = record.descriptorFlight ??= Promise.resolve().then(record.descriptor)
      try { await work; record.descriptorDone = true }
      catch (cause) { if (record.descriptorFlight === work) record.descriptorFlight = undefined; throw cause }
    }
    invoke(record, record.cancelled ? record.cancel : record.commit)
    invoke(record, record.settle)
    record.settled = true
    options.completed(record); touch(record)
  }
  const pump = (target?: CellFacts): Promise<PumpResult> => {
    if (target && target.outputs.size === 0) return Promise.resolve({ kind: 'idle' })
    if (pumping) { if (target) targets.add(target); return pumping }
    if (target) targets.add(target)
    const watermark = nextOrdinal
    const pending = Promise.resolve().then(async (): Promise<PumpResult> => {
      while (head < watermark) {
        if ([...targets].some(cell => cell.outputs.size === 0)) return { kind: 'idle' }
        const record = records.get(head)!
        if (record.settled) { records.delete(head++); continue }
        if (record.kind === 'terminal' && record.cell && !record.cellClosed) return { kind: 'close-cell', record, cell: record.cell }
        try { await commit(record) }
        catch (reason) {
          if (isOriginalPreparationFailure(reason) && !record.failure?.sticky) {
            record.failure = { reason, sticky: true }
            options.failed(record, reason.reason)
          } else record.failure = { reason, sticky: record.failure?.sticky }
          // Ordinary preparation/receipt uncertainty remains resumable. A
          // failed callback is sticky and retains the exact original record.
          if (!record.failure.sticky && ![record.commit, record.cancel, record.settle].some(cb => cb.state === 'failed')) options.hold(record)
          return { kind: 'blocked', reason }
        }
        records.delete(head++)
      }
      return { kind: 'idle' }
    })
    pumping = pending
    void pending.then(() => { if (pumping === pending) { pumping = undefined; targets.clear() } }, () => { if (pumping === pending) { pumping = undefined; targets.clear() } })
    return pending
  }
  return {
    enroll(record: Omit<Pending, 'ordinal'>) { const enrolled = { ...record, ordinal: nextOrdinal++ }; records.set(enrolled.ordinal, enrolled); return enrolled },
    pump,
    /** Called only after the outer drive closes a terminal's original source,
     * and with no pump lane held. Its queue ordinal remains the head. */
    releaseTerminal(record: Pending) { record.cellClosed = true },
    hasPending: () => head < nextOrdinal,
  }
}
