import type { RpcMessage } from "@i-harness/sdk"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import type { SessionQuery } from "@i-harness/session-query"
import type { MemoryStore } from "@i-harness/memory"
import type { InteractionBridge } from "./interaction.ts"
import type { WorkspaceReview } from "./review.ts"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface DesktopHandlers {
  provider?: ProviderRuntime
  memory?: MemoryStore
  compact?: (sessionId: string, instructions: string | undefined, signal: AbortSignal) => Promise<unknown>
  sessionQuery?: SessionQuery
  sandboxState?: () => SandboxState | Promise<SandboxState>
  interaction?: Pick<InteractionBridge, "pending" | "reply"> & Partial<Pick<InteractionBridge, "cancelSession">>
  review?: WorkspaceReview
}

export type GatewayWrite = (frame: RpcMessage) => void
