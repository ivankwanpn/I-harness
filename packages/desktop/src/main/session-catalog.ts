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
  async function root(workspace: WorkspaceEntry) {
    if (!/^[A-Za-z0-9_-]+$/.test(workspace.id)) throw Error('Invalid workspace identity')
    const canonical = await realpath(workspace.path)
    const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (key(canonical) !== key(workspace.path) || !(await stat(canonical)).isDirectory()) throw Error('Workspace path changed')
    return join(sessionsRoot, workspace.id)
  }
  function query<T>(workspace: WorkspaceEntry, method: 'navigation' | 'navigationSnapshot' | 'dashboard'): Promise<T> {
    if (closing) return Promise.reject(Error('Session catalog is closed'))
    const job = root(workspace).then(root => {
      reader ??= startCatalogReader(entry, () => { reader = undefined })
      return reader.request<T>({ method, root })
    })
    pending.add(job)
    void job.finally(() => pending.delete(job)).catch(() => undefined)
    return job
  }
  return {
    navigation: (workspace: WorkspaceEntry) => query<Record<string, SessionNavigation>>(workspace, 'navigation'),
    navigationSnapshot: (workspace: WorkspaceEntry) => query<{ entries: Record<string, SessionNavigation>; partial: boolean }>(workspace, 'navigationSnapshot'),
    dashboard: (workspace: WorkspaceEntry) => query<SessionDashboardResult>(workspace, 'dashboard'),
    close() {
      closing = true
      return closeFlight ??= (async () => {
        await Promise.allSettled([...pending])
        const current = reader
        if (current) { await current.request<void>({ method: 'close' }); await current.exited }
      })().catch(error => { closeFlight = undefined; throw error })
    },
  }
}
