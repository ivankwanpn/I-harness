import type { SandboxExecutionPolicy, SandboxMode } from "./index.ts"
import type { EscalationApprover, EscalationOutcome } from "./escalation.ts"
import { approveEscalation, validateEscalationArgs } from "./escalation.ts"
import type { SandboxDenial, SandboxSurface } from "./denial.ts"
import { denialFor } from "./denial.ts"

// The REQUEST side of the escalation ladder (spec §3.3(b)): the one place that
// answers "may THIS call run under a wider mode?" for every surface that declares
// `sandbox_permissions` / `justification`.
//
// It lives here, beside `denialFor`, for the reason §3.3 point 6 gives: `fs` and
// `shell` (and now the terminal) each compose their own per-call context -- only a
// tool body has the `ToolExec` a prompt must name -- but the decision itself must
// not be written three times with three drifting semantics. `@i-harness/sandbox`
// is the vocabulary package with no dependencies of its own, and `fs`/`shell`
// already depend on it for the refusal shape.
//
// THREE RULES, all of them learned the hard way:
//
// 1. NOTHING ESCAPES. `validateEscalationArgs` and `approveEscalation` throw on
//    every non-grant path, and a throwing tool body fails the whole turn and
//    appends no `tool/result` -- the model reads a hung call rather than an
//    answer (`packages/fs/src/error.ts:19-31` records the same rule for fs). So
//    `resolveCallPolicy` CATCHES and RETURNS; a refusal is a value.
// 2. A refusal of the REQUEST carries NO escalation guidance (spec §3.2
//    corollary 2). "Retry with sandbox_permissions" is advice for a refusal of
//    the OPERATION -- what the fs write guard and the terminal emit -- not for
//    "your pair was malformed", "no approval channel exists" or "the answer was
//    no". Every refusal below therefore passes `null` as the denial target.
//    That is not an oversight: no branch of this function can produce guidance,
//    because no branch of it judges an operation.
// 3. A grant is PER-CALL and TRANSIENT. Branch 7 copies the base policy with the
//    granted mode; it never mutates the base object, appends no `sandbox/mode`
//    event, and the session's standing mode never moves (spec §3.3 point 1 --
//    `EscalationOutcome` has a literal `"allowed-once"` for exactly this).

export type EscalationArgs = {
  sandbox_permissions?: string
  justification?: string
}

export type CallPolicyResolution =
  | { kind: "proceed"; policy: SandboxExecutionPolicy | undefined }
  | { kind: "refused"; denial: SandboxDenial }

/**
 * The shape of `approval/answerer` (packages/interaction/src/index.ts), named
 * STRUCTURALLY so this package never imports `@i-harness/interaction`.
 *
 * `ApprovalRequest` is `{ name, reason, command?, argv?, dangerClass?,
 * pathSummary? }`, so a function taking that richer object is assignable to this
 * one -- and the interaction seam already normalizes a host's `{ approved }` to a
 * bare boolean at the service boundary, so a truthy object cannot fail open.
 */
export type ApprovalPrompt = (req: { name: string; reason: string }) => Promise<boolean>

/**
 * Adapt the host's boolean approval answerer to the `EscalationApprover` the
 * ladder speaks (spec §3.3 point 2), mechanically:
 *
 * | answer            | outcome         |
 * |-------------------|-----------------|
 * | `true`            | `"allowed-once"`|
 * | `false`           | `"rejected"`    |
 * | service not there | `"unavailable"` |
 *
 * The third row is the point: a channel that does not exist must NEVER become a
 * silent allow. `ctx.services.get` throws for a name nobody registered, and the
 * getter is read lazily on EVERY request, so a host that registers its answerer
 * after the tools mount still works. The `catch` is here rather than in the
 * caller's lambda so no caller can forget it.
 */
export function createApprovalEscalationApprover(
  getAnswerer: () => ApprovalPrompt | undefined,
): EscalationApprover<unknown, string> {
  return {
    async request(req): Promise<EscalationOutcome> {
      let answerer: ApprovalPrompt | undefined
      try {
        answerer = getAnswerer()
      } catch {
        return "unavailable"
      }
      if (answerer === undefined) return "unavailable"
      const approved = await answerer({ name: req.toolName, reason: req.reason })
      // Only a literal `true` grants. interaction normalizes `{ approved }` at the
      // service boundary; this is the same guard one layer further in, for a host
      // that reached the service registry by another road.
      return approved === true ? "allowed-once" : "rejected"
    },
  }
}

/**
 * The ladder's per-call context. Composed by the TOOL BODY, not by the assembly:
 * the assembly runs at mount time and has no `ToolExec`, so a context built there
 * could not name the call the approval prompt is asking about. The deps carry the
 * `approver` (a pure function of the plugin context, built once); the tool adds
 * `agent` / `callId` / `toolName` per call.
 */
export interface EscalationContext {
  approver: EscalationApprover<unknown, string> | undefined
  agent: unknown
  callId: string
  toolName: string
  signal?: AbortSignal
}

