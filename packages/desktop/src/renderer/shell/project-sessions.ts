import type { DashboardSessionRow, SessionDashboardResult } from "@i-harness/sdk"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { SessionNavigation } from "./SessionActions.tsx"
import type { TaskRowScope } from "./TaskList.tsx"

export type ProjectSessionNavigation = SessionNavigation & { projectId?: string }
export interface WorkspaceSessionSnapshot {
  dashboard?: SessionDashboardResult
  navigation?: Record<string, ProjectSessionNavigation>
  error?: string
}
export interface ProjectSessionRow {
  key: string
  session: DashboardSessionRow
  source: TaskRowScope
  navigation: ProjectSessionNavigation
}

export const projectSessionKey = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId])
export const confirmedSessionNavigation = (row: unknown): row is ProjectSessionNavigation => !!row && typeof row === "object"
  && typeof (row as ProjectSessionNavigation).pinned === "boolean" && typeof (row as ProjectSessionNavigation).unread === "boolean"
  && ((row as ProjectSessionNavigation).projectId === undefined || typeof (row as ProjectSessionNavigation).projectId === "string" && (row as ProjectSessionNavigation).projectId !== "")
export const isSessionNavigationState = (value: unknown): value is Record<string, ProjectSessionNavigation> => !!value && typeof value === "object" && !Array.isArray(value)

/** Filter by confirmed saved ownership before assigning a display destination.
 * Legacy unowned member history and removed-owner history remain display-only
 * compatibility paths; neither path rewrites the saved owner. */
export function collectProjectSessions(input: {
  workspaces: WorkspaceEntry[]
  snapshots: Record<string, WorkspaceSessionSnapshot>
  projectId?: string
  memberWorkspaceIds: ReadonlySet<string>
  assignedWorkspaceIds: ReadonlySet<string>
  knownProjectIds: ReadonlySet<string>
}): ProjectSessionRow[] {
  return input.workspaces.flatMap(workspace => {
    const snapshot = input.snapshots[workspace.id]
    if (!snapshot?.dashboard || snapshot.dashboard.listingUnavailable || !snapshot.navigation) return []
    return snapshot.dashboard.sessions.flatMap(session => {
      if (!Object.hasOwn(snapshot.navigation!, session.id)) return []
      const navigation = snapshot.navigation![session.id]
      if (!confirmedSessionNavigation(navigation)) return []
      const owner = navigation.projectId
      const visible = input.projectId
        ? owner === input.projectId || owner === undefined && input.memberWorkspaceIds.has(workspace.id)
        : owner === undefined ? !input.assignedWorkspaceIds.has(workspace.id) : !input.knownProjectIds.has(owner)
      return visible ? [{ key: projectSessionKey(workspace.id, session.id), session, navigation,
        source: { workspaceId: workspace.id, sessionId: session.id, ...(owner === undefined ? {} : { projectId: owner }) } }] : []
    })
  })
}
