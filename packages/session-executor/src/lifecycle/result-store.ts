import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { contextPathKey, contextWorkspaceLocation, contextSourceIdentity, loadContextOutputConfiguration, type ContextCapture, type ContextOutputService, type LegacyReadObservationRunner } from '@i-harness/context-output'
import { managedResultRefs, semanticSeedResultRefs, sameManagedArtifactRef, rewindCuts } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createResultObservationScope, createLegacyReadObservationRunner, type ResultObservationScope } from './result-observation.ts'
import { createProcessAwareResultService, lookupProcessResultService } from './process-result-service.ts'
import { lookupProcessReadContext } from '@i-harness/session-persistence/internal/process-read-context'

export interface ResultReadScope { projectId?: string; scope?: { id: string; roots: string[] }; revision: string }
export type ResultReadScopeResolver = (sessionId: string) => Promise<(() => ResultReadScope) | undefined>
interface Registration {
  sessionId: string; coordinator: SessionCoordinator
  projectContext?(): { id: string; roots: string[] } | undefined
  available?(): boolean
  readScope?: () => ResultReadScope
  mode: 'producer' | 'reader'
  lastScopeId?: string
}
interface StoreEntry {
  service: ContextOutputService; registrations: Set<Registration>; users: number
  retirement?: { complete: boolean; flight?: Promise<void>; failure?: unknown }
  sourceFor(sessionId: string): Promise<ContextCapture['source']>; observeDeletion(coordinator: SessionCoordinator): void; stopObserving(): void
  observations: ResultObservationScope
  bridge: ReturnType<typeof createProcessAwareResultService>
}
const stores = new Map<string, Promise<StoreEntry>>()
// Installed only by the genuine reader lease, for this page's full authorization.
const pageRegistrations = new AsyncLocalStorage<Registration>()

