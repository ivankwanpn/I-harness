import type { ToolExec } from "@i-harness/core-tools"
import type { EscalationContext, SandboxDenial, SandboxExecutionPolicy, SandboxSurface, SandboxUnavailableKind } from "@i-harness/sandbox"
import { denialFor, resolveCallPolicy } from "@i-harness/sandbox"
import type { ShellToolDeps } from "../types.ts"

type PolicyDeps = Pick<ShellToolDeps, "escalationApprover" | "sandboxPolicy">

/**
 * M62: the escalation ladder for the shell surface — the SAME per-call decision
 * fs and the terminal make, in the one place that knows how a shell refusal is
 * delivered.
 *
 * A refusal is a VALUE, never a throw: a throwing tool body fails the whole turn
 * and appends no `tool/result` (`packages/fs/src/error.ts:19-31` records the same
 * rule), so the model would read a hung call instead of an answer.
 *
 * It is returned HERE, as the ladder built it, and NOT through
 * `sandboxUnavailableFailure`: that helper answers a different question (no
 * backend exists for ANY mode), so routing this denial through it would answer
 * with the wrong reason. Every ladder refusal withholds its escalation sentence
 * by construction (`escalationTarget: null` in branches 1/5/6), which is exactly
 * why the denial must not be rebuilt by a helper that has its own.
 *
 * `stderr` carries the JSON denial because that is the field this surface's
 * refusals already use (see `sandboxUnavailableFailure`), and the shell tool's
 * declared output has no `error`/`denial` slot.
 */
export async function resolveShellCall(
  deps: PolicyDeps,
  exec: ToolExec,
  toolName: "bash" | "pwsh" | "shell",
  args: { sandbox_permissions?: string; justification?: string },
  subject: string,
): Promise<
  | { kind: "proceed"; policy: SandboxExecutionPolicy | undefined }
  | { kind: "refused"; refusal: { stdout: string; stderr: string; exitCode: number } }
> {
  const escalation = deps.escalationApprover === undefined
    ? undefined
    : {
        approver: deps.escalationApprover,
        agent: exec,
        callId: exec.callId ?? "unknown",
        toolName,
        ...(exec.abortSignal !== undefined ? { signal: exec.abortSignal } : {}),
      } satisfies EscalationContext
  const resolution = await resolveCallPolicy({
    base: deps.sandboxPolicy?.(),
    surface: "shell",
    subject,
    args,
    ...(escalation !== undefined ? { escalation } : {}),
  })
  if (resolution.kind === "refused") {
    return { kind: "refused", refusal: { stdout: "", stderr: JSON.stringify(resolution.denial), exitCode: -1 } }
  }
  // The GRANTED policy when an escalation was approved, the session's otherwise.
  // Re-reading `deps.sandboxPolicy?.()` here would refuse the very call the user
  // just approved.
  return { kind: "proceed", policy: resolution.policy }
}

/**
 * M62 Task 3 (Step 7): a REFUSAL the model can read, not a turn that dies.
 *
 * `exec`'s `resolveArgv` throws `SandboxUnavailableError` synchronously — from
 * `run` (either overload: there is ONE implementation behind them, so W10's
 * promotion cannot diverge here) and from `runBackground`, both through
 * `spawnChild` — when a confined policy reaches it with no provider composed.
 * (Named by SYMBOL, not by line number: W10 moved every line in that file, and
 * the shell test's own note records the same lesson.) A throwing tool
 * body fails the whole turn and appends no `tool/result`, so ONE bash call ended
 * the turn and the model never learned why. The bash-absent branch below already
 * returns a legible failure for the same class of fact ("this host cannot run
 * what you asked"), and so does this one.
 *
 * WHAT IT MUST NOT DO.
 *
 * 1. It must never carry escalation guidance when the reason is `no-backend`:
 *    there NO backend is usable for ANY mode, so sending the model after a wider
 *    one points it at a request that cannot help. That denial is constructed
 *    literally, and the shared thing is the TYPE (`SandboxDenial`), which is what
 *    the Task 2 corrections settled on. The OTHER reason, `command-not-run`, is
 *    the opposite fact and takes the opposite advice — see the branch below.
 * 2. It must never fall back to running the command unconfined. Refusing is the
 *    whole point; the confinement boundary is `exec` failing closed, and
 *    swallowing the throw into a spawn would be strictly worse than the crash.
 *
 * `policy` is the policy THIS call handed to exec (the `mode` the model is told
 * about); the fallback only covers the theoretical case where the thunk returns
 * nothing after the throwing call already read a confined policy. `kind` and
 * `detail` come from the `SandboxUnavailableError` itself, and `kind` is what
 * decides which of the two facts this refusal is reporting.
 */
export function sandboxUnavailableFailure(
  tool: "bash" | "pwsh" | "shell",
  surface: SandboxSurface,
  policy: SandboxExecutionPolicy | undefined,
  kind: SandboxUnavailableKind = "no-backend",
  detail = "",
): { stdout: string; stderr: string; exitCode: number } {
  // A backend that EXISTS and merely could not run THIS program is a different
  // fact from "no backend exists", and it takes the opposite advice. Measured on
  // this host: a confined native cmd.exe / node.exe / git.exe all exit 0, so the
  // sentence at the bottom of this function would be false — while
  // `danger-full-access` is exactly what runs the program. Every CONFINED mode
  // refuses such a program (Git Bash dies identically under read-only and under
  // workspace-write), so the mode worth naming is the unconfined one:
  // `denialFor`'s first-wider-mode default would name a mode that refuses
  // identically, which is advice the model cannot act on.
  if (kind === "command-not-run") {
    const mode = policy?.mode ?? "read-only"
    return {
      stdout: "",
      stderr: JSON.stringify(denialFor(
        surface,
        mode,
        `the ${mode} sandbox could not run this ${tool} command, so it was not run unconfined: ${detail}`,
        "danger-full-access",
      )),
      exitCode: -1,
    }
  }
  const denial: SandboxDenial = {
    code: "SANDBOX_DENIED",
    surface,
    mode: policy?.mode ?? "read-only",
    reason:
      "no sandbox backend is usable on this host, so the confined mode in force cannot be enforced: " +
      `refusing to run the ${tool} command unconfined. Asking for a wider mode cannot help — no backend ` +
      "exists for any mode here. Use a file tool for a file operation, or ask the host to compose a sandbox.",
  }
  // exitCode -1 mirrors the bash-absent branch at each call site: -1 means "this
  // host could not run it", never "it ran and failed".
  return { stdout: "", stderr: JSON.stringify(denial), exitCode: -1 }
}


export type ResolveShellCall = (tool: "bash" | "pwsh" | "shell", exec: ToolExec, args: { sandbox_permissions?: string; justification?: string }, subject: string) => ReturnType<typeof resolveShellCall>
