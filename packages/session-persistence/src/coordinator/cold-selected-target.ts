import { FactRecoveryRequiredError, freezeJsonData, type JournalPrefix } from '@i-harness/core-session'
import type { ManagedEntry } from './bootstrap.ts'
import type { SelectedResultsRoute } from './selected-results-route.ts'
import type { SelectedResultsHeaderStageV2 } from './selected-results-header.ts'
import type { selectedResultsPreparationFacts } from './selected-results-preparation.ts'

/** Only the original bootstrap owner's WeakMap recognizes this token. */
export type ColdSelectedTarget = Readonly<{ kind: 'cold-selected-target' }>
export type CheckedColdBirth = {
  stage: SelectedResultsHeaderStageV2
  facts: ReturnType<typeof selectedResultsPreparationFacts>
}
export interface ColdSelectedObservation {
  readonly document: NonNullable<ManagedEntry['document']>
  readonly view: NonNullable<ManagedEntry['document']>['view']
  readonly birth: CheckedColdBirth
  readonly facts: CheckedColdBirth['facts']
  readonly prefix: Readonly<JournalPrefix>
  readonly receipt: NonNullable<NonNullable<ManagedEntry['selected']>['resultReceipt']>
  assertCurrent(): void
}

/** Subordinate to an existing unready entry; owns neither a claim nor readiness. */
export function createColdSelectedInspection(entry: ManagedEntry, route: SelectedResultsRoute,
  birth: CheckedColdBirth, prefix: JournalPrefix,
  lifecycle: { assertCurrent(): void; assertOutside(): void; enter<T>(work: () => Promise<T>): Promise<T>; settle(): Promise<void> }) {
  const document = entry.document!, selected = entry.selected!, receipt = selected.resultReceipt!
  const target: ColdSelectedTarget = Object.freeze({ kind: 'cold-selected-target' })
  // Preserve the genuine checked object identity; these are already checked JSON.
  freezeJsonData(birth); freezeJsonData(prefix); freezeJsonData(receipt)
  const view = document.view, eventCount = view.events.length, header = view.header
  const check = () => {
    lifecycle.assertCurrent()
    if (entry.selected !== selected || entry.document !== document || document.view !== view
      || selected.resultReceipt !== receipt || entry.ready || view.events.length !== eventCount || view.header !== header
      || !selected.taskBarrier?.completed || !entry.captureIO?.settled || entry.captureIO.released || entry.captureIO.releasing) throw new FactRecoveryRequiredError()
    entry.captureIO.held.assertHeld()
  }
  check()
  return Object.freeze({ target, route, assertCurrent: check,
    use<T>(work: (observation: ColdSelectedObservation) => Promise<T>): Promise<T> {
      lifecycle.assertOutside(); check()
      if (entry.flight) return Promise.reject(new FactRecoveryRequiredError())
      const flight = Promise.resolve().then(() => lifecycle.enter(async () => {
        check()
        let active = true, failed = false, cause: unknown, value: T | undefined
        const assertCurrent = () => { if (!active) throw new FactRecoveryRequiredError(); check() }
        const observation = Object.freeze({ document, view, birth, facts: birth.facts, prefix, receipt, assertCurrent })
        try { value = await work(observation); assertCurrent() }
        catch (error) { failed = true; cause = error }
        active = false
        try { await lifecycle.settle() }
        catch (cleanup) { if (failed) throw new AggregateError([cause, cleanup], 'Cold target use and cleanup failed', { cause }); throw cleanup }
        if (failed) throw cause
        check()
        return value as T
      })).finally(() => { if (entry.flight === flight) entry.flight = undefined })
      entry.flight = flight
      return flight
    },
  })
}
