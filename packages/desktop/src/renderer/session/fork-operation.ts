import { createForkOperation, readForkPrepareResult, readForkOutcome, readForkHostErrorData, ForkOperationError, ForkPreparationError,
  type ForkOperation, type ForkOutcome } from '@i-harness/sdk/fork'
import type { DesktopBridge } from '../../shared/bridge.ts'

interface NavigationTicket { selection: object; version: number; active: boolean }
interface Attempt { workspaceId: string; operation?: ForkOperation; dispatched: boolean; outcome?: ForkOutcome; error?: unknown; flight?: Promise<ForkOutcome>; navigation?: NavigationTicket; cleanupPending?: boolean }
export interface ForkOperationState { readonly operation?: ForkOperation; readonly outcome?: ForkOutcome; readonly error?: unknown; readonly running: boolean; readonly cleanupPending: boolean }
// Only these current responses follow original prerequisite and handoff cleanup
// in the reviewed controller. Early conflict/not-issued stay conservative.
const postCleanupRefusals = new Set(['nonempty', 'cached-unprepared', 'wrong-view', 'incompatible', 'manifest-invalid', 'target-policy',
  'invalid-selection', 'source-unsupported', 'ambiguous-boundary', 'no-completed-boundary', 'straddling-group', 'unsafe-input-component', 'invalid-seed', 'source-changed', 'legacy-anchor-unsupported'])
const postCleanupBlocks = new Set(['unknown', 'payload-required', 'dependency-unavailable', 'source-changed'])
const acknowledgesOriginalCleanup = (outcome: ForkOutcome) => outcome.kind === 'ready' || outcome.kind === 'adopted'
  || outcome.kind === 'blocked' && postCleanupBlocks.has(outcome.reason) || outcome.kind === 'refused' && postCleanupRefusals.has(outcome.reason)

