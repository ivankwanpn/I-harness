import type { RpcMessage } from "@i-harness/sdk"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import type { SessionQuery } from "@i-harness/session-query"
import type { MemoryStore } from "@i-harness/memory"
import type { InteractionBridge } from "./interaction.ts"
import type { WorkspaceReview } from "./review.ts"
import type { createSessionManagement } from "./session-management.ts"
import type { createDesktopRewind } from "./rewind.ts"
import type { createDesktopPlugins } from "./plugins.ts"
import type { createDesktopTerminal } from "./terminal.ts"
import type { createAgentSettings } from "./agent-settings.ts"
import type { createSubagentSettings } from "./subagent-settings.ts"
import type { createHookSettings } from "./hook-settings.ts"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface DesktopHandlers {
  hooks?: ReturnType<typeof createHookSettings>
  subagents?: ReturnType<typeof createSubagentSettings>
  agentSettings?: ReturnType<typeof createAgentSettings>
  terminal?: ReturnType<typeof createDesktopTerminal>
  plugins?: ReturnType<typeof createDesktopPlugins>
  rewind?: ReturnType<typeof createDesktopRewind>
  sessions?: ReturnType<typeof createSessionManagement>
  provider?: ProviderRuntime
  memory?: MemoryStore
  compact?: (sessionId: string, instructions: string | undefined, signal: AbortSignal) => Promise<unknown>
  sessionQuery?: SessionQuery
  sandboxState?: () => SandboxState | Promise<SandboxState>
  interaction?: Pick<InteractionBridge, "pending" | "reply"> & Partial<Pick<InteractionBridge, "cancelSession">>
  review?: WorkspaceReview
}

export type GatewayWrite = (frame: RpcMessage) => void
