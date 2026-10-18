import { createHash } from 'node:crypto'
import { contextPathKey, contextWorkspaceLocation, contextSourceIdentity, createContextOutputService, loadContextOutputConfiguration, type ContextCapture, type ContextOutputService } from '@i-harness/context-output'
import { managedResultRefs, rewindCuts } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'

interface Registration {
  sessionId: string; coordinator: SessionCoordinator
  projectContext?(): { id: string; roots: string[] } | undefined
  available?(): boolean
  lastScopeId?: string
}
interface StoreEntry { service: ContextOutputService; registrations: Set<Registration>; users: number; sourceFor(sessionId: string): Promise<ContextCapture['source']>; observeDeletion(coordinator: SessionCoordinator): void; stopObserving(): void }
const stores = new Map<string, Promise<StoreEntry>>()

interface ResultStoreOptions {
  workspace: string; coordinator?: SessionCoordinator; sessionId?: string
  contextOutput?: ContextOutputService; contextOutputSourceFor?(sessionId: string): Promise<ContextCapture['source']>
  contextOutputSettingsPath?: string
  projectContext?: Registration['projectContext']; executionCallerAvailable?: Registration['available']
}
export async function acquireAssemblyResultStore(options: ResultStoreOptions) {
  if (options.contextOutput) return { service: options.contextOutput, sourceFor: options.contextOutputSourceFor, release: async () => {} }
  if (!options.coordinator?.storageRoot || !options.sessionId) return { service: undefined, sourceFor: undefined, release: async () => {} }
  const location = await contextWorkspaceLocation(options.workspace, options.coordinator.storageRoot)
  let config
  try { config = await loadContextOutputConfiguration(location.workspaceKey, options.contextOutputSettingsPath) }
  catch { return { service: undefined, sourceFor: undefined, release: async () => {} } }
  const key = JSON.stringify([contextPathKey(location.serviceRoot), location.workspaceKey])
  let pending = stores.get(key)
  if (!pending) {
    pending = Promise.resolve().then(() => {
      const registrations = new Set<Registration>()
      const deletionListeners = new Set<(documents: readonly string[]) => Promise<void>>(), deletionSources = new Map<SessionCoordinator, () => void>()
      async function sourceFor(sessionId: string): Promise<NonNullable<ContextCapture['source']>> {
        const candidates = [...registrations]
        const coordinator = candidates.at(-1)?.coordinator
        if (!coordinator) throw new Error('Result source owner unavailable')
        let cursor = sessionId, selected: Registration | undefined, projectId: string | undefined, bindingSeen = false
        const visited = new Set<string>()
        for (;;) {
          if (visited.has(cursor) || visited.size >= 64) throw new Error('Result source lineage unavailable')
          visited.add(cursor)
          const { meta } = await coordinator.profile(cursor)
          if (meta.archived) throw new Error('Result source session archived')
          selected ??= candidates.findLast(owner => owner.sessionId === cursor)
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
            if (access.sessionId === metadata.owner.sessionId) return true
            const coordinator = [...registrations].at(-1)?.coordinator
            if (!coordinator?.snapshot) return false
            const snapshot = (await coordinator.snapshot(access.sessionId)).session, cuts = rewindCuts(snapshot)
            return snapshot.events.some(event => !cuts.some(cut => event.seq !== undefined && event.seq >= cut.cutFrom && event.seq < cut.markerSeq)
              && managedResultRefs(event).some(ref => ref.id === metadata.ref.id && ref.revision === metadata.ref.revision))
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
  entry.observeDeletion(options.coordinator)
  if (JSON.stringify(entry.service.status().config) !== JSON.stringify(config)) await entry.service.configure(config)
  const registration: Registration = { sessionId: options.sessionId, coordinator: options.coordinator, projectContext: options.projectContext, available: options.executionCallerAvailable }
  entry.registrations.add(registration); entry.users++
  // Read the existing owner's current source resolver, which consults all
  // actual registrations rather than capturing the first assembly's scope.
  const sourceFor = entry.sourceFor
  let released = false
  return { service: entry.service, sourceFor, async release() {
    if (released) return
    released = true; entry.registrations.delete(registration); entry.users--
    if (!entry.users && stores.get(key) === pending) { stores.delete(key); entry.stopObserving(); await entry.service.close() }
  } }
}