export interface ResultStoreOptions {
  workspace: string; coordinator?: SessionCoordinator; sessionId?: string
  contextOutput?: ContextOutputService; contextOutputSourceFor?(sessionId: string): Promise<ContextCapture['source']>
  contextOutputLegacyReadObservation?: LegacyReadObservationRunner
  contextOutputSettingsPath?: string
  resultReadScopeFor?: ResultReadScopeResolver
  projectContext?: Registration['projectContext']; executionCallerAvailable?: Registration['available']
}
export function acquireAssemblyResultStore(options: ResultStoreOptions) { return acquireResultStore(options, 'producer') }
export function acquireResultReadStore(options: ResultStoreOptions & { readCallerAvailable(): boolean }, readScope?: () => ResultReadScope) {
  return acquireResultStore({ ...options, projectContext: undefined, executionCallerAvailable: options.readCallerAvailable }, 'reader', readScope)
}
async function acquireResultStore(options: ResultStoreOptions, mode: Registration['mode'], readScope?: () => ResultReadScope) {
  if (options.contextOutput) return { service: options.contextOutput, sourceFor: options.contextOutputSourceFor, withLegacyReadObservation: options.contextOutputLegacyReadObservation, observations: undefined, release: async () => {},
    async withProcessReadContext<T>(run: () => Promise<T>) {
      const coordinator = options.coordinator, id = options.sessionId!
      const context = lookupProcessReadContext(coordinator!, id)
      if (!context) return run()
      const bridge = lookupProcessResultService(options.contextOutput!)
      if (!bridge || !coordinator) { try { lookupProcessReadContext(undefined!, id) } catch {} throw new Error('PROCESS_READ_UNAVAILABLE') }
      return bridge.withPage(coordinator, id, () => options.executionCallerAvailable?.() !== false, run)
    } }
  if (!options.coordinator?.storageRoot || !options.sessionId) return { service: undefined, sourceFor: undefined, withLegacyReadObservation: undefined, observations: undefined, release: async () => {} }
  const location = await contextWorkspaceLocation(options.workspace, options.coordinator.storageRoot)
  const key = JSON.stringify([contextPathKey(location.serviceRoot), location.workspaceKey])
  for (;;) {
  let pending = stores.get(key)
  let config: Awaited<ReturnType<typeof loadContextOutputConfiguration>> | undefined
  if (mode === 'producer' || !pending) {
    try { config = await loadContextOutputConfiguration(location.workspaceKey, options.contextOutputSettingsPath) }
    catch { return { service: undefined, sourceFor: undefined, withLegacyReadObservation: undefined, observations: undefined, release: async () => {} } }
    pending = stores.get(key)
  }
  if (!pending) {
    pending = Promise.resolve().then(() => {
      const registrations = new Set<Registration>()
      const observations = createResultObservationScope()
      const deletionListeners = new Set<(documents: readonly string[]) => Promise<void>>(), deletionSources = new Map<SessionCoordinator, () => void>()
      async function sourceFor(sessionId: string): Promise<NonNullable<ContextCapture['source']>> {
        const page = pageRegistrations.getStore()
        const assertPage = () => {
          if (!page) return
          if (!registrations.has(page) || page.mode !== 'reader' || page.sessionId !== sessionId || page.available?.() === false) throw new Error('Result page registration unavailable')
          lookupProcessReadContext(page.coordinator, sessionId)!.assertCurrent()
        }
        assertPage()
        const observed = observations.current(sessionId)
        if (observed) {
          observed.assertCurrent(); return observed.source
        }
        const candidates = [...registrations]
        const coordinator = page?.coordinator ?? candidates.at(-1)?.coordinator
        if (!coordinator) throw new Error('Result source owner unavailable')
        const independent = page ? (page.readScope ? page : undefined) : candidates.findLast(owner => owner.sessionId === sessionId && owner.mode === 'reader' && owner.readScope)
        if (independent) {
          if (independent.available?.() === false) throw new Error('Result source host unavailable')
          const before = independent.readScope!()
          const { meta } = await independent.coordinator.profile(sessionId)
          assertPage()
          const current = independent.readScope!()
          if (meta.archived || independent.available?.() === false || before.revision !== current.revision
            || current.projectId && current.scope?.id !== current.projectId) throw new Error('Result read scope unavailable')
          return { sourceId: contextSourceIdentity(location.workspaceKey, location.canonical, current.scope), readonly: true }
        }
        let cursor = sessionId, selected: Registration | undefined, reader: Registration | undefined, projectId: string | undefined, bindingSeen = false
        const visited = new Set<string>()
        for (;;) {
          if (visited.has(cursor) || visited.size >= 64) throw new Error('Result source lineage unavailable')
          visited.add(cursor)
          const { meta } = await coordinator.profile(cursor)
          assertPage()
          if (meta.archived) throw new Error('Result source session archived')
          selected ??= candidates.findLast(owner => owner.sessionId === cursor && owner.mode === 'producer')
          reader ??= candidates.findLast(owner => owner.sessionId === cursor && owner.mode === 'reader')
          if (!bindingSeen) {
            const binding = await coordinator.getDocument('desktop-session-project-' + createHash('sha256').update(cursor).digest('hex'))
            assertPage()
            if (binding !== undefined) {
              if (!binding || typeof binding !== 'object' || Array.isArray(binding) || (binding as { version?: unknown }).version !== 1 || Object.keys(binding).some(field => !['version', 'projectId'].includes(field))) throw new Error('Result project binding unavailable')
              const value = (binding as { projectId?: unknown }).projectId
              if (value !== undefined && typeof value !== 'string') throw new Error('Result project binding unavailable')
              projectId = value; bindingSeen = true
            }
          }
          if (!meta.parentSession || !['subagent', 'team'].includes(meta.origin ?? '')) break
          cursor = meta.parentSession
        }
        selected ??= reader
        if (page && selected?.coordinator !== page.coordinator) throw new Error('Result source coordinator differs from page owner')
        if (!selected || selected.available?.() === false) throw new Error('Result source host unavailable')
        const scope = selected.projectContext?.()
        if (projectId && scope?.id !== projectId || !scope && selected.lastScopeId) throw new Error('Result project scope unconfirmed')
        if (scope) selected.lastScopeId = scope.id
        assertPage()
        return { sourceId: contextSourceIdentity(location.workspaceKey, location.canonical, scope), readonly: true }
      }
      const bridge = createProcessAwareResultService({ root: location.serviceRoot, workspaceId: location.workspaceKey, config, requireObservedLegacyRecipients: true,
        coordinatorFor: () => [...registrations].at(-1)?.coordinator, orderingCoordinators: [], sourceFor,
        documentDeletions: listener => { deletionListeners.add(listener); return () => { deletionListeners.delete(listener) } },
        genericVisible: async (sessionId, expected) => {
            const observed = observations.current(sessionId)
            const coordinator = [...registrations].at(-1)?.coordinator
            if (!coordinator?.snapshot) return false
            const snapshot = observed?.view ?? (await coordinator.snapshot(sessionId)).session, cuts = rewindCuts(snapshot)
            observed?.assertCurrent()
            return semanticSeedResultRefs(snapshot).some(ref => sameManagedArtifactRef(ref, expected)) || snapshot.events.some(event => !cuts.some(cut => event.seq !== undefined && event.seq >= cut.cutFrom && event.seq < cut.markerSeq)
              && managedResultRefs(event).some(ref => sameManagedArtifactRef(ref, expected)))
        },
        authorize: async (access, ref) => {
          if (!ref.source) return access.sessionId === ref.sessionId
          const source = await sourceFor(access.sessionId)
          observations.current(access.sessionId)?.assertCurrent()
          return ref.workspaceId === location.workspaceKey && source.sourceId === ref.source.sourceId
        } })
      const service = bridge.service
      const entry: StoreEntry = { service, bridge, registrations, users: 0, sourceFor, observations,
        observeDeletion(coordinator) {
          if (deletionSources.has(coordinator) || !coordinator.onDocumentDeleted) return
          deletionSources.set(coordinator, coordinator.onDocumentDeleted(async (id, manifest) => { for (const listener of deletionListeners) await listener([id, ...manifest.documents]) }))
        },
        stopObserving() { for (const unsubscribe of deletionSources.values()) unsubscribe(); deletionSources.clear() },
      }
      return entry
    })
    stores.set(key, pending)
    void pending.catch(() => { if (stores.get(key) === pending) stores.delete(key) })
  }
  const entry = await pending
  // A last owner can retire the instance while creation is awaited.
  if (stores.get(key) !== pending) continue
  if (entry.retirement) {
    // Admission may join work already owned by the retiring lease. It must not
    // retry failed idle cleanup or register against that permanently fenced owner.
    if (!entry.retirement.flight) throw new Error('Result store retirement cleanup requires original owner retry', { cause: entry.retirement.failure })
    await entry.retirement.flight
    continue
  }
  const registration: Registration = { mode, sessionId: options.sessionId, coordinator: options.coordinator,
    ...(mode === 'producer' ? { projectContext: options.projectContext } : { readScope }), available: options.executionCallerAvailable }
  entry.bridge.registerCoordinator(options.coordinator)
  entry.registrations.add(registration); entry.users++
  // Read the existing owner's current source resolver, which consults all
  // actual registrations rather than capturing the first assembly's scope.
  const sourceFor = entry.sourceFor
  let released = false
  let ownsRetirement = false
  async function release() {
    if (!released) {
      released = true; entry.registrations.delete(registration); entry.users--
      if (!entry.users && stores.get(key) === pending) { entry.retirement = { complete: false }; ownsRetirement = true }
    }
    if (!ownsRetirement) return
    const retirement = entry.retirement!
    if (retirement.complete) return
    if (!retirement.flight) retirement.flight = Promise.resolve().then(async () => {
      entry.bridge.retireBridge(); await entry.service.close()
      entry.stopObserving()
      retirement.complete = true
      if (stores.get(key) === pending) stores.delete(key)
    }).catch(cause => { retirement.failure = cause; throw cause }).finally(() => { retirement.flight = undefined })
    await retirement.flight
  }
  try {
    // Reserve before configure or any other subsequent await. Readers never
    // configure an active writer or initialize the optional legacy index.
    entry.observeDeletion(options.coordinator)
    if (mode === 'producer' && JSON.stringify(entry.service.status().config) !== JSON.stringify(config)) await entry.service.configure(config!)
    const withLegacyReadObservation = createLegacyReadObservationRunner({ coordinator: options.coordinator, observations: entry.observations,
      assertHostCurrent() { if (released || entry.retirement || registration.available?.() === false) throw new Error('Legacy result host unavailable') },
      async resolveSource(sessionId) {
        const getter = readScope ?? await options.resultReadScopeFor?.(sessionId), initial = getter?.()
        return (observed, ids) => {
          observed.assertCurrent()
          const candidates = [...entry.registrations]
          const direct = candidates.findLast(owner => owner.sessionId === sessionId && owner.mode === 'reader' && owner.readScope)
          const scopeGetter = getter ?? direct?.readScope
          const current = scopeGetter?.()
          if (initial && current?.revision !== initial.revision) throw new Error('Legacy result read scope changed')
          let projectId: string | undefined, bindingSeen = false, selected: Registration | undefined, reader: Registration | undefined
          for (const id of ids) {
            const meta = observed.metadata(id)
            if (meta.archived) throw new Error('Legacy result source archived')
            selected ??= candidates.findLast(owner => owner.sessionId === id && owner.mode === 'producer')
            reader ??= candidates.findLast(owner => owner.sessionId === id && owner.mode === 'reader')
            if (bindingSeen) continue
            const binding = observed.binding(id)
            if (binding.kind === 'absent') continue
            const value = binding.value
            if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1 || Object.keys(value).some(key => !['version','projectId'].includes(key))) throw new Error('Legacy result binding unavailable')
            const parsed = (value as { projectId?: unknown }).projectId
            if (parsed !== undefined && typeof parsed !== 'string') throw new Error('Legacy result binding unavailable')
            projectId = parsed; bindingSeen = true
          }
          selected ??= reader
          if (!selected || selected.available?.() === false) throw new Error('Legacy result owner unavailable')
          const scope = current?.scope ?? selected.projectContext?.()
          if (projectId && scope?.id !== projectId || current?.projectId && current.scope?.id !== current.projectId || !scope && selected.lastScopeId) throw new Error('Legacy result project scope unavailable')
          if (scope) selected.lastScopeId = scope.id
          observed.assertCurrent()
          return { sourceId: contextSourceIdentity(location.workspaceKey, location.canonical, scope), readonly: true }
        }
      },
    })
    return { service: entry.service, sourceFor, withLegacyReadObservation, observations: entry.observations, release,
      async withProcessReadContext<T>(run: () => Promise<T>) {
        const available = () => !released && !entry.retirement && entry.registrations.has(registration) && registration.mode === 'reader' && registration.available?.() !== false
        const process = lookupProcessReadContext(registration.coordinator, registration.sessionId)
        return entry.bridge.withPage(registration.coordinator, registration.sessionId, available,
          () => process ? pageRegistrations.run(registration, run) : run())
      } }
  } catch (cause) {
    try { await release() }
    catch (cleanupCause) {
      // Internal recovery authority stays with this exact lease and service.
      throw Object.assign(new AggregateError([cause, cleanupCause], 'Result store configuration and cleanup failed', { cause }), { retryCleanup: release })
    }
    throw cause
  }
  }
}
