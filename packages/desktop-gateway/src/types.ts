import type { RpcMessage } from "@i-harness/sdk"
import type { InteractionBridge } from "./interaction.ts"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface DesktopHandlers {
  sandboxState?: () => SandboxState | Promise<SandboxState>
  interaction?: Pick<InteractionBridge, "pending" | "reply">
}

export type GatewayWrite = (frame: RpcMessage) => void
