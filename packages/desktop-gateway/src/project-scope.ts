import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { SessionProjectContext } from "@i-harness/session-executor"
import { createSessionManagementFence, type SessionManagementFence } from "./session-management-fence.ts"
export interface ProjectMoveOptions { assertIdle?(id: string): Promise<void>; drainSession?(id: string): Promise<void>; fence?: SessionManagementFence }

interface Binding { bound: boolean; projectId?: string }
interface ConfirmedProjectScope { id: string; name: string; roots: string[]; primaryRoot?: string; unavailableReason?: string }
class ProjectFoldersUnavailable extends Error {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid project or session ID")
  return value
}
async function directory(value: unknown, field: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`Project ${field} must be absolute directory paths`)
  try {
    const path = await realpath(value)
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory")
    return path
  } catch { throw new ProjectFoldersUnavailable(`Project ${field} must refer to an existing directory`) }
}

/** Session documents identify owners; only this process's main-confirmed
 * catalog supplies roots. Reopening a session never restores saved authority. */
export function createProjectScopeBroker(coordinator: SessionCoordinator, _workspace: string, visible: (id: string, meta: SessionMeta) => Promise<boolean> = async () => true, moveOptions: ProjectMoveOptions = {}) {
  const fence = moveOptions.fence ?? createSessionManagementFence()
  const projects = new Map<string, ConfirmedProjectScope>()
  const bindings = new Map<string, Binding>()
  const parents = new Map<string, string>()
  const loading = new Map<string, Promise<Binding>>()
  const operations = new Map<string, Promise<unknown>>()
  let closed = false
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closed) throw new Error("Project scope broker is closed") }
  let catalogTail: Promise<unknown> = Promise.resolve()
  function catalog<T>(work: () => Promise<T>): Promise<T> {
    const job = catalogTail.catch(() => undefined).then(() => { assertOpen(); return work() })
    catalogTail = job
    return job
  }
  const key = (id: string) => `desktop-session-project-${createHash("sha256").update(id).digest("hex")}`
  async function ensureVisible(id: string): Promise<SessionMeta> {
    assertOpen()
    identifier(id)
    const { meta } = await coordinator.profile(id)
    if (!await visible(id, meta)) throw new Error("Session is unavailable")
    return meta
  }
  function load(id: string): Promise<Binding> {
    const saved = bindings.get(id)
    if (saved) return Promise.resolve(saved)
    const pending = loading.get(id)
    if (pending) return pending
    const job = coordinator.getDocument(key(id)).then((document): Binding => {
      if (document === undefined) { const value = { bound: false }; bindings.set(id, value); return value }
      if (!object(document) || document.version !== 1 || Object.keys(document).some((field) => !["version", "projectId"].includes(field))) throw new Error("Invalid session project binding")
      const projectId = document.projectId === undefined ? undefined : identifier(document.projectId)
      const value = { bound: true, ...(projectId ? { projectId } : {}) }
      bindings.set(id, value)
      return value
    }).finally(() => { loading.delete(id) })
    loading.set(id, job)
    return job
  }
  function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const job = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    operations.set(id, job)
    void job.finally(() => { if (operations.get(id) === job) operations.delete(id) }).catch(() => undefined)
    return job
  }
  async function save(id: string, projectId?: string): Promise<void> {
    assertOpen()
    const document = { version: 1, ...(projectId ? { projectId } : {}) }
    await coordinator.putDocument(key(id), document)
    // Coordinator background document errors are reported rather than thrown.
    // Readback is the commit check before exposing or acknowledging ownership.
    const saved = await coordinator.getDocument(key(id))
    if (!object(saved) || saved.version !== 1 || saved.projectId !== projectId) throw new Error("Could not persist session project binding")
    bindings.set(id, { bound: true, ...(projectId ? { projectId } : {}) })
  }
  async function resolveOwner(id: string, ownedOperation?: string): Promise<Binding> {
    const chain: string[] = []
    const visited = new Set<string>()
    let cursor = id
    for (;;) {
      if (visited.has(cursor) || chain.length >= 32) throw new Error("Invalid or excessive session project lineage")
      visited.add(cursor); chain.push(cursor)
      const meta = await ensureVisible(cursor)
      if ((await load(cursor)).bound) break
      if (!meta.parentSession || (meta.origin !== "subagent" && meta.origin !== "team")) { parents.delete(cursor); break }
      const parent = identifier(meta.parentSession)
      parents.set(cursor, parent)
      cursor = parent
    }
    // Validate the complete chain before waiting: cyclic metadata must not
    // cause two pending binds to wait on each other indefinitely.
    await Promise.all(chain.filter((sessionId) => sessionId !== ownedOperation).map((sessionId) => operations.get(sessionId)))
    return chain.map((sessionId) => bindings.get(sessionId)).find((binding) => binding?.bound) ?? { bound: false }
  }
  function liveOwner(id: string): string | undefined {
    const visited = new Set<string>()
    let cursor: string | undefined = id
    while (cursor) {
      if (visited.has(cursor) || visited.size >= 32) return undefined
      visited.add(cursor)
      const own = bindings.get(cursor)
      if (own?.bound) return own.projectId
      cursor = parents.get(cursor)
    }
    return undefined
  }
  async function projectFor(id: string): Promise<string | undefined> {
    return (await resolveOwner(id)).projectId
  }
  function scopeSchema(value: unknown): ConfirmedProjectScope {
    if (!object(value)) throw new Error("Invalid project scope")
    const id = identifier(value.id)
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new Error("Invalid project name")
    if (!Array.isArray(value.roots) || value.roots.length > 100) throw new Error("Project roots must contain existing absolute directories")
    if (value.roots.length === 0) {
      if (value.primaryRoot !== undefined) throw new Error("An empty project cannot have a primary root")
      return { id, name: value.name.trim(), roots: [] }
    }
    if (value.roots.some((root) => typeof root !== "string" || !isAbsolute(root))) throw new Error("Project roots must be absolute directory paths")
    const roots = value.roots as string[]
    if (new Set(roots.map((root) => pathKey(resolve(root)))).size !== roots.length) throw new Error("Project roots contain duplicate directories")
    if (typeof value.primaryRoot !== "string" || !isAbsolute(value.primaryRoot)
      || !roots.some((root) => pathKey(resolve(root)) === pathKey(resolve(value.primaryRoot as string)))) throw new Error("Project primary root must be an absolute project member")
    return { id, name: value.name.trim(), roots: [...roots], primaryRoot: value.primaryRoot }
  }
  async function resolveScope(scope: ConfirmedProjectScope): Promise<ConfirmedProjectScope> {
    if (scope.roots.length === 0) return scope
    const roots = await Promise.all(scope.roots.map((root) => directory(root, "roots")))
    if (new Set(roots.map(pathKey)).size !== roots.length) throw new Error("Project roots contain duplicate directories")
    const primaryIndex = scope.roots.findIndex((root) => pathKey(resolve(root)) === pathKey(resolve(scope.primaryRoot!)))
    return { ...scope, roots, primaryRoot: roots[primaryIndex]! }
  }
  function blocked(scope: ConfirmedProjectScope): ConfirmedProjectScope {
    return { id: scope.id, name: scope.name, roots: [], unavailableReason: "Project folders are unavailable" }
  }
  function assertAvailable(projectId?: string): void {
    const context = projectId ? projects.get(projectId) : undefined
    if (context?.unavailableReason) throw new Error(context.unavailableReason)
    if (context && (context.roots.length === 0 || context.primaryRoot === undefined)) throw new Error("Project has no workspace folders")
  }
  return {
    configure(value: unknown): Promise<{ projectId: string }> {
      const snapshot = structuredClone(value)
      return catalog(async () => {
        const declared = scopeSchema(snapshot)
        try {
          const project = await resolveScope(declared)
          assertOpen()
          projects.set(project.id, project)
          return { projectId: project.id }
        } catch (error) {
          if (error instanceof ProjectFoldersUnavailable) { assertOpen(); projects.set(declared.id, blocked(declared)) }
          throw error
        }
      })
    },
    sync(value: unknown): Promise<{ synchronized: true }> {
      const snapshot = structuredClone(value)
      return catalog(async () => {
        if (!Array.isArray(snapshot) || snapshot.length > 2048) throw new Error("Invalid project scope catalog")
        const declarations = snapshot.map(scopeSchema)
        if (new Set(declarations.map((project) => project.id)).size !== declarations.length) throw new Error("Project scope catalog contains duplicate IDs")
        const confirmed = await Promise.all(declarations.map(async (project) => {
          try { return await resolveScope(project) }
          catch (error) { if (error instanceof ProjectFoldersUnavailable) return blocked(project); throw error }
        }))
        assertOpen()
        projects.clear()
        for (const project of confirmed) projects.set(project.id, project)
        return { synchronized: true as const }
      })
    },
    revoke(projectId: string): Promise<{ revoked: boolean }> { return catalog(async () => ({ revoked: projects.delete(identifier(projectId)) })) },
    bind(id: string, projectId?: string): Promise<{ sessionId: string; projectId?: string }> {
      return serial(id, async () => {
        await ensureVisible(id)
        if (projectId !== undefined) identifier(projectId)
        const own = await load(id)
        const existing = await resolveOwner(id, id)
        if (existing.bound) {
          if (projectId !== undefined && existing.projectId !== projectId) throw new Error("Session already belongs to another project; an explicit move is required")
          assertAvailable(existing.projectId)
          if (!own.bound) await save(id, existing.projectId)
          return { sessionId: id, ...(existing.projectId ? { projectId: existing.projectId } : {}) }
        }
        if (projectId !== undefined && !projects.has(projectId)) throw new Error("Project scope has not been confirmed by the current main process")
        assertAvailable(projectId)
        await save(id, projectId)
        return { sessionId: id, ...(projectId ? { projectId } : {}) }
      })
    },
    projectFor,
    move(id: string, expectedOwner: string | undefined, projectId: string | undefined): Promise<{ sessionId: string; projectId?: string; executionWorkspace: string }> {
      return serial(id, () => fence.exclusive(id, async () => {
        const meta = await ensureVisible(id)
        if (meta.origin === "subagent" || meta.origin === "approval-review" || (meta.origin === "team" && meta.parentSession)) throw new Error("Session is unavailable for project move")
        if (!moveOptions.assertIdle) throw new Error("Idle project move inspection is unavailable")
        if (expectedOwner !== undefined) identifier(expectedOwner)
        if (projectId !== undefined) identifier(projectId)
        const alreadyOwned = coordinator.ownerOf(id)
        await coordinator.adoptOwnership(id)
        try {
        // A second broker/process may have committed ownership since this
        // broker last resolved it. Compare durable identity under the lease.
        await loading.get(id)
        bindings.delete(id)
        const current = await resolveOwner(id, id)
        if (current.projectId !== expectedOwner) throw new Error("Session project owner changed; refresh before moving")
        for (const child of await coordinator.list()) if ((await coordinator.profile(child)).meta.parentSession === id) throw new Error("Session has descendants; coordinated project move is unavailable")
        await catalog(async () => {
          if (projectId !== undefined) {
            const declared = projects.get(projectId)
            if (!declared) throw new Error("Destination project has not been confirmed by the current main process")
            projects.set(projectId, await resolveScope(declared))
            assertAvailable(projectId)
          }
        })
        await moveOptions.assertIdle(id)
        await moveOptions.drainSession?.(id)
        await moveOptions.assertIdle(id)
        await catalog(async () => {
          await loading.get(id)
          bindings.delete(id)
          if ((await resolveOwner(id, id)).projectId !== expectedOwner) throw new Error("Session project owner changed; refresh before moving")
          if (projectId !== undefined) {
            const declared = projects.get(projectId)
            if (!declared) throw new Error("Destination project has not been confirmed by the current main process")
            const scope = await resolveScope(declared)
            projects.set(projectId, scope)
            assertAvailable(projectId)
          }
          await save(id, projectId)
        })
        return { sessionId: id, ...(projectId ? { projectId } : {}), executionWorkspace: _workspace }
        } finally { if (!alreadyOwned) await coordinator.releaseOwnership(id) }
      }, async () => {
        if (!moveOptions.assertIdle) throw new Error("Idle project move inspection is unavailable")
        await moveOptions.assertIdle(id)
      }))
    },
    async state(id: string): Promise<{ sessionId: string; projectId?: string }> {
      const projectId = await projectFor(id)
      return { sessionId: id, ...(projectId ? { projectId } : {}) }
    },
    async forSession(id: string): Promise<() => SessionProjectContext | undefined> {
      await resolveOwner(id)
      return () => {
        if (closed) throw new Error("Project scope service closed")
        const projectId = liveOwner(id)
        const context = projectId ? projects.get(projectId) : undefined
        if (!context) return undefined
        assertAvailable(projectId)
        return { id: context.id, name: context.name, primaryRoot: context.primaryRoot!, roots: [...context.roots] }
      }
    },
    inherit(sourceId: string, childId: string): Promise<void> {
      return serial(childId, async () => {
        await ensureVisible(childId)
        const projectId = await projectFor(sourceId)
        const existing = await load(childId)
        if (existing.bound) {
          if (existing.projectId !== projectId) throw new Error("Forked session already belongs to another project")
          return
        }
        await save(childId, projectId)
      })
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true
      projects.clear()
      closing = Promise.allSettled([catalogTail, ...operations.values(), ...loading.values()]).then(() => {})
      return closing
    },
  }
}
