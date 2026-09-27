import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
import type { PluginCommand } from "@i-harness/desktop-gateway/src/plugins.ts"
import type { ImageInput, SessionModelSelection } from "@i-harness/sdk"
import type { AgentDefaults } from "@i-harness/desktop-gateway/src/agent-settings.ts"
import type { SubagentSettingsCommand } from "@i-harness/desktop-gateway/src/subagent-settings.ts"
import type { HookSettingsCommand } from "@i-harness/desktop-gateway/src/hook-settings.ts"
import type { McpSettingsCommand } from "@i-harness/desktop-gateway/src/mcp-settings.ts"
import type { ResourceKind } from "@i-harness/desktop-gateway/src/resources.ts"
/** Channel names shared by preload and main; nothing else crosses the bridge. */
export const DESKTOP_REQUEST_CHANNEL = "ih-desktop:request"
export const DESKTOP_EVENT_CHANNEL = "ih-desktop:event"
export type TerminalShellChoice = "auto" | "git-bash" | "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "sh"

export type DesktopRequest =
  | { kind: "workspace/files/pick"; workspaceId: string }
  | { kind: "desktop/resources/list"; workspaceId: string; resourceKind: ResourceKind; query: string; offset: number }
  | { kind: "desktop/resources/read"; workspaceId: string; resourceKind: ResourceKind; name: string }
  | { kind: "desktop/mcp/state" | "desktop/mcp/refresh"; workspaceId: string }
  | { kind: "desktop/mcp/mutate"; workspaceId: string; command: McpSettingsCommand }
  | { kind: "desktop/hooks/state" | "desktop/hooks/refresh"; workspaceId: string }
  | { kind: "desktop/hooks/mutate"; workspaceId: string; command: HookSettingsCommand }
  | { kind: "desktop/subagents/state"; workspaceId: string }
  | { kind: "desktop/subagents/mutate"; workspaceId: string; command: SubagentSettingsCommand }
  | { kind: "desktop/agent-settings/state"; workspaceId: string }
  | { kind: "desktop/agent-settings/configure"; workspaceId: string; patch: Partial<AgentDefaults> }
  | { kind: "browser/list" | "browser/open" | "browser/hide"; workspaceId: string }
  | { kind: "browser/close"; workspaceId: string; id: string }
  | { kind: "browser/navigate"; workspaceId: string; id: string; url: string }
  | { kind: "browser/action"; workspaceId: string; id: string; action: "back" | "forward" | "reload" | "stop" }
  | { kind: "browser/show"; workspaceId: string; id: string; bounds: { x: number; y: number; width: number; height: number } }
  | { kind: "desktop/terminal/list" | "desktop/terminal/open" | "desktop/terminal/options"; workspaceId: string }
  | { kind: "desktop/terminal/close"; workspaceId: string; id: string }
  | { kind: "desktop/terminal/read"; workspaceId: string; id: string; offset: number }
  | { kind: "desktop/terminal/write"; workspaceId: string; id: string; data: string }
  | { kind: "desktop/terminal/resize"; workspaceId: string; id: string; cols: number; rows: number }
  | { kind: "desktop/schedule/list"; workspaceId: string; sessionId: string }
  | { kind: "desktop/schedule/create"; workspaceId: string; sessionId: string; command: { prompt: string; after_seconds?: number; at?: string; every_seconds?: number } }
  | { kind: "desktop/schedule/delete"; workspaceId: string; sessionId: string; id: string }
  | { kind: "desktop/session/work-state"; workspaceId: string; sessionId: string }
  | { kind: "desktop/plugins/state" | "desktop/plugins/commands" | "desktop/plugins/refresh"; workspaceId: string }
  | { kind: "desktop/plugins/mutate"; workspaceId: string; command: PluginCommand }
  | { kind: "desktop/rewind/points"; workspaceId: string; sessionId: string }
  | { kind: "desktop/rewind/plan"; workspaceId: string; sessionId: string; target: number; mode: "all" | "files" | "conversation" }
  | { kind: "desktop/rewind/execute"; workspaceId: string; sessionId: string; target: number; mode: "all" | "files" | "conversation"; fingerprint: string }
  | { kind: "desktop/session/archived"; workspaceId: string }
  | { kind: "desktop/session/manage"; workspaceId: string; sessionId: string; action: "rename" | "archive" | "restore" | "fork"; title?: string }
  | { kind: "session/model/set"; workspaceId: string; sessionId: string; selection: SessionModelSelection }
  | { kind: "desktop/provider/directory"; workspaceId: string }
  | { kind: "desktop/provider/probe"; workspaceId: string; id: string; token: string }
  | { kind: "desktop/provider/probe/cancel"; workspaceId: string; token: string }
  | { kind: "desktop/provider/mutate"; workspaceId: string; command: ProviderCommand }
  | { kind: "window/control"; action: "minimize" | "toggle-maximize" | "close" }
  | { kind: "window/reset-bounds" | "desktop/local/state" }
  | { kind: "desktop/local/configure"; notifications?: boolean; locale?: "zh-TW" | "en"; terminalShell?: TerminalShellChoice; terminalFontFamily?: string }
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
  | { kind: "session/prompt"; workspaceId: string; sessionId: string; prompt: string; context?: string; images?: ImageInput[]; clientToken?: string }
  | { kind: "session/cancel"; workspaceId: string; sessionId: string }
  | { kind: "session/queue"; workspaceId: string; sessionId: string }
  | { kind: "session/queue/cancel"; workspaceId: string; sessionId: string; id: string }
  | { kind: "session/tasks"; workspaceId: string; sessionId: string }
  | { kind: "session/tasks/cancel"; workspaceId: string; sessionId: string; id: string }
  | { kind: "session/model/state"; workspaceId: string; sessionId: string }
  | { kind: "session/context"; workspaceId: string; sessionId: string }
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
