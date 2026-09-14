import type { SandboxMode } from "./index.ts"
import { WIDER_MODES } from "./escalation.ts"

// The refusal shape the confined surfaces are meant to report (spec §3.2).
//
// The fs write guard and the shell sandbox refuse for the same reason — the
// effective mode does not permit this operation — but they said so in two
// unrelated ways: fs threw `FS_SANDBOX_DENIED` with a bare reason string, and the
// shell surfaced `SandboxUnavailableError` from exec. A model reading those had to
// learn two rules to notice "the sandbox said no" and two more to discover it
// could ask for more. This shape carries the surface, the mode IN FORCE FOR THAT
// CALL, the human reason, and (when one exists) the escalation route, so ONE rule
// can cover a refusal from any of them.
//
// WHAT IS ACTUALLY WIRED TODAY: `denialFor`'s only production caller is the
// assembly's write guard, which passes "fs" — so fs is the only surface emitting
// this object, and the shell still refuses the old way. The other `SandboxSurface`
// values are declared for the conversions that have not happened, deliberately, so
// the shape is not re-invented per surface. Task 3 (escalation arguments) does not
// change this; do not read this file as evidence that a model already meets the
// same object on both surfaces.
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

/**
 * `escalationTarget` is the narrowest mode in which THIS operation would be
 * PERMITTED — NOT merely a mode wider than the one in force. The two coincide for
 * a THRESHOLD-shaped refusal (fs, shell): there a wider mode is precisely what
 * the operation needs, so the default (the first strictly-wider mode) is right.
 * They do NOT coincide for a surface that refuses in EVERY confined mode: the
 * terminal cannot be kernel-confined at all, so from read-only the default
 * ("workspace-write") is a target that refuses identically, and the advice sends
 * the model to a retry that cannot work. Callers in that position name the
 * sufficient mode; omitting the argument keeps the previous behaviour exactly.
 */
export function denialFor(
  surface: SandboxSurface,
  mode: SandboxMode,
  reason: string,
  escalationTarget?: SandboxMode,
): SandboxDenial {
  const target = escalationTarget ?? WIDER_MODES[mode]?.[0]
  const out: SandboxDenial = { code: "SANDBOX_DENIED", surface, mode, reason }
  if (target !== undefined) {
    out.escalation =
      `If this operation is genuinely required, retry it with sandbox_permissions set to "${target}" and a justification. ` +
      `That requests a wider mode for this call and may be approved.`
  }
  return out
}
