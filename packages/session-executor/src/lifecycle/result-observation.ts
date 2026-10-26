import { AsyncLocalStorage } from 'node:async_hooks'
import { canonicalJsonData, createLegacyReadVisibility, type SessionView } from '@i-harness/core-session'
import { captureLegacyRefCommitment, type ContextCapture, type LegacyCommitment, type LegacyReadObservation, type LegacyReadObservationRunner } from '@i-harness/context-output'
import type { ExistingSessionBindingObservation, SessionBindingObservation, SessionCoordinator, SessionMeta, ManagedDocument } from '@i-harness/session-persistence'

export interface ResultSourceObservation { sessionId: string; metadata: Readonly<SessionMeta>; view: SessionView; source: NonNullable<ContextCapture['source']>; assertCurrent(): void }
export interface ResultObservationCapture {
  sessionId: string; sessionIds: readonly string[]; observation: ExistingSessionBindingObservation | SessionBindingObservation; document: ManagedDocument
  currentSource(): NonNullable<ContextCapture['source']>; assertHostCurrent(): void
}
export interface ResultObservationScope {
  run<T>(capture: ResultObservationCapture, use: () => Promise<T>): Promise<T>
  current(sessionId: string): ResultSourceObservation | undefined
}
/** Derived held data only. An escaped ALS context remains revoked, never fallback. */
export function createResultObservationScope(): ResultObservationScope {
  type Scope = { active: boolean; ids: Set<string>; primary: ResultSourceObservation }
  const contexts = new AsyncLocalStorage<Scope[]>()
  return {
    async run(capture, use) {
      capture.observation.assertCurrent(); capture.assertHostCurrent(); capture.document.assertReady()
      if (!capture.sessionIds.includes(capture.sessionId)) throw new Error('Result observation actor is not held')
      for (const id of capture.sessionIds) capture.observation.metadata(id)
      const view = capture.document.view, events = view.events, count = events.length
      const metadata = capture.observation.metadata(capture.sessionId)
      if (metadata.sessionId !== capture.sessionId || metadata.archived) throw new Error('Result observation session unavailable')
      let active = true
      const assertCurrent = () => {
        if (!active) throw new Error('Result observation expired')
        capture.observation.assertCurrent(); capture.assertHostCurrent(); capture.document.assertReady()
        if (capture.document.view !== view || view.events !== events || events.length !== count) throw new Error('Result observation view changed')
        if (capture.observation.metadata(capture.sessionId) !== metadata || metadata.archived) throw new Error('Result observation metadata changed')
      }
      const primary: ResultSourceObservation = { sessionId: capture.sessionId, metadata, view,
        get source() { assertCurrent(); const value = capture.currentSource(); assertCurrent(); return value }, assertCurrent }
      const scope: Scope = { active: true, ids: new Set(capture.sessionIds), primary }
      try { return await contexts.run([...(contexts.getStore() ?? []), scope], async () => { assertCurrent(); const value = await use(); assertCurrent(); return value }) }
      finally { active = false; scope.active = false }
    },
    current(sessionId) {
      const current = contexts.getStore()?.findLast(scope => scope.ids.has(sessionId))
      if (!current) return undefined
      if (!current.active) throw new Error('Result observation expired')
      current.primary.assertCurrent()
      if (current.primary.sessionId !== sessionId) throw new Error('Observed result actor has no held ready view')
      return current.primary
    },
  }
}