/**
 * Resolve the policy THIS call runs under, asking for approval when the model
 * supplied `sandbox_permissions` + `justification`.
 *
 * SEVEN branches, in this order (the order is the contract):
 *
 * 1. malformed pair            -> REFUSED, mode reported as `base?.mode ?? "danger-full-access"`
 * 2. no escalation arguments   -> proceed with `base`
 * 3. `base === undefined`      -> proceed with `undefined`, args ignored (§3.3 point 5)
 * 4. base already unconfined   -> proceed with `base`, args vacuous (they are not WRONG;
 *                                 refusing them would regress a call that succeeds today)
 * 5. no approval channel       -> REFUSED (fail closed)
 * 6. not granted               -> REFUSED
 * 7. granted                   -> proceed with `{ ...base, mode: granted }`
 *
 * Branches 5 and 6 are one `try/catch` on purpose: they are distinguished by which
 * message `approveEscalation` throws, and both must return the same shape. Branch 5
 * is reachable because `approveEscalation` checks strictly-wider BEFORE
 * approver-missing, so a request that is not wider lands in branch 6 without ever
 * reaching the approver test.
 */
export async function resolveCallPolicy(input: {
  base: SandboxExecutionPolicy | undefined
  surface: SandboxSurface
  subject: string
  args: EscalationArgs
  escalation?: EscalationContext
}): Promise<CallPolicyResolution> {
  const { base, surface, subject, args } = input

  // Branch 2 -- neither argument present: an ordinary unescalated call. No
  // refusal, so no denial object at all.
  if (args.sandbox_permissions === undefined && args.justification === undefined) {
    return { kind: "proceed", policy: base }
  }

  // Branch 3 -- no policy at all. There is no mode to escalate FROM, and
  // `approveEscalation` requires a non-optional `effectiveMode`, so the request
  // cannot even be constructed. The call is already unrestricted (spec §3.3
  // point 5), and a host that requested no sandbox never emits a denial that
  // tells the model to escalate in the first place.
  if (base === undefined) return { kind: "proceed", policy: undefined }

  // Branch 4 -- the policy is already unconfined. The arguments are VACUOUS here,
  // not wrong: there is nothing to widen, and the only thing `approveEscalation`
  // could do with them is throw "not strictly wider" -- which would start
  // refusing a call that succeeds today on an unconfined host, for no security
  // benefit. A §3.2 denial only ever means "the mode in force does not permit
  // this operation".
  if (base.mode === "danger-full-access") return { kind: "proceed", policy: base }

  // Branch 1 -- malformed pair: one argument without the other, or an empty
  // justification. `validateEscalationArgs` throws; catch it and return. Its
  // message already says how to fix the request, so the refusal carries no
  // escalation guidance (§3.2 corollary 2).
  //
  // MOVED HERE, after branches 3 and 4, by the final review (Scope A, finding
  // A-3). It used to run FIRST, so a malformed pair turned a call that previously
  // succeeded into `SANDBOX_DENIED` on a host where nothing can refuse anything --
  // and reported it under a mode that is not in force as a refusal. That also
  // contradicted branches 3/4's own reasoning ("the args are vacuous, not wrong"):
  // a malformed pair is equally incapable of changing what THIS call may do, so it
  // is answered the same way. Validation still runs, and still refuses, wherever a
  // policy exists to refuse against -- which is the only place the request could
  // have had an effect. The `base` here is therefore always defined, which is why
  // the mode reported is `base.mode` rather than a `?? "danger-full-access"`
  // fallback that could only ever describe a host that cannot refuse.
  try {
    validateEscalationArgs(args.sandbox_permissions, args.justification)
  } catch (error) {
    return refuse(surface, base.mode, messageOf(error))
  }

  // Branches 5, 6 and 7. Past this point the pair is well-formed (branch 1) and at
  // least one argument is present (branch 2), so `validateEscalationArgs`'
  // invariant -- present together, justification non-empty -- makes both of them
  // strings. The assertion is not a cast of convenience: if the invariant ever
  // stopped holding, the `undefined` would reach `approveEscalation`, throw, and
  // land in the `catch` below -- still a refusal, never a grant.
  const escalation = input.escalation
  try {
    const granted: SandboxMode = await approveEscalation(
      {
        requestedMode: args.sandbox_permissions!,
        justification: args.justification!,
        effectiveMode: base.mode,
        subject,
      },
      {
        approver: escalation?.approver,
        agent: escalation?.agent,
        callId: escalation?.callId ?? "unknown",
        toolName: escalation?.toolName ?? surface,
        ...(escalation?.signal === undefined ? {} : { signal: escalation.signal }),
      },
    )
    // Branch 7 -- granted. A COPY with the granted mode: the base policy object is
    // untouched, so the standing mode never moves and no `sandbox/mode` event is
    // appended. The grant covers this one call.
    return { kind: "proceed", policy: { ...base, mode: granted } }
  } catch (error) {
    // Branches 5 and 6 -- no approval channel (no context, no approver, no agent to
    // route through) or not granted (rejected / cancelled / unavailable, or a mode
    // that is not strictly wider). All of them mean "the request could not be
    // honoured as asked", so none of them carries escalation guidance.
    return refuse(surface, base.mode, messageOf(error))
  }
}

/**
 * A refusal of the REQUEST, in the shared `SandboxDenial` shape.
 *
 * `null` as the escalation target is the whole reason `denialFor` learned to
 * express "no guidance": every caller of this helper is refusing the request, not
 * the operation, so "retry with sandbox_permissions" would be advice to send the
 * same thing again (§3.2 corollary 2).
 */
function refuse(surface: SandboxSurface, mode: SandboxMode, reason: string): CallPolicyResolution {
  return { kind: "refused", denial: denialFor(surface, mode, reason, null) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
