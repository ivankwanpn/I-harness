import { canonicalJsonData, createManagedSessionState } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createCompletedPassiveContext } from '@i-harness/core-session/internal/conversation-passive-context'
import { exportSelectedResultsConversationSeed } from '../../core-session/src/conversation/seed-export.ts'
import { compileSelectedResultsSemanticSeed, type CompiledSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { createSelectedResultsIntent, readSelectedResultsCore, type ForkCommandV2, type ForkOutcomeV2, type ForkPrepareRequestV2, type ForkPrepareResultV2 } from '../../session-persistence/src/selected-results-fork-contract.ts'

/** Build the v3 seed a selected-results fork hands to the child. The source is
 *  read through the coordinator's own snapshot, so this works on any store that
 *  can fold a session (the commit log included). */
export async function captureSelectedResultsSeed(
  coordinator: SessionCoordinator, sourceSessionId: string, assertCurrent: () => void = () => {},
  selection: { kind: 'completed'; atSeq?: number } = { kind: 'completed' },
): Promise<{ kind: 'compiled'; compiled: CompiledSelectedResultsSemanticSeed } | { kind: 'refused'; reason: string }> {
  assertCurrent()
  const { session } = await coordinator.load(sourceSessionId)
  assertCurrent()
  const managed = createManagedSessionState(session as never, { sessionId: sourceSessionId })
  const factOwner = {} as never
  managed.bindOwner(factOwner)
  const owner = { kind: 'held-public-fork' as const, view: managed.view, factOwner, sourceSessionId, assertCurrent }
  // A child that was itself a selected-results fork starts with a v3 seed. Its
  // legacy-protocol rows need the inherited metadata the exporter validates
  // against; the seed pages themselves are that source of truth.
  type SeedPage = { ordinal: number; rows?: { ordinal: number; protocol?: string; ref?: unknown; original?: unknown; extent?: unknown }[] }
  const events = session.events as { type: string; version?: number; page?: SeedPage }[]
  const v3 = events[0]?.type === 'conversation/seed-manifest' && events[0]?.version === 3
  const pages = events.filter(event => event.type === 'conversation/seed-results').map(event => event.page).filter((page): page is SeedPage => page !== undefined)
  const inherited = v3
    ? { assertCurrent, async *legacy() {
        for (const page of pages) for (const row of page.rows ?? []) {
          if (row.protocol !== 'legacy' || row.ref === undefined || row.original === undefined || row.extent === undefined) continue
          assertCurrent()
          yield { ref: row.ref, original: row.original, extent: row.extent, anchor: { kind: 'seed-result' as const, manifestSeq: 0 as const, pageOrdinal: page.ordinal, rowOrdinal: row.ordinal } }
        }
      } }
    : { assertCurrent, async *legacy() { assertCurrent() } }
  const context = createCompletedPassiveContext(owner as never, selection as never)
  if (context.kind !== 'ready') return { kind: 'refused', reason: context.reason }
  assertCurrent()
  const exported = await exportSelectedResultsConversationSeed(context.context as never, inherited as never)
  assertCurrent()
  if (exported.kind !== 'seed') return { kind: 'refused', reason: 'unsupported-history' }
  return { kind: 'compiled', compiled: compileSelectedResultsSemanticSeed(exported) }
}
export type SelectedForkController = {
  prepare(request: ForkPrepareRequestV2): Promise<ForkPrepareResultV2>
  execute(command: ForkCommandV2): Promise<ForkOutcomeV2>
}

/** Managed rows the target must be able to read with its own durable pin. */
function selectedManagedRefIds(compiled: CompiledSelectedResultsSemanticSeed): string[] {
  const ids = new Set<string>()
  for (const record of compiled.records) {
    if (record.type !== 'conversation/seed-results') continue
    for (const row of record.page.rows) if (row.protocol === 'managed') ids.add(row.ref.id)
  }
  return [...ids]
}

/** One durable document per selected operation: the first authorized capture,
 *  the completed grant progress and the acknowledged outcome. Replaying the
 *  same operation after an ACK loss, a failed grant or a host restart adopts
 *  this state instead of re-capturing a source that may have moved on. */
type SelectedForkSuccess = Extract<ForkOutcomeV2, { kind: 'ready' | 'adopted' }>
type StoredSelectedForkState = {
  version: 1
  capture?: CompiledSelectedResultsSemanticSeed
  granted?: number
  outcome?: SelectedForkSuccess
}
const GRANT_BATCH = 100
function storedSelectedForkState(value: unknown): StoredSelectedForkState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const state = value as Record<string, unknown>
  if (state.version !== 1) return undefined
  if (state.capture !== undefined) {
    const capture = state.capture as { digest?: unknown; records?: unknown }
    if (!capture || typeof capture !== 'object' || typeof capture.digest !== 'string' || !Array.isArray(capture.records)) return undefined
  }
  if (state.granted !== undefined && (!Number.isSafeInteger(state.granted) || (state.granted as number) < 0)) return undefined
  if (state.outcome !== undefined) {
    const outcome = state.outcome as { kind?: unknown }
    if (!outcome || typeof outcome !== 'object' || (outcome.kind !== 'ready' && outcome.kind !== 'adopted')) return undefined
  }
  return state as StoredSelectedForkState
}
async function selectedOperationKey(operation: ForkCommandV2['operation']): Promise<string> {
  const { createHash } = await import('node:crypto')
  return 'selected-fork-' + createHash('sha256').update(canonicalJsonData(operation)).digest('hex')
}
async function selectedTargetStatus(coordinator: SessionCoordinator, operation: ForkCommandV2['operation']): Promise<'ready' | 'absent' | 'conflict' | 'policy'> {
  const id = operation.invocation.targetSessionId
  try {
    // The durable target identity is the session profile, not the reduced
    // managed-document header: profile carries createdAt, lineage and the
    // committed birth seed.
    const { meta } = await coordinator.profile(id) as { meta: { parentSession?: string; origin?: string; createdAt?: string; archived?: boolean; semanticSeed?: { operationId?: string; requestDigest?: string } } }
    if (!meta || typeof meta !== 'object') return 'absent'
    if (meta.parentSession !== operation.prepared.core.sourceSessionId || meta.origin !== 'fork'
      || meta.createdAt !== operation.invocation.createdAt
      || meta.semanticSeed?.operationId !== operation.invocation.operationId
      || meta.semanticSeed?.requestDigest !== operation.invocation.requestDigest) return 'conflict'
    return meta.archived ? 'policy' : 'ready'
  } catch { return 'absent' }
}
function sameProjectIntent(current: { kind: string; projectId?: string }, prepared: { kind: string; projectId?: string }): boolean {
  if (current.kind !== prepared.kind) return false
  return current.kind !== 'project' || current.projectId === prepared.projectId
}

