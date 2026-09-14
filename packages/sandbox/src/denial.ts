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
// WHAT IS ACTUALLY WIRED TODAY. Rewritten 2026-09-15: the previous version said
// `denialFor`'s only production caller is the assembly's write guard, that fs was
// therefore the only surface emitting this object, that the shell "still refuses
// the old way", and that Task 3 did not change any of it. Every one of those
// clauses had become false. Two questions are easy to conflate here, so keep them
// apart:
//
// 1. WHO CALLS `denialFor` — TWO production callers, not one:
//    `packages/session-executor/src/assembly.ts` (the write guard, surface "fs")
//    and `packages/terminal/src/tool.ts` (surface "terminal", which names
//    `danger-full-access` explicitly because a PTY is refused in EVERY confined
//    mode, so the first-wider-mode default would be unactionable advice).
// 2. WHO EMITS THIS SHAPE — those two, PLUS the shell, which builds a
//    `SandboxDenial` literal by hand (`packages/shell/src/index.ts`). That literal
//    is a DELIBERATE divergence, not a conversion that has not happened yet: there
//    the problem is that no sandbox backend is usable at all, not that the mode is
//    narrow, so escalation guidance would send the model after a request that
//    cannot help. `null` as `escalationTarget` exists below so that intent can be
//    expressed THROUGH `denialFor` instead of beside it.
//
// "search" is the one surface declared but unwired, deliberately: ripgrep has no
// file-writing flag, so confining fs-search would confine nothing while turning
// two working read-only tools into failures (spec §3.4). It is declared here so
// the shape is not re-invented per surface.
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
 *
 * `null` means THIS REFUSAL CARRIES NO ESCALATION GUIDANCE — the request itself
 * was wrong (a malformed argument pair, no approval channel, a rejected answer, a
 * mode that is not strictly wider), so telling the model to retry with
 * `sandbox_permissions` would be telling it to repeat the mistake
 * (spec §3.2 corollary 2). Without this a caller that needs "no guidance" has no
 * way to say so and hand-builds the object instead, which is how the shell's
 * duplicate came about.
 *
 * An EXPLICIT target is advertised only when it is STRICTLY wider than `mode` —
 * the predicate `approveEscalation` itself uses (`escalation.ts:61`). A target the
 * current mode would refuse again is advice the model cannot act on, so it is
 * treated as no route at all rather than printed.
 */
export function denialFor(
  surface: SandboxSurface,
  mode: SandboxMode,
  reason: string,
  escalationTarget?: SandboxMode | null,
): SandboxDenial {
  const out: SandboxDenial = { code: "SANDBOX_DENIED", surface, mode, reason }
  let target: SandboxMode | undefined
  if (escalationTarget === null) {
    target = undefined
  } else if (escalationTarget === undefined) {
    target = WIDER_MODES[mode]?.[0]
  } else {
    target = (WIDER_MODES[mode] ?? []).includes(escalationTarget) ? escalationTarget : undefined
  }
  if (target !== undefined) {
    out.escalation =
      `If this operation is genuinely required, retry it with sandbox_permissions set to "${target}" and a justification. ` +
      `That requests a wider mode for this call and may be approved.`
  }
  return out
}
