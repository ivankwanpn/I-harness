/** Channel names shared by preload and main; nothing else crosses the bridge. */
export const DESKTOP_REQUEST_CHANNEL = "ih-desktop:request"
export const DESKTOP_EVENT_CHANNEL = "ih-desktop:event"

export type DesktopRequest =
  | { kind: "workspace/open"; path: string }
  | { kind: "workspace/pick" }
  | { kind: "workspace/list" }
  | { kind: "workspace/sandbox/state"; workspaceId: string }
  | { kind: "desktop/capabilities"; workspaceId: string }
  | { kind: "session/list"; workspaceId: string }
  | { kind: "session/dashboard"; workspaceId: string }
  | { kind: "session/create"; workspaceId: string }
  | { kind: "session/history"; workspaceId: string; sessionId: string; afterSeq: number; limit: number }
  | { kind: "session/prompt"; workspaceId: string; sessionId: string; prompt: string }
  | { kind: "session/cancel"; workspaceId: string; sessionId: string }
  | { kind: "session/queue"; workspaceId: string; sessionId: string }
  | { kind: "session/queue/cancel"; workspaceId: string; sessionId: string; id: string }
  | { kind: "session/tasks"; workspaceId: string; sessionId: string }
  | { kind: "session/tasks/cancel"; workspaceId: string; sessionId: string; id: string }
  | { kind: "session/model/state"; workspaceId: string; sessionId: string }

export type DesktopEvent =
  | { kind: "sdk/notification"; workspaceId: string; method: "session/event" | "session/status"; params: unknown }
  | { kind: "sdk/disconnected"; workspaceId: string; message: string }

export interface DesktopBridge {
  request(request: DesktopRequest): Promise<unknown>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
