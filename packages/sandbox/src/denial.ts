import type { SandboxMode } from "./index.ts"
import { WIDER_MODES } from "./escalation.ts"

// The ONE refusal shape both confined surfaces report (spec §3.2).
//
// The fs write guard and the shell sandbox refuse for the same reason — the
// effective mode does not permit this operation — but they used to say so in two
// unrelated ways: fs threw `FS_SANDBOX_DENIED` with a bare reason string, and the
// shell surfaced a provider-specific message. A model reading those had to learn
// two rules to notice "the sandbox said no" and two more to discover it could ask
// for more. This shape carries the surface, the mode IN FORCE FOR THAT CALL, the
// human reason, and (when one exists) the escalation route — so one rule covers
// every refusal.
//
// It lives in this package rather than sandbox-policy on purpose: the vocabulary
// it quotes (WIDER_MODES, ESCALATION_TARGETS, the denial/denial-hint markers) is
// already here, this package has no dependencies of its own, and the consumers
// that need the shape (fs, shell) would otherwise pull in the policy resolver's
// whole dependency floor for a type and a string.
export type SandboxSurface = "shell" | "fs" | "search" | "terminal"

export interface SandboxDenial {
  code: "SANDBOX_DENIED"
  surface: SandboxSurface
  mode: SandboxMode
  reason: string
  /** Present only when a strictly wider mode exists to ask for. */
  escalation?: string
}

export function denialFor(surface: SandboxSurface, mode: SandboxMode, reason: string): SandboxDenial {
  const wider = WIDER_MODES[mode]
  const out: SandboxDenial = { code: "SANDBOX_DENIED", surface, mode, reason }
  if (wider !== undefined && wider.length > 0) {
    out.escalation =
      `If this operation is genuinely required, retry it with sandbox_permissions set to "${wider[0]}" and a justification. ` +
      `That requests a wider mode for this call and may be approved.`
  }
  return out
}