/** Grant one batch at a time and persist the acknowledged batch count so a
 *  retry resumes at the first ungranted batch instead of repeating effects. */
async function retainSelectedManagedResults(
  contextOutput: { grant(access: { sessionId: string }, refIds: string[], targetSessionId: string): Promise<void> },
  ids: string[], sourceSessionId: string, targetSessionId: string,
  state: StoredSelectedForkState, persist: (state: StoredSelectedForkState) => Promise<void>,
): Promise<void> {
  let granted = state.granted ?? 0
  for (let index = granted; index < ids.length; index += GRANT_BATCH) {
    const end = Math.min(index + GRANT_BATCH, ids.length)
    await contextOutput.grant({ sessionId: sourceSessionId }, ids.slice(index, end), targetSessionId)
    granted = end
    state = { ...state, granted }
    await persist(state)
  }
}

/** The commit-log implementation of the v2 (selected-results) fork seams. */
export function createSelectedForkController(options: {
  coordinator: SessionCoordinator
  projectOf?: (sourceSessionId: string) => Promise<{ kind: 'project'; projectId: string } | { kind: 'unmanaged' } | { kind: 'unassigned' }>
  taskDocumentEmpty?: () => unknown
  assertAvailable?: () => void
  /** Durable target retention for inherited managed result bytes. */
  contextOutput?: { grant(access: { sessionId: string }, refIds: string[], targetSessionId: string): Promise<void> }
}): SelectedForkController {
  const { coordinator } = options
  return {
    async prepare(request) {
      options.assertAvailable?.()
      const selection = request.selection ?? { kind: 'completed' as const }
      const captured = await captureSelectedResultsSeed(coordinator, request.sourceSessionId, options.assertAvailable, selection)
      if (captured.kind !== 'compiled') return { kind: 'unavailable', reason: captured.reason === 'source-changed' ? 'source-unavailable' : 'unsupported' }
      const project = (await options.projectOf?.(request.sourceSessionId)) ?? { kind: 'unmanaged' as const }
      const core = { version: 2 as const, kind: 'session-fork-core' as const, sourceSessionId: request.sourceSessionId,
        selection, sourceCapture: 'first-authorized-capture' as const,
        metadata: request.metadata ?? {}, results: 'selected-results-v1' as const }
      const { intent, requestDigest } = createSelectedResultsIntent(core, project)
      return { kind: 'prepared', prepared: { version: 2, kind: 'session-fork-prepared', core: readSelectedResultsCore(core), requestIntent: intent, requestDigest } }
    },
    async execute(command) {
      options.assertAvailable?.()
      const operation = command.operation
      const key = await selectedOperationKey(operation)
      const persist = async (state: StoredSelectedForkState) => { await coordinator.putDocument(key, Object.freeze(state)) }
      let state = storedSelectedForkState(await coordinator.getDocument(key))
      // A completed operation is durable: replay adopts the committed target
      // and exact receipt even if the source has since changed, been archived
      // or cleared. No capture, grant or seed write is repeated.
      if (state?.outcome) {
        const status = await selectedTargetStatus(coordinator, operation)
        if (status === 'ready') return { ...state.outcome, kind: 'adopted' as const }
        if (status === 'policy') return { version: 2 as const, kind: 'refused' as const, operation, capture: 'captured' as const, reason: 'target-policy' as const }
        if (status === 'conflict') return { version: 2 as const, kind: 'refused' as const, operation, capture: 'captured' as const, reason: 'conflict' as const }
        return { version: 2 as const, kind: 'not-issued' as const, operation, capture: 'captured' as const, reason: 'unavailable' as const }
      }
      // The prepared project intent is part of the operation identity; a source
      // re-bound between prepare and begin cannot silently fork into the old or
      // new project.
      if (options.projectOf) {
        const current = await options.projectOf(operation.prepared.core.sourceSessionId)
        if (!sameProjectIntent(current, operation.prepared.requestIntent.project)) {
          return { version: 2 as const, kind: 'not-issued' as const, operation, capture: state?.capture ? 'captured' as const : 'uncaptured' as const, reason: 'policy' as const }
        }
      }
      let capture = state?.capture
      if (!capture) {
        const captured = await captureSelectedResultsSeed(coordinator, operation.prepared.core.sourceSessionId, options.assertAvailable, operation.prepared.core.selection)
        if (captured.kind !== 'compiled') return { version: 2 as const, kind: 'not-issued' as const, operation, capture: 'uncaptured' as const, reason: 'source-unavailable' as const }
        capture = captured.compiled
        state = { version: 1, capture, granted: 0 }
        await persist(state)
      }
      const ids = selectedManagedRefIds(capture)
      if (ids.length > 0 && !options.contextOutput) {
        return { version: 2 as const, kind: 'not-issued' as const, operation, capture: 'captured' as const, reason: 'unsupported' as const }
      }
      const createChildSession = (coordinator as unknown as { createChildSession?: (request: never, options: { closure: string }) => Promise<{ id: string; receipt: { manifestDigest: string; seedLength: number; dependencyClosureDigest: string } }> }).createChildSession
      if (!createChildSession) return { version: 2 as const, kind: 'not-issued' as const, operation, capture: state?.capture ? 'captured' as const : 'uncaptured' as const, reason: 'unsupported' as const }
      const created = await createChildSession.call(coordinator, {
        invocation: operation.invocation, target: { kind: 'new' }, metadata: operation.prepared.core.metadata,
        lineage: { origin: 'fork', parentSession: operation.prepared.core.sourceSessionId }, seed: capture,
      } as never, { closure: capture.dependencyDigest })
      // Retain after the child exists: a failed birth must not leave pins for a
      // document that was never created. Grant progress is persisted per batch,
      // so a retry resumes at the first ungranted batch on the same capture.
      options.assertAvailable?.()
      if (options.contextOutput) await retainSelectedManagedResults(options.contextOutput, ids, operation.prepared.core.sourceSessionId, created.id, state!, persist)
      options.assertAvailable?.()
      state = storedSelectedForkState(await coordinator.getDocument(key)) ?? state
      if (options.taskDocumentEmpty && await coordinator.getDocument('task-' + created.id) === undefined) await coordinator.putDocument('task-' + created.id, options.taskDocumentEmpty())
      const project = operation.prepared.requestIntent.project
      if (project.kind === 'project') {
        const { createHash } = await import('node:crypto')
        const projectKey = 'desktop-session-project-' + createHash('sha256').update(operation.invocation.targetSessionId).digest('hex')
        if (await coordinator.getDocument(projectKey) === undefined) await coordinator.putDocument(projectKey, Object.freeze({ version: 1, projectId: project.projectId }))
      }
      const manifest = capture.records[0] as { results?: { version: 1; rows: number; pages: number; digest: string } }
      const outcome = { version: 2 as const, kind: 'ready' as const, operation, capture: 'captured' as const, sessionId: operation.invocation.targetSessionId,
        seedLength: created.receipt.seedLength,
        receipt: { version: 2 as const, invocation: operation.invocation, manifestDigest: created.receipt.manifestDigest, seedLength: created.receipt.seedLength,
          dependencyClosureDigest: created.receipt.dependencyClosureDigest, seedDigest: capture.digest,
          sourceObservation: { kind: 'semantic' as const, digest: (capture.sourceObservation as { digest: string }).digest },
          results: manifest.results ?? { version: 1 as const, rows: 0, pages: 0, digest: '0'.repeat(64) } } }
      await persist({ ...(state ?? { version: 1, capture }), capture, outcome })
      return outcome
    },
  }
}