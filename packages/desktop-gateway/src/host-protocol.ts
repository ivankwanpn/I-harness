/** The private stdio envelope between the desktop shell and its host process.
 * Each data line belongs to an independent SDK connection. */
export const DESKTOP_CONFIGURATION_ID = "desktop-configuration"

export type DesktopHostCommand =
  | { type: "ping" }
  | { type: "open"; workspaceId: string; workspacePath: string }
  | { type: "data"; workspaceId: string; line: string }
  | { type: "close"; workspaceId: string }
  | { type: "shutdown" }

export type DesktopHostEvent =
  | { type: "pong" }
  | { type: "opened" | "closed"; workspaceId: string }
  | { type: "data"; workspaceId: string; line: string }
  | { type: "error"; workspaceId?: string; operation?: "open" | "data" | "close"; message: string }
