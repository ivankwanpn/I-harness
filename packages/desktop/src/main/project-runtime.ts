import type { ProjectCatalog } from "./projects.ts"
import type { WorkspaceCatalog } from "./workspaces.ts"
import type { WorkspaceRuntimeManager } from "./sdk-runtime.ts"

export interface DesktopProjectContext { id: string; name: string; roots: string[]; primaryRoot?: string }
/** Only native canonical folder IDs become execution paths. Renderers cannot
 * grant arbitrary roots through a scope RPC. */
export async function projectRuntimeContexts(projects: ProjectCatalog, catalog: WorkspaceCatalog): Promise<DesktopProjectContext[]> {
  return (await projects.list()).map((project) => {
    if (!project.workspaceIds.length) return { id: project.id, name: project.name, roots: [] }
    const roots = project.workspaceIds.map((id) => {
      const folder = catalog.get(id)
      if (!folder) throw new Error("Project contains an unknown workspace")
      return folder.path
    })
    const primaryRoot = catalog.get(project.primaryWorkspaceId ?? project.workspaceIds[0]!)?.path
    if (!primaryRoot) throw new Error("Project primary folder is unavailable")
    return { id: project.id, name: project.name, roots, primaryRoot }
  })
}

export async function syncLiveProjectContexts(projects: ProjectCatalog, catalog: WorkspaceCatalog, runtimes: WorkspaceRuntimeManager): Promise<void> {
  if (runtimes.refreshProjectContexts) return runtimes.refreshProjectContexts()
  const scopes = await projectRuntimeContexts(projects, catalog)
  const outcomes = await Promise.allSettled((await catalog.list()).map(async (workspace) => {
    const runtime = runtimes.peek?.(workspace.id)
    if (!runtime) return
    try { await runtime.client.request("desktop/project/sync", { projects: scopes }) }
    catch (error) { await runtimes.invalidate?.(workspace.id); throw error }
  }))
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Project scope update failed; affected Agent runtimes were closed. Retry to apply the current folder settings.")
}