export async function discoverResultLineage(coordinator: Pick<SessionCoordinator, 'profile'>, sessionId: string, assertCurrent: () => void = () => {}): Promise<string[]> {
  const ids: string[] = []
  let cursor = sessionId
  for (;;) {
    assertCurrent()
    if (ids.includes(cursor) || ids.length >= 64) throw new Error('Result source lineage unavailable')
    ids.push(cursor)
    const { meta } = await coordinator.profile(cursor)
    assertCurrent()
    if (meta.archived) throw new Error('Result source archived')
    // Fork READY sidecars are owned by that target, independent of ancestors.
    if (!meta.parentSession || !['subagent','team'].includes(meta.origin ?? '')) return ids
    cursor = meta.parentSession
  }
}
export function assertResultLineage(observation: ExistingSessionBindingObservation | SessionBindingObservation, ids: readonly string[], sessionId: string): void {
  observation.assertCurrent()
  let cursor = sessionId
  for (const [index, id] of ids.entries()) {
    if (cursor !== id) throw new Error('Result source lineage changed')
    const meta = observation.metadata(id)
    if (meta.sessionId !== id || meta.archived) throw new Error('Result source session unavailable')
    const parent = meta.parentSession && ['subagent','team'].includes(meta.origin ?? '') ? meta.parentSession : undefined
    if (index === ids.length - 1) { if (parent) throw new Error('Result source lineage expanded') }
    else { if (!parent) throw new Error('Result source lineage changed'); cursor = parent }
  }
  observation.assertCurrent()
}
const commitmentKey = (c: LegacyCommitment) => JSON.stringify([c.refId, c.revision, c.metadataDigest, c.metadataEncodedBytes, c.expiresAt])
/** Predicates are synchronous inside L1; failures survive caught-denial paths. */
export function legacyObservationFor(source: ResultSourceObservation): LegacyReadObservation {
  source.assertCurrent()
  const visibility = createLegacyReadVisibility(source.view)
  if (visibility.kind !== 'visible') throw new Error('Legacy visibility ' + visibility.reason)
  const local = new Set([...visibility.local()].map(value => commitmentKey(captureLegacyRefCommitment(value.ref))))
  let failed = false, failure: unknown
  const assertCurrent = () => { if (failed) throw failure; source.assertCurrent() }
  const predicate = <T>(read: () => T): T => { try { assertCurrent(); const value = read(); assertCurrent(); return value } catch (cause) { failed = true; failure = cause; throw cause } }
  const seed = source.metadata.semanticSeed, header = source.view.header
  if (canonicalJsonData(seed ?? null) !== canonicalJsonData(header?.semanticSeed ?? null)
    || source.metadata.seedLength !== header?.seedLength) throw new Error('Legacy READY header changed')
  const bootstrap = seed ? { invocation: { version: 1 as const, operationId: seed.operationId, targetSessionId: source.sessionId, createdAt: source.metadata.createdAt, requestDigest: seed.requestDigest }, manifestDigest: seed.manifestDigest, seedDigest: seed.seedDigest } : undefined
  return { sessionId: source.sessionId, sourceId: source.source.sourceId, ...(bootstrap ? { bootstrap } : {}), assertCurrent,
    localVisible: c => predicate(() => local.has(commitmentKey(c))), anchorVisible: (anchor, extent) => predicate(() => visibility.anchorVisible(anchor, extent)) }
}
export function createLegacyReadObservationRunner(options: {
  coordinator: Pick<SessionCoordinator, 'profile'|'openManagedDocument'|'withExistingSessionBindingObservation'>; observations: ResultObservationScope
  resolveSource(sessionId: string): Promise<(observation: ExistingSessionBindingObservation, ids: readonly string[]) => NonNullable<ContextCapture['source']>>
  assertHostCurrent(): void
  withBindingObservation?<T>(ids: readonly string[], observation: ExistingSessionBindingObservation, use: () => Promise<T>): Promise<T>
}): LegacyReadObservationRunner {
  return async (access, use) => {
    options.assertHostCurrent()
    if (access.signal?.aborted || !options.coordinator.withExistingSessionBindingObservation) throw new Error('Legacy read observation unavailable')
    const document = await options.coordinator.openManagedDocument(access.sessionId)
    document.assertReady(); options.assertHostCurrent()
    const ids = await discoverResultLineage(options.coordinator, access.sessionId, () => { options.assertHostCurrent(); if (access.signal?.aborted) throw new Error('Legacy read cancelled') })
    const currentSource = await options.resolveSource(access.sessionId)
    options.assertHostCurrent()
    return options.coordinator.withExistingSessionBindingObservation({ sessionIds: ids, ...(access.signal ? { signal: access.signal } : {}) }, async observation => {
      const assertHostCurrent = () => { options.assertHostCurrent(); if (access.signal?.aborted) throw new Error('Legacy read cancelled'); assertResultLineage(observation, ids, access.sessionId) }
      const run = () => options.observations.run({ sessionId: access.sessionId, sessionIds: ids, observation, document, currentSource: () => currentSource(observation, ids), assertHostCurrent }, async () => {
        const read = legacyObservationFor(options.observations.current(access.sessionId)!)
        read.assertCurrent(); const value = await use(read); read.assertCurrent(); return value
      })
      return options.withBindingObservation ? options.withBindingObservation(ids, observation, run) : run()
    })
  }
}