/** UI intent and recoverable operation data only; the Gateway owns execution. */
export function createForkOperationController(options: {
  bridge: Pick<DesktopBridge, 'request'>
  selection(): object
  navigationVersion(): number
  refresh(workspaceId: string): Promise<void>
  navigate(workspaceId: string, targetSessionId: string): void
  identity?(): { operationId: string; targetSessionId: string; createdAt: string }
}) {
  const attempts = new Map<string, Attempt>(), key = (workspaceId: string, sourceSessionId: string) => JSON.stringify([workspaceId, sourceSessionId])
  const identity = options.identity ?? (() => ({ operationId: crypto.randomUUID(), targetSessionId: crypto.randomUUID(), createdAt: new Date().toISOString() }))
  const current = (ticket: NavigationTicket) => {
    if (ticket.selection !== options.selection() || ticket.version !== options.navigationVersion()) ticket.active = false
    return ticket.active
  }
  const retireNavigation = (workspaceId?: string) => {
    for (const attempt of attempts.values()) if (workspaceId === undefined || attempt.workspaceId === workspaceId) { if (attempt.navigation) attempt.navigation.active = false }
  }
  function run(workspaceId: string, sourceSessionId: string): Promise<ForkOutcome> {
    const id = key(workspaceId, sourceSessionId)
    let attempt = attempts.get(id)
    if (attempt?.flight) return attempt.flight
    if (!attempt) { attempt = { workspaceId, dispatched: false }; attempts.set(id, attempt) }
    const owned = attempt, ticket: NavigationTicket = { selection: options.selection(), version: options.navigationVersion(), active: true }
    owned.navigation = ticket; owned.error = undefined
    // Reserve the entire preparation/dispatch/refresh flight before callback work.
    const flight = Promise.resolve().then(async () => {
      try {
        if (!owned.operation) {
          let reply: unknown
          try { reply = await options.bridge.request({ kind: 'desktop/session/fork/prepare', workspaceId, request: { version: 1, sourceSessionId } }) }
          catch (cause) { throw new ForkPreparationError('transport', undefined, { cause }) }
          let prepared
          try { prepared = readForkPrepareResult(reply) }
          catch (cause) { throw new ForkPreparationError('protocol', undefined, { cause }) }
          if (prepared.kind !== 'prepared') throw new ForkPreparationError('unavailable', prepared)
          if (prepared.prepared.core.sourceSessionId !== sourceSessionId || prepared.prepared.core.selection.atSeq !== undefined) throw new ForkPreparationError('protocol')
          current(ticket)
          owned.operation = createForkOperation(prepared.prepared, identity())
        }
        const operation = owned.operation, kind = owned.dispatched ? 'desktop/session/fork/retry' : 'desktop/session/fork/begin'
        // A synchronous transport throw is uncertain dispatch too. Never remint.
        owned.dispatched = true
        let reply: unknown
        try { reply = await options.bridge.request({ kind, workspaceId, operation }) }
        catch (cause) { throw new ForkOperationError(operation, 'transport', { cause }) }
        let outcome: ForkOutcome
        try { outcome = readForkOutcome(reply, operation) }
        catch (cause) {
          let error
          try { error = readForkHostErrorData(reply, operation) }
          catch { throw new ForkOperationError(operation, 'protocol', { cause }) }
          if (error.lastOutcome) owned.outcome = error.lastOutcome
          if (error.reason === 'cleanup-incomplete') owned.cleanupPending = true
          throw new ForkOperationError(operation, error.reason === 'cleanup-incomplete' ? 'cleanup' : 'host', { hostError: error })
        }
        owned.outcome = outcome
        if (acknowledgesOriginalCleanup(outcome)) owned.cleanupPending = false
        if (outcome.kind !== 'ready' && outcome.kind !== 'adopted') throw new ForkOperationError(operation, 'outcome', { outcome })
        current(ticket)
        // Save the validated target before refresh can fail or selection move.
        await options.refresh(workspaceId)
        if (current(ticket)) options.navigate(workspaceId, outcome.sessionId)
        return outcome
      } catch (cause) { owned.error = cause; throw cause }
    })
    owned.flight = flight
    const finish = () => { if (owned.flight === flight) owned.flight = undefined }
    void flight.then(finish, finish)
    return flight
  }
  return {
    run,
    state(workspaceId: string, sourceSessionId: string): ForkOperationState {
      const attempt = attempts.get(key(workspaceId, sourceSessionId))
      return Object.freeze({ ...(attempt?.operation ? { operation: attempt.operation } : {}), ...(attempt?.outcome ? { outcome: attempt.outcome } : {}),
        ...(attempt?.error === undefined ? {} : { error: attempt.error }), running: !!attempt?.flight, cleanupPending: !!attempt?.cleanupPending })
    },
    refresh(workspaceId: string) { retireNavigation(workspaceId); return options.refresh(workspaceId) },
    retireNavigation,
    fresh(workspaceId: string, sourceSessionId: string): Promise<ForkOutcome> {
      const id = key(workspaceId, sourceSessionId), original = attempts.get(id)
      if (original?.flight) return Promise.reject(new Error('Conversation fork is already in progress'))
      if (original?.cleanupPending) return Promise.reject(new Error('Recover the current branch before creating another branch'))
      if (original?.navigation) original.navigation.active = false
      attempts.delete(id)
      return run(workspaceId, sourceSessionId)
    },
  }
}

/** The two App entry signatures share the same held attempt and fresh guard. */
export function createForkCallbackAdapters(controller: ReturnType<typeof createForkOperationController>) {
  const inWorkspace = (workspaceId: string, sourceSessionId: string, action: 'fork' | 'fork-fresh') => action === 'fork-fresh'
    ? controller.fresh(workspaceId, sourceSessionId) : controller.run(workspaceId, sourceSessionId)
  return { inWorkspace, inSelection(workspaceId: string | undefined, sourceSessionId: string, action: 'fork' | 'fork-fresh') {
    return workspaceId === undefined ? Promise.resolve(undefined) : inWorkspace(workspaceId, sourceSessionId, action)
  } }
}
