import type { SandboxMode } from "@i-harness/sandbox"
import type { SessionEvent } from "@i-harness/core-session"

export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]

export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!
    if (ev.type === "sandbox/mode") return ev.mode
  }
  return undefined
}
