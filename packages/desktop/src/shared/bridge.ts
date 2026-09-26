import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
/** Channel names shared by preload and main; nothing else crosses the bridge. */
export const DESKTOP_REQUEST_CHANNEL = "ih-desktop:request"
export const DESKTOP_EVENT_CHANNEL = "ih-desktop:event"

export type DesktopRequest =
  | { kind: "desktop/provider/directory"; workspaceId: string }
  | { kind: "desktop/provider/probe"; workspaceId: string; id: string; token: string }
  | { kind: "desktop/provider/probe/cancel"; workspaceId: string; token: string }
  | { kind: "desktop/provider/mutate"; workspaceId: string; command: ProviderCommand }
  | { kind: "window/control"; action: "minimize" | "toggle-maximize" | "close" }
  | { kind: "window/reset-bounds" | "desktop/local/state" }
  | { kind: "desktop/local/configure"; notifications?: boolean; locale?: "zh-TW" | "en" }
  | { kind: "desktop/session/search"; workspaceId: string; query: string; sessionId?: string; limit?: number }
  | { kind: "desktop/session/compact"; workspaceId: string; sessionId: string; instructions?: string }
  | { kind: "desktop/memory/state" | "desktop/memory/summary"; workspaceId: string }
  | { kind: "desktop/memory/configure"; workspaceId: string; enabled: boolean }
  | { kind: "desktop/memory/list"; workspaceId: string; limit?: number }
  | { kind: "desktop/memory/search"; workspaceId: string; query: string; limit?: number }
  | { kind: "desktop/memory/read" | "desktop/memory/forget"; workspaceId: string; id: string }
  | { kind: "desktop/memory/note"; workspaceId: string; title: string; text: string }
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
  | { kind: "desktop/interaction/pending"; workspaceId: string; sessionId?: string }
  | {
      kind: "desktop/interaction/reply"
      workspaceId: string
      requestId: string
      sessionId: string
      decision: { kind: "approval"; approved: boolean } | { kind: "question"; answer: string }
    }
  | { kind: "desktop/review/changes"; workspaceId: string }
  | { kind: "desktop/review/diff"; workspaceId: string; path: string; maxBytes?: number }
  | { kind: "desktop/review/file"; workspaceId: string; path: string; maxBytes?: number }

export type DesktopEvent =
  | {
      kind: "sdk/notification"
      workspaceId: string
      method: "session/event" | "session/status" | "desktop/interaction/request" | "desktop/interaction/closed"
      params: unknown
    }
  | { kind: "sdk/disconnected"; workspaceId: string; message: string }

export interface DesktopBridge {
  request(request: DesktopRequest): Promise<unknown>
  onEvent(listener: (event: DesktopEvent) => void): () => void
}
