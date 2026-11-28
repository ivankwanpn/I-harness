import { readCatalogRows, readListedSessions } from "./catalog-rows.ts"
import { createReadOnlySessionCoordinator, type ReadOnlySessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { SettingsStore, resolveSettingsPath } from '@i-harness/settings'
import { stat } from 'node:fs/promises'
import type { SessionDashboardResult } from '@i-harness/sdk'
import { createJsonlDashboardSummaryCache, describeSavedSession, loadCatalogSession } from './session-dashboard-summary.ts'
import { isConversationMetadata } from './session-visibility.ts'
import { navigationDocumentKey, projectBindingDocumentKey, parseSessionNavigation, parseSessionProjectBinding, type SessionNavigation } from './session-navigation.ts'

type CatalogRead = Omit<ReadOnlySessionCoordinator, 'access'>

/** Committed storage observations only. This never constructs an execution host. */
export function createCommittedSessionCatalog() {
  let closing = false
  let closeFlight: Promise<void> | undefined
  const reads = new Set<Promise<unknown>>()
  const owners = new Set<CatalogRead>()
  const savedSummary = createJsonlDashboardSummaryCache()
  function read<T>(root: string, empty: T, work: (coordinator: CatalogRead, store: 'commit-log' | 'jsonl') => Promise<T>): Promise<T> {
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
        : createReadOnlySessionCoordinator(createJsonlBackend(root, { fixedCapabilities: true }))
      owners.add(coordinator)
      try { return await work(coordinator, store) } finally { await coordinator.close(); owners.delete(coordinator) }
    })()
    reads.add(job)
    void job.finally(() => reads.delete(job)).catch(() => undefined)
    return job
  }
  async function navigationSnapshot(root: string, onlyId?: string) {
    return read(root, { entries: {} as Record<string, SessionNavigation>, partial: false }, async coordinator => {
      const { rows, partial } = await readCatalogRows(coordinator, () => async id => {
        const { meta } = await coordinator.profile(id)
        if (!isConversationMetadata(meta)) return undefined
        const navigation = parseSessionNavigation(await coordinator.getDocument(navigationDocumentKey(id)))
        const binding = parseSessionProjectBinding(await coordinator.getDocument(projectBindingDocumentKey(id)))
        return [id, { ...navigation, ...(binding.projectId ? { projectId: binding.projectId } : {}), ...(onlyId === undefined ? {} : { archived: meta.archived === true }) }] as const
      }, true, onlyId)
      return { entries: Object.fromEntries(rows), partial }
    })
  }
  return {
    navigationSnapshot,
    async navigation(root: string, onlyId?: string): Promise<Record<string, SessionNavigation>> {
      return (await navigationSnapshot(root, onlyId)).entries
    },
    dashboard(root: string): Promise<SessionDashboardResult> {
      return read<SessionDashboardResult>(root, { sessions: [] }, async (coordinator, store) => {
        const listed = await readListedSessions(coordinator, ids => {
          const saved = savedSummary.forListing(root, ids)
          return async (id, header) => {
            const load = () => loadCatalogSession(coordinator, id, header)
            return store === 'jsonl' ? saved(id, header, load) : describeSavedSession(await load(), header.title)
          }
        }, true)
        return { ...listed, sessions: listed.sessions.map(row => ({ ...row, live: false })) }
      })
    },
    close() {
      closing = true
      return closeFlight ??= Promise.resolve().then(async () => {
        await Promise.allSettled([...reads])
        savedSummary.clear()
        const results = await Promise.allSettled([...owners].map(async owner => { await owner.close(); owners.delete(owner) }))
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Session catalog read cleanup incomplete')
      }).catch(error => { closeFlight = undefined; throw error })
    },
  }
}
