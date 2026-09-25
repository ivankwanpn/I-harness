/**
 * Shared renderer↔main boundary. The main process emits these events through
 * the preload bridge; the scoped-IPC task adds the request union alongside.
 */
export type DesktopEvent =
  | { kind: "sdk/notification"; workspaceId: string; method: "session/event" | "session/status"; params: unknown }
  | { kind: "sdk/disconnected"; workspaceId: string; message: string }
