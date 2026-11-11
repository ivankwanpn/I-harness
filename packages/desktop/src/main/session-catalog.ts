import { realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createCommittedSessionCatalog } from '@i-harness/desktop-gateway'
import type { WorkspaceEntry } from './workspaces.ts'

export function createDesktopSessionCatalog(sessionsRoot: string) {
  const catalog = createCommittedSessionCatalog()
  let closing = false
  const pending = new Set<Promise<unknown>>()
  async function root(workspace: WorkspaceEntry) {
    if (!/^[A-Za-z0-9_-]+$/.test(workspace.id)) throw Error('Invalid workspace identity')
    const canonical = await realpath(workspace.path)
    const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (key(canonical) !== key(workspace.path) || !(await stat(canonical)).isDirectory()) throw Error('Workspace path changed')
    return join(sessionsRoot, workspace.id)
  }
  function query<T>(workspace: WorkspaceEntry, read: (root: string) => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(Error('Session catalog is closed'))
    const job = root(workspace).then(read)
    pending.add(job)
    void job.finally(() => pending.delete(job)).catch(() => undefined)
    return job
  }
  return {
    navigation: (workspace: WorkspaceEntry) => query(workspace, root => catalog.navigation(root)),
    dashboard: (workspace: WorkspaceEntry) => query(workspace, root => catalog.dashboard(root)),
    async close() { closing = true; await Promise.allSettled([...pending]); await catalog.close() },
  }
}
