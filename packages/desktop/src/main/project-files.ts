import type { DesktopIpcDependencies } from "./ipc.ts"
import { resolveCurrentProjectMembers, runtimeForProjectMember } from "./project-membership.ts"
import { projectRelativePath, type ProjectFileSelection } from "../../../desktop-gateway/src/project-files.ts"

const nonempty = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value || value.length > 256 || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${name}`)
  return value
}
/** Native IPC integration: invoke before the central DesktopRequest switch for
 * every desktop/project-files/* request. No renderer-provided root grants access. */
export async function dispatchProjectFilesRequest(value: Record<string, unknown>, dependencies: DesktopIpcDependencies): Promise<unknown> {
  const kind = value.kind
  if (typeof kind !== "string" || !["roots", "list", "search", "read", "save"].some((operation) => kind === `desktop/project-files/${operation}`)) throw new Error("Invalid project files request")
  const selection: ProjectFileSelection = { workspaceId: nonempty(value.workspaceId, "workspaceId"), ...(value.sessionId === undefined ? {} : { sessionId: nonempty(value.sessionId, "sessionId") }), ...(value.projectId === undefined ? {} : { projectId: nonempty(value.projectId, "projectId") }) }
  const scope = await resolveCurrentProjectMembers(selection, dependencies)
  if (kind.endsWith("/roots")) return { roots: scope.members.map((member) => ({ workspaceId: member.id, label: member.label })), projectId: scope.projectId }
  const ref = value.ref as Record<string, unknown> | null
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error("Invalid project file identity")
  const targetId = nonempty(ref.workspaceId, "target workspaceId")
  const path = projectRelativePath(ref.path, kind.endsWith("/list") || kind.endsWith("/search"))
  const params: Record<string, unknown> = { path }
  if (kind.endsWith("/list") || kind.endsWith("/search")) {
    if (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 3000) throw new Error("Invalid project file offset")
    params.offset = value.offset
  }
  if (kind.endsWith("/search")) {
    if (path !== "" || typeof value.query !== "string" || value.query.length > 512 || /[\0\r\n]/.test(value.query)) throw new Error("Invalid project filename query")
    params.query = value.query
  }
  if (kind.endsWith("/save")) {
    if (typeof value.text !== "string" || new TextEncoder().encode(value.text).length > 256 * 1024 || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision)) throw new Error("Invalid source file save")
    params.text = value.text; params.expectedRevision = value.expectedRevision
  }
  const { runtime, member, projectId } = await runtimeForProjectMember(selection, targetId, dependencies)
  if (!runtime.info.capabilities["desktop-project-files"]?.includes("1")) throw new Error("Project file access unavailable")
  const result = await runtime.client.request(kind, params)
  const after = await resolveCurrentProjectMembers(selection, dependencies)
  if (after.projectId !== projectId || after.projectId !== scope.projectId || !after.members.some((row) => row.id === member.id && row.path === member.path)) throw new Error("Project folder membership changed")
  return result
}
