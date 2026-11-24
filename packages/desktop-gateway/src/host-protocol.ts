/** The private stdio envelope between the desktop shell and its host process.
 * Each data line belongs to an independent SDK connection. */
export const DESKTOP_CONFIGURATION_ID = "desktop-configuration"

export interface DesktopActivityReport {
  profileActive: boolean
  scopes: [string, boolean][]
}

export type DesktopHostCommand =
  | { type: "ping" }
  | { type: "activity"; requestId: number; workspaceIds?: string[] }
  | { type: "open"; workspaceId: string; workspacePath: string; activityReports?: 1; isolatedWorktree?: true }
  | { type: "data"; workspaceId: string; line: string }
  | { type: "close"; workspaceId: string }
  | { type: "shutdown" }

export type DesktopHostEvent =
  | { type: "pong" }
  | ({ type: "activity"; requestId: number } & DesktopActivityReport)
  | { type: "opened"; workspaceId: string; activityReports?: 1; isolatedWorktree?: true }
  | { type: "closed"; workspaceId: string }
  | { type: "data"; workspaceId: string; line: string }
  | { type: "error"; workspaceId?: string; operation?: "open" | "data" | "close"; message: string }
