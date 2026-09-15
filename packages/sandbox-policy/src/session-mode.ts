import type { SandboxMode } from "@i-harness/sandbox"
import type { SessionEvent } from "@i-harness/core-session"

export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"]

export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!
    if (ev.type !== "sandbox/mode") continue
    // The event is persisted and replayed, and `append` does not validate the
    // mode (core-session validates images and assistant-source only; logs loaded
    // from disk bypass validation entirely). Replay must not feed an
    // out-of-vocabulary value to `checkWrite`, which tests two literals and would
    // silently treat anything else as workspace-write -- a downgrade nobody asked
    // for. Skip the bad event and keep scanning, so a corrupt newest entry cannot
    // discard a valid older one.
    //
    // This closes the REPLAYED-EVENT path only. `createSandboxPolicy({ mode })`
    // (src/index.ts) sets `defaultMode`, which reaches `checkWrite` without
    // passing through here, so a host-supplied mode -- session-executor/src/
    // assembly.ts passes `opts.sandbox` straight in -- is still unvalidated.
    if (!SANDBOX_MODES.includes(ev.mode)) continue
    return ev.mode
  }
  return undefined
}
