import { FactRecoveryRequiredError, freezeJsonData, type JournalPrefix } from '@i-harness/core-session'
import type { ManagedEntry } from './bootstrap.ts'
import type { SelectedResultsRoute } from './selected-results-route.ts'
import type { SelectedResultsHeaderStageV2 } from './selected-results-header.ts'
import type { selectedResultsPreparationFacts } from './selected-results-preparation.ts'
import type { SessionMeta } from './types.ts'
import type { ColdTargetAccess, ColdFinalization, ColdAdoptedOutcome } from './cold-finalization-types.ts'

/** Only the original bootstrap owner's WeakMap recognizes this token. */
export type ColdSelectedTarget = Readonly<{ kind: 'cold-selected-target' }>
export type CheckedColdBirth = {
  stage: SelectedResultsHeaderStageV2
  facts: ReturnType<typeof selectedResultsPreparationFacts>
}
export interface ColdSelectedObservation {
  readonly document: NonNullable<ManagedEntry['document']>
  readonly view: NonNullable<ManagedEntry['document']>['view']
  readonly metadata: Readonly<SessionMeta>
  readonly birth: CheckedColdBirth
  readonly facts: CheckedColdBirth['facts']
  readonly prefix: Readonly<JournalPrefix>
  readonly receipt: NonNullable<NonNullable<ManagedEntry['selected']>['resultReceipt']>
  assertCurrent(): void
}

/** Subordinate to an existing unready entry; owns neither a claim nor readiness. */
export function createColdSelectedInspection(entry: ManagedEntry, route: SelectedResultsRoute,
  birth: CheckedColdBirth, prefix: JournalPrefix, metadata: SessionMeta,
  lifecycle: { assertCurrent(): void; assertOutside(): void; enter<T>(work: () => Promise<T>): Promise<T>; settle(): Promise<void>;commit?():ColdAdoptedOutcome }) {
  const document = entry.document!, selected = entry.selected!, receipt = selected.resultReceipt!
  const target: ColdSelectedTarget = Object.freeze({ kind: 'cold-selected-target' })
  // Preserve the genuine checked object identity; these are already checked JSON.
  freezeJsonData(birth); freezeJsonData(prefix); freezeJsonData(receipt); freezeJsonData(metadata)
  const revision=entry.metadataRevision
  const io=entry.captureIO,control=entry.control,barrier=selected.taskBarrier
  const view = document.view, eventCount = view.events.length, header = view.header
  const check = () => {
    lifecycle.assertCurrent()
    if (entry.captureIO!==io||entry.control!==control||selected.taskBarrier!==barrier||entry.metadataRevision !== revision || entry.selected !== selected || entry.document !== document || document.view !== view
      || selected.resultReceipt !== receipt || entry.ready || view.events.length !== eventCount || view.header !== header
      || !selected.taskBarrier?.completed || !entry.captureIO?.settled || entry.captureIO.released || entry.captureIO.releasing) throw new FactRecoveryRequiredError()
    entry.captureIO.held.assertHeld()
  }
  check()
  function use<T>(work: (observation: ColdSelectedObservation) => Promise<T>,attempt?:ColdFinalization): Promise<T> {
      lifecycle.assertOutside(); check()
      if(entry.coldFinalization&&entry.coldFinalization!==attempt)throw new FactRecoveryRequiredError()
      if (entry.flight) return Promise.reject(new FactRecoveryRequiredError())
      const flight = Promise.resolve().then(() => lifecycle.enter(async () => {
        check()
        let active = true, failed = false, cause: unknown, value: T | undefined
        const assertCurrent = () => { if (!active) throw new FactRecoveryRequiredError(); check() }
        const observation = Object.freeze({ document, view, metadata, birth, facts: birth.facts, prefix, receipt, assertCurrent })
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
    }
  return Object.freeze({ target, route, assertCurrent: check,use,
    captureAccess():ColdTargetAccess {
      lifecycle.assertOutside();check();let attempt:ColdFinalization|undefined
      return Object.freeze({identity:entry,route,assertCurrent:check,assertOutside:lifecycle.assertOutside,use<T>(work:(cold:ColdSelectedObservation)=>Promise<T>){return use(work,attempt)},settle:lifecycle.settle,
        commit(){check();if(!attempt||entry.coldFinalization!==attempt||!lifecycle.commit)throw new FactRecoveryRequiredError();return lifecycle.commit()},
        attach(value:ColdFinalization,revoke:()=>void){check();if(entry.coldFinalization)throw new FactRecoveryRequiredError();attempt=value;entry.coldFinalization=value;entry.revokeColdFinalization=revoke},
        detach(value:ColdFinalization){if(attempt===value&&entry.coldFinalization===value){entry.coldFinalization=undefined;entry.revokeColdFinalization=undefined}},
      })
    },
  })
}
