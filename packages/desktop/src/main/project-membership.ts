import type { DesktopIpcDependencies } from "./ipc.ts"
import type { WorkspaceEntry } from "./workspaces.ts"

export interface ProjectSelection { workspaceId: string; sessionId?: string; projectId?: string }
/** Session ownership is resolved through its host runtime. Saved renderer
 * identity never supplies authority; the current native catalog does. */
export async function resolveCurrentProjectMembers(selection: ProjectSelection, dependencies: DesktopIpcDependencies): Promise<{ projectId?: string; members: WorkspaceEntry[] }> {
  const host = dependencies.catalog.get(selection.workspaceId)
  if (!host) throw new Error("Unknown project host folder")
  let projectId = selection.projectId
  if (selection.sessionId) {
    const runtime = await dependencies.runtimes.get(host)
    if (!runtime.info.capabilities["desktop-project-scope"]?.includes("1")) throw new Error("Session project ownership unavailable")
    const owner = await runtime.client.request("desktop/session/project/state", { sessionId: selection.sessionId }) as { sessionId?: string; projectId?: string }
    if (owner?.sessionId !== selection.sessionId || (owner.projectId !== undefined && typeof owner.projectId !== "string")) throw new Error("Invalid session project owner")
    projectId = owner.projectId
  }
  const currentHost = dependencies.catalog.get(selection.workspaceId)
  if (!currentHost || currentHost.path !== host.path) throw new Error("Project host folder changed")
  if (!projectId) return { members: [currentHost] }
  const project = (await dependencies.projects?.list())?.find((row) => row.id === projectId)
  if (!project || !project.workspaceIds.includes(selection.workspaceId)) throw new Error("Project no longer contains the host folder")
  return { projectId, members: project.workspaceIds.map((id) => dependencies.catalog.get(id)).filter((row): row is WorkspaceEntry => !!row) }
}

export async function runtimeForProjectMember(selection: ProjectSelection, workspaceId: string, dependencies: DesktopIpcDependencies) {
  const before = await resolveCurrentProjectMembers(selection, dependencies)
  const member = before.members.find((row) => row.id === workspaceId)
  if (!member) throw new Error("Folder is not a current project member")
  const runtime = await dependencies.runtimes.get(member)
  const current = await resolveCurrentProjectMembers(selection, dependencies)
  if (current.projectId !== before.projectId || !current.members.some((row) => row.id === member.id && row.path === member.path)) throw new Error("Project folder membership changed")
  return { runtime, member, projectId: current.projectId }
}
