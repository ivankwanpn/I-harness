import type { RpcMessage } from "@i-harness/sdk"

export interface SandboxState {
  mode: "read-only" | "workspace-write" | "danger-full-access"
  source: "settings"
  wired: true
}

export interface DesktopHandlers {
  sandboxState?: () => SandboxState | Promise<SandboxState>
}

export type GatewayWrite = (frame: RpcMessage) => void
