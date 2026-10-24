import { createHash } from 'node:crypto'
import { contextPathKey, contextWorkspaceLocation, contextSourceIdentity, createContextOutputService, loadContextOutputConfiguration, type ContextCapture, type ContextOutputService } from '@i-harness/context-output'
import { managedResultRefs, semanticSeedResultRefs, sameManagedArtifactRef, rewindCuts } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'

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
}
const stores = new Map<string, Promise<StoreEntry>>()

export interface ResultStoreOptions {
  workspace: string; coordinator?: SessionCoordinator; sessionId?: string
  contextOutput?: ContextOutputService; contextOutputSourceFor?(sessionId: string): Promise<ContextCapture['source']>
  contextOutputSettingsPath?: string
  resultReadScopeFor?: ResultReadScopeResolver
  projectContext?: Registration['projectContext']; executionCallerAvailable?: Registration['available']
}
export function acquireAssemblyResultStore(options: ResultStoreOptions) { return acquireResultStore(options, 'producer') }
export function acquireResultReadStore(options: ResultStoreOptions & { readCallerAvailable(): boolean }, readScope?: () => ResultReadScope) {
  return acquireResultStore({ ...options, projectContext: undefined, executionCallerAvailable: options.readCallerAvailable }, 'reader', readScope)
}
async function acquireResultStore(options: ResultStoreOptions, mode: Registration['mode'], readScope?: () => ResultReadScope) {
  if (options.contextOutput) return { service: options.contextOutput, sourceFor: options.contextOutputSourceFor, release: async () => {} }
  if (!options.coordinator?.storageRoot || !options.sessionId) return { service: undefined, sourceFor: undefined, release: async () => {} }
  const location = await contextWorkspaceLocation(options.workspace, options.coordinator.storageRoot)
  const key = JSON.stringify([contextPathKey(location.serviceRoot), location.workspaceKey])
  for (;;) {
  let pending = stores.get(key)
  let config: Awaited<ReturnType<typeof loadContextOutputConfiguration>> | undefined
  if (mode === 'producer' || !pending) {
    try { config = await loadContextOutputConfiguration(location.workspaceKey, options.contextOutputSettingsPath) }
    catch { return { service: undefined, sourceFor: undefined, release: async () => {} } }
    pending = stores.get(key)
  }
  if (!pending) {
    pending = Promise.resolve().then(() => {
      const registrations = new Set<Registration>()
      const deletionListeners = new Set<(documents: readonly string[]) => Promise<void>>(), deletionSources = new Map<SessionCoordinator, () => void>()
      async function sourceFor(sessionId: string): Promise<NonNullable<ContextCapture['source']>> {
        const candidates = [...registrations]
        const coordinator = candidates.at(-1)?.coordinator
        if (!coordinator) throw new Error('Result source owner unavailable')
        const independent = candidates.findLast(owner => owner.sessionId === sessionId && owner.mode === 'reader' && owner.readScope)
        if (independent) {
          if (independent.available?.() === false) throw new Error('Result source host unavailable')
          const before = independent.readScope!()
          const { meta } = await independent.coordinator.profile(sessionId)
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
          if (meta.archived) throw new Error('Result source session archived')
          selected ??= candidates.findLast(owner => owner.sessionId === cursor && owner.mode === 'producer')
          reader ??= candidates.findLast(owner => owner.sessionId === cursor && owner.mode === 'reader')
          if (!bindingSeen) {
            const binding = await coordinator.getDocument('desktop-session-project-' + createHash('sha256').update(cursor).digest('hex'))
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
        if (!selected || selected.available?.() === false) throw new Error('Result source host unavailable')
        const scope = selected.projectContext?.()
        if (projectId && scope?.id !== projectId || !scope && selected.lastScopeId) throw new Error('Result project scope unconfirmed')
        if (scope) selected.lastScopeId = scope.id
        return { sourceId: contextSourceIdentity(location.workspaceKey, location.canonical, scope), readonly: true }
      }
      const service = createContextOutputService({ root: location.serviceRoot, workspaceId: location.workspaceKey, config,
        documentDeletions: listener => { deletionListeners.add(listener); return () => { deletionListeners.delete(listener) } },
        authorizeResult: async (access, metadata) => {
          try {
            if (metadata.workspaceId !== location.workspaceKey || !metadata.owner.source || (await sourceFor(access.sessionId)).sourceId !== metadata.owner.source.sourceId) return false
            if (!metadata.visibleVia && access.sessionId === metadata.owner.sessionId) return true
            const coordinator = [...registrations].at(-1)?.coordinator
            if (!coordinator?.snapshot) return false
            const snapshot = (await coordinator.snapshot(access.sessionId)).session, cuts = rewindCuts(snapshot)
            const expected = metadata.visibleVia ?? metadata.ref
            return semanticSeedResultRefs(snapshot).some(ref => sameManagedArtifactRef(ref, expected)) || snapshot.events.some(event => !cuts.some(cut => event.seq !== undefined && event.seq >= cut.cutFrom && event.seq < cut.markerSeq)
              && managedResultRefs(event).some(ref => sameManagedArtifactRef(ref, expected)))
          } catch { return false }
        } })
      const entry: StoreEntry = { service, registrations, users: 0, sourceFor,
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
      await entry.service.close()
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
    return { service: entry.service, sourceFor, release }
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
