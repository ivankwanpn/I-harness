import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool } from "@i-harness/core-tools"
import type { ExecService } from "@i-harness/exec"
import { registerExec } from "@i-harness/exec"
import type { ResolvedAgentShell, ShellRetentionOptions } from "../types.ts"
import { capturedShell } from "../command/resolve.ts"
import { createShellTools } from "../index.ts"

export function registerShell(
  ctx: PluginContext,
  registry: { register(t: Tool): void },
  opts?: {
    wslShell?: ResolvedAgentShell
    agentShell?: () => ResolvedAgentShell
    timeoutMs?: number
    /** W10: the foreground promotion threshold, forwarded to both tools — see
     * ShellToolDeps.backgroundAfterMs. It MUST stay well under `timeoutMs`; the
     * assembly is the layer that knows both numbers and states the relation. */
    backgroundAfterMs?: number
    retention?: ShellRetentionOptions
    sandbox?: import("@i-harness/sandbox").SandboxProvider
    // M62: a resolver thunk passed straight through to the tools — see
    // ShellToolDeps.sandboxPolicy. The assembly hands over its per-call read.
    sandboxPolicy?: () => import("@i-harness/sandbox").SandboxExecutionPolicy | undefined
    // M62: the escalation approver, forwarded to `createShellTools` — see
    // ShellToolDeps.escalationApprover. Without this hop the ladder would be
    // unreachable at runtime while every type still checked.
    escalationApprover?: import("@i-harness/sandbox").EscalationApprover<unknown, string>
    /** D1 (m55): assembly workspace — the default cwd for bash/pwsh. */
    cwd?: string
  },
): void {
  // Assembly owns the service when supplied; standalone shell mounting composes
  // a local service bound to its configured workspace.
  let exec: ExecService
  try { exec = ctx.services.get<ExecService>("exec/service") }
  catch { exec = registerExec(ctx, { workspaceRoot: opts?.cwd ?? process.cwd(), sandbox: opts?.sandbox }) }
  const tools = createShellTools({
    exec,
    ...(opts?.wslShell ? { wslShell: capturedShell(opts.wslShell) } : {}),
    ...(opts?.agentShell !== undefined ? { agentShell: opts.agentShell } : {}),
    timeoutMs: opts?.timeoutMs,
    backgroundAfterMs: opts?.backgroundAfterMs,
    retention: opts?.retention,
    sandboxPolicy: opts?.sandboxPolicy,
    ...(opts?.escalationApprover !== undefined ? { escalationApprover: opts.escalationApprover } : {}),
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  for (const tool of tools) registry.register(tool)
  const selectedShell = tools.find((tool) => tool.name === "shell")
  if (selectedShell) {
    // Pin before any approval policy suspends the call. getArgv is otherwise
    // skipped by ask-all/delegate/full-access policies; execution still uses
    // the same argument object carried by core-tools prepare/dispatch.
    ctx.on("tools/pre-execute", (payload) => {
      const call = payload as { name?: string; args?: { command: string } }
      if (call?.name === "shell" && call.args && typeof call.args === "object") selectedShell.getArgv?.(call.args)
    })
  }
}
