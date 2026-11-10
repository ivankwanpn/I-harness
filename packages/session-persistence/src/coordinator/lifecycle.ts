import type { PersistenceBackend, SessionArtifactManifest } from "./types.ts"
import { captureHeldOwnershipClaim, planOriginalOwnershipBatch, acquireOriginalOwnershipPlan, captureOriginalOwnershipPlanScope, assertOriginalOwnershipBatchCoverage, pinOriginalOwnershipInOrder, type OriginalOwnershipPlan, type OriginalOwnershipBatch, type OwnershipCleanup, type Ownership } from "./ownership.ts"
import { captureResultTargetIds } from './result-revocation-data.ts'
import { originalOrderingLedgerFor } from '../result-ordering-internal.ts'
import type { Mutations } from "./mutations.ts"
import type { Documents } from "./documents.ts"
import type { createProcessReadLatches } from './process-read-latches.ts'
import type { DeletionDocumentCleanup } from './documents.ts'
import { captureDeletionMethod, beginOriginalDeletionParticipant, captureOriginalDeletionCleanup, closeOriginalDeletionCleanup, originalDeletionCleanupIssued, assertOriginalDeletionCleanupSettled, type OriginalDeletionReservation, type OriginalDeletionCleanup, type DeletionParticipant, type DeletionPreparationScope } from './deletion-preparation.ts'

