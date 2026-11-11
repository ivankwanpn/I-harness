import { createReadOnlySessionCoordinator, type ReadOnlySessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { SettingsStore, resolveSettingsPath } from '@i-harness/settings'
import { stat } from 'node:fs/promises'
import { deriveSessionTitle } from '@i-harness/core-session'
import type { SessionDashboardResult } from '@i-harness/sdk'
import { isConversationMetadata } from './session-visibility.ts'
import { navigationDocumentKey, projectBindingDocumentKey, parseSessionNavigation, parseSessionProjectBinding, type SessionNavigation } from './session-navigation.ts'

type CatalogRead = Omit<ReadOnlySessionCoordinator, 'access'>

/** Committed storage observations only. This never constructs an execution host. */
export function createCommittedSessionCatalog() {
  let closing = false
  let closeFlight: Promise<void> | undefined
  const reads = new Set<Promise<unknown>>()
  const owners = new Set<CatalogRead>()
  function read<T>(root: string, empty: T, work: (coordinator: CatalogRead) => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(Error('Session catalog is closed'))
    const job = (async () => {
      const settings = new SettingsStore({ path: resolveSettingsPath() })
      await settings.loadObserved()
      const directory = await stat(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!directory) return empty
      if (!directory.isDirectory()) throw Error('Session storage is not a directory')
      const store = settings.get().sessionStore ?? (process.env.IH_SESSION_STORE === 'commit-log' ? 'commit-log' : 'jsonl')
      const coordinator = store === 'commit-log'
        ? createJsonlCommitCoordinator(root)
        : createReadOnlySessionCoordinator(createJsonlBackend(root))
      owners.add(coordinator)
      try { return await work(coordinator) } finally { await coordinator.close(); owners.delete(coordinator) }
    })()
    reads.add(job)
    void job.finally(() => reads.delete(job)).catch(() => undefined)
    return job
  }
  return {
    navigation(root: string): Promise<Record<string, SessionNavigation>> {
      return read(root, {}, async coordinator => {
        const entries: [string, SessionNavigation][] = []
        for (const id of await coordinator.list()) {
          const { meta } = await coordinator.profile(id)
          if (!isConversationMetadata(meta)) continue
          const navigation = parseSessionNavigation(await coordinator.getDocument(navigationDocumentKey(id)))
          const binding = parseSessionProjectBinding(await coordinator.getDocument(projectBindingDocumentKey(id)))
          entries.push([id, { ...navigation, ...(binding.projectId ? { projectId: binding.projectId } : {}) }])
        }
        return Object.fromEntries(entries)
      })
    },
    dashboard(root: string): Promise<SessionDashboardResult> {
      return read<SessionDashboardResult>(root, { sessions: [] }, async coordinator => {
        const sessions: SessionDashboardResult['sessions'] = []
        for (const id of await coordinator.list()) {
          const profile = await coordinator.profile(id)
          if (profile.meta.archived || !isConversationMetadata(profile.meta)) continue
          const { session } = await coordinator.snapshot(id)
          const committed = deriveSessionTitle(session)
          const title = committed?.source === 'user' || profile.meta.title === undefined ? committed?.title : profile.meta.title
          sessions.push({ id, live: false, ...(title === undefined ? {} : { title }), updatedAt: profile.updatedAt,
            turnCount: session.events.filter(event => event.type === 'turn/end').length })
        }
        return { sessions }
      })
    },
    close() {
      closing = true
      return closeFlight ??= Promise.resolve().then(async () => {
        await Promise.allSettled([...reads])
        const results = await Promise.allSettled([...owners].map(async owner => { await owner.close(); owners.delete(owner) }))
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Session catalog read cleanup incomplete')
      }).catch(error => { closeFlight = undefined; throw error })
    },
  }
}
