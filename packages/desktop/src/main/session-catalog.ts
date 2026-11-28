import { realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionDashboardResult } from '@i-harness/sdk'
import type { SessionNavigation } from '@i-harness/desktop-gateway'
import { startCatalogReader } from './session-catalog-client.ts'
import type { WorkspaceEntry } from './workspaces.ts'

export function createDesktopSessionCatalog(sessionsRoot: string, entry: string | URL = join(dirname(fileURLToPath(import.meta.url)), 'session-catalog-worker.js')) {
  let reader: ReturnType<typeof startCatalogReader> | undefined
  let closing = false
  let closeFlight: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const closingPreviews = new AbortController()
  async function root(workspace: WorkspaceEntry, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]+$/.test(workspace.id)) throw Error('Invalid workspace identity')
    const canonical = await realpath(workspace.path)
    signal?.throwIfAborted()
    const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (key(canonical) !== key(workspace.path) || !(await stat(canonical)).isDirectory()) throw Error('Workspace path changed')
    return join(sessionsRoot, workspace.id)
  }
  function query<T>(workspace: WorkspaceEntry, method: 'navigation' | 'navigationSnapshot' | 'dashboard', sessionId?: string, signal?: AbortSignal): Promise<T> {
    if (closing) return Promise.reject(Error('Session catalog is closed'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const location = root(workspace, signal)
    let checked = location
    if (signal) {
      const cancelled = Promise.withResolvers<never>()
      const abort = () => cancelled.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      checked = Promise.race([location, cancelled.promise]).finally(() => signal.removeEventListener('abort', abort))
    }
    const job = checked.then(root => {
      signal?.throwIfAborted()
      reader ??= startCatalogReader(entry, () => { reader = undefined })
      return reader.request<T>({ method, root, ...(sessionId === undefined ? {} : { sessionId }) }, signal)
    })
    pending.add(job)
    void job.finally(() => pending.delete(job)).catch(() => undefined)
    return job
  }
  return {
    navigation: (workspace: WorkspaceEntry, sessionId?: string) => query<Record<string, SessionNavigation>>(workspace, 'navigation', sessionId),
    navigationSnapshot: (workspace: WorkspaceEntry) => query<{ entries: Record<string, SessionNavigation>; partial: boolean }>(workspace, 'navigationSnapshot'),
    dashboard: (workspace: WorkspaceEntry, preview?: AbortSignal) => query<SessionDashboardResult>(workspace, 'dashboard', undefined,
      preview && AbortSignal.any([preview, closingPreviews.signal])),
    close() {
      closing = true
      closingPreviews.abort()
      return closeFlight ??= (async () => {
        await Promise.allSettled([...pending])
        const current = reader
        if (current) {
          await current.request<void>({ method: 'close' })
          // The worker acknowledged all storage owners. Discard any abandoned
          // preflight I/O without keeping the application alive for its callback.
          await current.terminate()
          await current.exited
        }
      })().catch(error => { closeFlight = undefined; throw error })
    },
  }
}