export function createLifecycle(
  backend: Pick<PersistenceBackend, "deleteOwnedSession">,
  ownership: Ownership,
  { closeAdmission, pendingWriteBehind, removeWriteBehind, flushWriteBehinds, cancelAutomaticWaits, clearConversationIndexes }:
    Pick<Mutations, "closeAdmission" | "pendingWriteBehind" | "removeWriteBehind" | "flushWriteBehinds" | "cancelAutomaticWaits" | "clearConversationIndexes">,
  { closeAdmissions: closeDocumentAdmissions, pendingWrites: pendingDocuments, observations, withDeletionDocumentLeases, retryDisposals, joinTaskDocumentIO }:
    Pick<Documents, "closeAdmissions" | "pendingWrites" | "observations" | "withDeletionDocumentLeases" | "retryDisposals" | "joinTaskDocumentIO">,
  managed: { revoke(sessionId: string): void; closeOne(sessionId: string): Promise<void> },
  processLatches?: ReturnType<typeof createProcessReadLatches>,
) {
  const { withSessionOperation, ensureOwnership, releaseOwnershipUnlocked, pendingOperations, releaseHeldLocks } = ownership
  const deletedListeners = new Set<(sessionId: string, manifest: SessionArtifactManifest) => Promise<void>>()
  let participant: DeletionParticipant['begin'] | undefined, started = false
  let preflightParticipant: (() => void) | undefined
  let reserveParticipant: DeletionParticipant['reserve']
  const scopes = new WeakSet<object>()
  const batches = new WeakMap<object, { batch: OriginalOwnershipBatch; cleanup: OwnershipCleanup }>()
  const plans = new WeakMap<object, { plan: OriginalOwnershipPlan; cleanup: OwnershipCleanup }>()
  const attempts = new Set<{ sessionId: string; resources: Set<string>; active: boolean; retry(): Promise<void> }>()
  const reservations = new Set<Set<string>>()
  const fail = () => Object.assign(new Error('Result revocation busy'), { code: 'RESULT_REVOCATION_BUSY' })
  function throwFailures(errors: unknown[]) { if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, 'Deletion cleanup unresolved') }
  async function retryDeletionCleanup() {
    if ([...attempts].some(attempt => attempt.active)) throw fail()
    const results = await Promise.allSettled([...attempts].map(attempt => attempt.retry()))
    throwFailures(results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
  }
  return {
    installDeletionParticipant(original: DeletionParticipant) {
      if (participant || started || !ownership.lockEnabled) throw new TypeError('Deletion construction unavailable')
      participant = captureDeletionMethod(original, 'begin')
      if (Object.getOwnPropertyDescriptor(original, 'assertReady')) preflightParticipant = captureDeletionMethod(original, 'assertReady')!
      if (Object.getOwnPropertyDescriptor(original, 'reserve')) reserveParticipant = captureDeletionMethod(original, 'reserve')!
    },
    captureDeletionScope(scope: DeletionPreparationScope) {
      if (!scopes.has(scope)) throw new TypeError('Original deletion scope required')
      scope.assertCurrent(); return scope
    },
    captureDeletionBatch(scope: DeletionPreparationScope) {
      if (!scopes.has(scope)) throw TypeError('Original deletion scope required')
      scope.assertCurrent(); const original = batches.get(scope)
      if (!original) throw TypeError('Original deletion batch not acquired')
      return original
    },
    captureDeletionPlan(scope: DeletionPreparationScope) {
      if (!scopes.has(scope)) throw TypeError('Original deletion scope required')
      scope.assertCurrent(); const original = plans.get(scope)
      if (!original) throw TypeError('Original deletion plan not captured')
      return original
    },
    retryDeletionCleanup,
    onDocumentDeleted(listener: (sessionId: string, manifest: SessionArtifactManifest) => Promise<void>) {
      deletedListeners.add(listener)
      return () => { deletedListeners.delete(listener) }
    },
    async deleteOwnedSession(sessionId: string, manifest: SessionArtifactManifest) {
      started = true
      // Admission, keyed leases and the backend must consume one captured set.
      manifest = { documents: [...manifest.documents], ...(manifest.files === undefined ? {} : { files: [...manifest.files] }) }
      ownership.assertOutsideSessionOperation(sessionId)
      const ordering = participant && ownership.lockEnabled ? originalOrderingLedgerFor(ownership) : undefined
      ordering?.assertOutside()
      preflightParticipant?.()
      const deletionResources = ownership.exclusionScope([sessionId], manifest.documents)
      deletionResources.assertCurrent()
      if ([...attempts].some(attempt => deletionResources.keys.some(key => attempt.resources.has(key))) || [...reservations].some(resources => deletionResources.keys.some(key => resources.has(key)))) throw fail()
      observations.assertOutsideObservedSession(sessionId)
      for (const key of manifest.documents) observations.assertOutsideObservedDocument(key)
      observations.assertOutsideOwnedOperations([sessionId], manifest.documents)
      const token = processLatches?.beginMutation({ sessionIds: [sessionId], documentKeys: manifest.documents, kind: 'other' })
      const reservation = new Set(deletionResources.keys); reservations.add(reservation)
      let origin: ReturnType<NonNullable<typeof ordering>['begin']> | undefined
      try { origin = ordering?.begin() } catch (cause) { reservations.delete(reservation); token?.end('settled'); throw cause }
      let exited = false, cleaned = false, originalRetry: (() => Promise<void>) | undefined
      let preludeFailure: { cause: unknown } | undefined
      let preludeStarted = false
      let participantReservation: OriginalDeletionReservation | undefined, reservedCleanup: OwnershipCleanup | undefined
      const retire = () => { if (exited && cleaned) { if (origin) ordering!.complete(origin); attempts.delete(attempt) } }
      const attempt = { sessionId, resources: new Set(deletionResources.keys), active: true, async retry() {
        if (attempt.active) throw fail()
        if (preludeFailure && (!reservedCleanup || preludeStarted)) throw preludeFailure.cause
        if (originalRetry) await originalRetry()
        if (reservedCleanup) { await reservedCleanup.close(); reservedCleanup.assertSettled() }
        cleaned = true; retire()
      } }
      attempts.add(attempt)
      let outcome: 'settled' | 'unknown' = 'unknown'
      const execute = async () => {
      try {
      if (reserveParticipant) {
        const returned = reserveParticipant(origin!, (reservation, cleanup) => { participantReservation = reservation; reservedCleanup = cleanup })
        if (!participantReservation || returned !== participantReservation || !reservedCleanup) throw TypeError('Original deletion reservation differs from retained cleanup')
      }
      // Close local admissions synchronously, before awaiting the existing writes.
      preludeStarted = true
      const admission = observations.beginMutation([sessionId], manifest.documents, true)
      closeAdmission(sessionId)
      closeDocumentAdmissions(manifest.documents)
      managed.revoke(sessionId)
      try {
        const predecessor = origin && ordering!.predecessors(origin); if (predecessor) await predecessor.join()
        await admission.join()
        await managed.closeOne(sessionId)
        const wb = pendingWriteBehind(sessionId)
        if (wb) { wb.cancelAutomaticWait(); await wb.flush(); removeWriteBehind(sessionId) }
        await pendingDocuments()
        await withSessionOperation(sessionId, async () => {
          const turn = ownership.captureActiveSessionOperation(sessionId)
          let pin: Awaited<ReturnType<Ownership['pinOwnership']>> | undefined, targetCleanup: { close(): Promise<void> } | undefined
          let held: ReturnType<typeof captureHeldOwnershipClaim> | undefined
          const extra: { cleanup: { close(): Promise<void> }; guard?: ReturnType<typeof captureHeldOwnershipClaim> }[] = []
          const admissions: ReturnType<typeof observations.beginMutation>[] = []
          let documents: DeletionDocumentCleanup | undefined, original: ReturnType<DeletionParticipant['begin']> | undefined
          let batch: OriginalOwnershipBatch | undefined
          let closeParticipant: (() => Promise<void>) | undefined, participantClosed = false
          let participantCleanup: OriginalDeletionCleanup | undefined
          let settleParticipant: (() => Promise<void>) | undefined
          let failParticipant: ((cause: unknown) => void) | undefined
          let phase: 'prepare' | 'effect' | 'done' = 'prepare', targets: string[] | undefined, targetsFlight: Promise<void> | undefined
          let planFlight: Promise<void> | undefined
          let cleanupFlight: Promise<void> | undefined, effectsStarted = false
          const check = () => { if (!attempt.active || phase === 'done') throw fail(); turn.assertCurrent(); held?.assertHeld(); if (participant && !held) throw fail(); if (batch && targets) assertOriginalOwnershipBatchCoverage(ownership, batch, targets); for (const item of extra) item.guard?.assertHeld() }
          const scope = Object.freeze({ sessionId, manifest: Object.freeze({ documents: Object.freeze([...manifest.documents]), ...(manifest.files === undefined ? {} : { files: Object.freeze([...manifest.files]) }) }),
            assertCurrent() { if (this !== scope) throw new TypeError('Invalid deletion receiver'); check() },
            assertDocumentsCovered(keys: readonly string[]) { if (this !== scope) throw new TypeError('Invalid deletion receiver'); check(); if (phase !== 'effect' || !documents) throw fail(); documents.assertCovered(keys) },
            async planTargets(ids: readonly string[]) {
              if (this !== scope) throw TypeError('Invalid deletion receiver'); check(); if (phase !== 'prepare' || !ownership.artifacts) throw fail()
              const requested = [...new Set([sessionId, ...captureResultTargetIds(ids)])].sort()
              if (targets) { if (targets.length !== requested.length || targets.some((id, index) => id !== requested[index])) throw fail(); await planFlight; return }
              targets = requested
              const flight = (async () => {
                const entry = { cleanup: undefined as unknown as OwnershipCleanup }; extra.push(entry)
                const plan = await planOriginalOwnershipBatch(ownership, requested, cleanup => { entry.cleanup = cleanup }, origin)
                const complete = captureOriginalOwnershipPlanScope(ownership, plan)
                complete.assertCurrent()
                if ([...attempts].some(other => other !== attempt && complete.keys.some(key => other.resources.has(key))) || [...reservations].some(other => other !== reservation && complete.keys.some(key => other.has(key)))) throw fail()
                for (const key of complete.keys) { attempt.resources.add(key); reservation.add(key) }
                plans.set(scope, Object.freeze({ plan, cleanup: entry.cleanup }))
                // Capture complete exclusion before joining any target drain.
                for (const id of requested.filter(id => id !== sessionId)) admissions.push(observations.beginMutation([id], []))
              })()
              planFlight = flight; void flight.catch(() => {}); await flight
            },
            async acquireTargets(ids: readonly string[]) {
              if (this !== scope) throw new TypeError('Invalid deletion receiver'); check(); if (phase !== 'prepare') throw fail()
              const requested = [...new Set([sessionId, ...captureResultTargetIds(ids)])].sort()
              if (requested.some(id => typeof id !== 'string' || !id)) throw new TypeError('Invalid deletion targets')
              if (ownership.artifacts) {
                if (targets && (targets.length !== requested.length || targets.some((id, index) => id !== requested[index]))) throw fail()
                if (targetsFlight) return targetsFlight
                const flight = (async () => {
                  await scope.planTargets(requested)
                  const original = plans.get(scope)!
                  for (const admission of admissions) { await admission.join(); check() }
                  batch = await acquireOriginalOwnershipPlan(ownership, original.plan); batches.set(scope, Object.freeze({ batch, cleanup: original.cleanup })); check()
                })()
                targetsFlight = flight; void flight.catch(() => {}); await flight; return
              }
              if (targets) { if (targets.length !== requested.length || targets.some((id, index) => id !== requested[index])) throw fail(); return targetsFlight }
              // The already-owned deletion target cannot be dropped to reorder.
              const base = ownership.exclusionScope([sessionId], []); base.assertCurrent()
              const additional = requested.filter(id => id !== sessionId).map(id => ({ id, resource: ownership.exclusionScope([id], []) }))
              if (additional.some(item => item.resource.keys.some(key => key < base.keys[0]!))) throw fail()
              if (additional.some(item => [...attempts].some(other => other !== attempt && item.resource.keys.some(key => other.resources.has(key))))) throw fail()
              if (additional.some(item => [...reservations].some(other => other !== reservation && item.resource.keys.some(key => other.has(key))))) throw fail()
              targets = requested
              additional.sort((a, b) => a.resource.keys[0]! < b.resource.keys[0]! ? -1 : a.resource.keys[0]! > b.resource.keys[0]! ? 1 : 0)
              for (const item of additional) for (const key of item.resource.keys) attempt.resources.add(key)
              const flight = (async () => {
              for (const item of additional) {
                item.resource.assertCurrent()
                const admission = observations.beginMutation([item.id], []); admissions.push(admission); await admission.join(); check()
                const entry = { cleanup: undefined as unknown as { close(): Promise<void> }, guard: undefined as ReturnType<typeof captureHeldOwnershipClaim> | undefined }; extra.push(entry)
                const claim = origin ? await pinOriginalOwnershipInOrder(ownership, item.id, cleanup => { entry.cleanup = cleanup }, origin) : await ownership.pinOwnershipRetained(item.id, cleanup => { entry.cleanup = cleanup })
                entry.guard = captureHeldOwnershipClaim(ownership, item.id, claim); check()
              }
              })()
              targetsFlight = flight; void flight.catch(() => {}); await flight
            },
          }) as unknown as DeletionPreparationScope
          scopes.add(scope)
          originalRetry = () => {
            if (cleanupFlight) return cleanupFlight
            const flight = (async () => {
              if (closeParticipant && !participantClosed) { await closeParticipant(); participantClosed = true }
              await documents?.close()
              // All original workspace/files/doc cleanup precedes claim retirement.
              while (extra.length) { await extra.at(-1)!.cleanup.close(); extra.pop() }
              await releaseOwnershipUnlocked(sessionId)
              await targetCleanup?.close()
              await settleParticipant?.()
              for (const admission of admissions) admission.finish('settled')
              admission.finish('settled')
            })()
            cleanupFlight = flight; void flight.finally(() => { if (cleanupFlight === flight) cleanupFlight = undefined }).catch(() => {}); return flight
          }
          let failed = false, primary: unknown
          const cleanupErrors: unknown[] = []
          try {
            if (ownership.lockEnabled) {
              pin = origin ? await pinOriginalOwnershipInOrder(ownership, sessionId, cleanup => { targetCleanup = cleanup }, origin) : await ownership.pinOwnershipRetained(sessionId, cleanup => { targetCleanup = cleanup })
              held = captureHeldOwnershipClaim(ownership, sessionId, pin); pin.retainLive()
            } else await ensureOwnership(sessionId)
            if (participant) {
              check(); original = beginOriginalDeletionParticipant(participant, scope, participantReservation)
              participantCleanup = captureOriginalDeletionCleanup(scope, original)
              closeParticipant = () => closeOriginalDeletionCleanup(participantCleanup!)
              if (Object.getOwnPropertyDescriptor(original, 'settle')) settleParticipant = captureDeletionMethod(original, 'settle')!
              if (Object.getOwnPropertyDescriptor(original, 'fail')) failParticipant = captureDeletionMethod(original, 'fail')!
              const prepare = captureDeletionMethod(original, 'prepare'), effect = captureDeletionMethod(original, 'effect')
              await prepare(); await planFlight; await targetsFlight; check()
              if (ownership.artifacts && !batch) throw fail()
              phase = 'effect'
              await withDeletionDocumentLeases(manifest.documents, async () => {
                check(); documents!.assertCovered(manifest.documents); effectsStarted = true
                await backend.deleteOwnedSession!(sessionId, manifest)
                await effect()
                for (const listener of deletedListeners) await listener(sessionId, manifest)
              }, cleanup => { documents = cleanup }, participantCleanup)
            } else {
              phase = 'effect'
              await withDeletionDocumentLeases(manifest.documents, async () => {
                effectsStarted = true
                await backend.deleteOwnedSession!(sessionId, manifest)
                for (const listener of deletedListeners) await listener(sessionId, manifest)
              }, cleanup => { documents = cleanup })
            }
          } catch (error) { failed = true; primary = error }
          // Even a participant which returned early cannot outrun its own
          // finite acquisition or turn its rejection into apparent coverage.
          try { await planFlight; await targetsFlight } catch (error) { if (!failed) { failed = true; primary = error } else if (error !== primary) cleanupErrors.push(error) }
          phase = 'done'; scopes.delete(scope)
          // Initial cleanup uses no retry of a failed original doc disposer.
          try {
            if (closeParticipant) {
              if (!participantCleanup || !originalDeletionCleanupIssued(participantCleanup)) await closeParticipant()
              if (participantCleanup) assertOriginalDeletionCleanupSettled(participantCleanup)
              participantClosed = true
            }
          } catch (error) { cleanupErrors.push(error) }
          let documentsSettled = true
          try { documents?.assertSettled() } catch (error) { documentsSettled = false; cleanupErrors.push(error) }
          if (failed || cleanupErrors.length) failParticipant?.(failed ? primary : cleanupErrors[0])
          attempt.active = false
          if (documentsSettled && !cleanupErrors.length && !(failed && effectsStarted)) {
            try { await attempt.retry() } catch (error) { cleanupErrors.push(error) }
          }
          throwFailures([...(failed ? [primary] : []), ...cleanupErrors])
        })
      } catch (cause) { if (!originalRetry) preludeFailure = { cause }; throw cause }
      outcome = 'settled'
      } catch (cause) { if (!originalRetry) preludeFailure = { cause }; throw cause }
      finally { reservations.delete(reservation); token?.end(outcome) }
      }
      try { if (origin) await ordering!.run(origin, execute); else await execute() }
      finally { attempt.active = false; exited = true; retire() }
    },
    async close(releaseOwners = true, settleArchiveReads?: () => Promise<void>) {
      for (const attempt of attempts) ownership.assertOutsideSessionOperation(attempt.sessionId)
      processLatches?.closeAdmission()
      const flushed = await Promise.allSettled(flushWriteBehinds())
      cancelAutomaticWaits()
      const documentCleanup = await Promise.allSettled([pendingDocuments()])
      await Promise.allSettled(pendingOperations())
      const taskCleanup = await Promise.allSettled([joinTaskDocumentIO()])
      const deletionCleanup = await Promise.allSettled([retryDeletionCleanup()])
      const archiveCleanup = await Promise.allSettled([settleArchiveReads?.()])
      // Unknown managed/observation work still depends on its original actual
      // owners. Independent drainage may proceed without retiring those leases.
      const released = releaseOwners && [...documentCleanup, ...taskCleanup, ...deletionCleanup, ...archiveCleanup].every(result => result.status === 'fulfilled') ? await Promise.allSettled(releaseHeldLocks()) : []
      const disposed = await Promise.allSettled([retryDisposals()])
      clearConversationIndexes()
      const failures = [...flushed, ...documentCleanup, ...taskCleanup, ...deletionCleanup, ...archiveCleanup, ...released, ...disposed].flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, "Failed to persist sessions during shutdown")
    },
  }
}
