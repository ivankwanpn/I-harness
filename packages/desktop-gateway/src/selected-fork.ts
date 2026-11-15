import { createManagedSessionState } from '@i-harness/core-session'
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
  const context = createCompletedPassiveContext(owner as never, { kind: 'completed' })
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

/** The commit-log store has no selected-results bootstrap kernel, so the seed
 *  capture alone leaves the child with metadata only: every inherited page was
 *  readable only while an ancestor still owned it. Publishing one durable pin
 *  per inherited managed artifact is the target's retention contract here; the
 *  service refuses the grant unless the source still owns the exact committed
 *  ref, and the pin is what keeps the bytes alive when the source is retired. */
async function retainSelectedManagedResults(
  contextOutput: { grant(access: { sessionId: string }, refIds: string[], targetSessionId: string): Promise<void> } | undefined,
  compiled: CompiledSelectedResultsSemanticSeed, sourceSessionId: string, targetSessionId: string,
): Promise<void> {
  const ids = selectedManagedRefIds(compiled)
  if (!contextOutput || ids.length === 0) return
  // The service bounds one grant at 100 references.
  for (let index = 0; index < ids.length; index += 100) await contextOutput.grant({ sessionId: sourceSessionId }, ids.slice(index, index + 100), targetSessionId)
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
      const captured = await captureSelectedResultsSeed(coordinator, request.sourceSessionId, options.assertAvailable)
      if (captured.kind !== 'compiled') return { kind: 'unavailable', reason: captured.reason === 'source-changed' ? 'source-unavailable' : 'unsupported' }
      const project = (await options.projectOf?.(request.sourceSessionId)) ?? { kind: 'unmanaged' as const }
      const core = { version: 2 as const, kind: 'session-fork-core' as const, sourceSessionId: request.sourceSessionId,
        selection: request.selection ?? { kind: 'completed' as const }, sourceCapture: 'first-authorized-capture' as const,
        metadata: request.metadata ?? {}, results: 'selected-results-v1' as const }
      const { intent, requestDigest } = createSelectedResultsIntent(core, project)
      return { kind: 'prepared', prepared: { version: 2, kind: 'session-fork-prepared', core: readSelectedResultsCore(core), requestIntent: intent, requestDigest } }
    },
    async execute(command) {
      options.assertAvailable?.()
      const operation = command.operation
      const captured = await captureSelectedResultsSeed(coordinator, operation.prepared.core.sourceSessionId, options.assertAvailable)
      if (captured.kind !== 'compiled') return { version: 2, kind: 'not-issued', operation, capture: 'uncaptured', reason: 'source-unavailable' }
      const compiled = captured.compiled
      const createChildSession = (coordinator as unknown as { createChildSession?: (request: never, options: { closure: string }) => Promise<{ id: string; receipt: { manifestDigest: string; seedLength: number; dependencyClosureDigest: string } }> }).createChildSession
      if (!createChildSession) return { version: 2 as const, kind: 'not-issued' as const, operation, capture: 'uncaptured' as const, reason: 'unsupported' as const }
      const created = await createChildSession.call(coordinator, {
        invocation: operation.invocation, target: { kind: 'new' }, metadata: operation.prepared.core.metadata,
        lineage: { origin: 'fork', parentSession: operation.prepared.core.sourceSessionId }, seed: compiled,
      } as never, { closure: compiled.dependencyDigest })
      // Retain after the child exists: a failed birth must not leave pins for a
      // document that was never created. A failed grant keeps the child
      // unfinished for this operation; the retry route re-runs the same capture
      // and grant, and the idempotent birth returns the existing target.
      options.assertAvailable?.()
      await retainSelectedManagedResults(options.contextOutput, compiled, operation.prepared.core.sourceSessionId, created.id)
      options.assertAvailable?.()
      if (options.taskDocumentEmpty && await coordinator.getDocument('task-' + created.id) === undefined) await coordinator.putDocument('task-' + created.id, options.taskDocumentEmpty())
      const project = operation.prepared.requestIntent.project
      if (project.kind === 'project') {
        const { createHash } = await import('node:crypto')
        const key = 'desktop-session-project-' + createHash('sha256').update(operation.invocation.targetSessionId).digest('hex')
        if (await coordinator.getDocument(key) === undefined) await coordinator.putDocument(key, Object.freeze({ version: 1, projectId: project.projectId }))
      }
      const manifest = compiled.records[0] as { results?: { version: 1; rows: number; pages: number; digest: string } }
      return { version: 2 as const, kind: 'ready' as const, operation, capture: 'captured' as const, sessionId: operation.invocation.targetSessionId,
        seedLength: created.receipt.seedLength,
        receipt: { version: 2 as const, invocation: operation.invocation, manifestDigest: created.receipt.manifestDigest, seedLength: created.receipt.seedLength,
          dependencyClosureDigest: created.receipt.dependencyClosureDigest, seedDigest: compiled.digest,
          sourceObservation: { kind: 'semantic' as const, digest: (compiled.sourceObservation as { digest: string }).digest },
          results: manifest.results ?? { version: 1 as const, rows: 0, pages: 0, digest: '0'.repeat(64) } } }
    },
  }
}