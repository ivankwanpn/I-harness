import type { Tool } from "@i-harness/core-tools"
import { userSteerForTool } from "@i-harness/core-tools"
import { SandboxUnavailableError } from "@i-harness/sandbox"
import type { ResolvedAgentShell, ShellToolDeps } from "../types.ts"
import { capturedShell, agentShellPrompt, shellFlags, boundShellEnvironment } from "../command/resolve.ts"
import { getAgentArgv } from "../command/argv.ts"
import type { VersionIdentity } from "../command/identity.ts"
import { sandboxUnavailableFailure, type ResolveShellCall } from "./policy.ts"
import { promotedResult } from "./background.ts"
import type { RetainedRunResult } from "./retention.ts"

type SelectedDeps = Pick<ShellToolDeps, "agentShell" | "exec" | "cwd" | "backgroundAfterMs" | "timeoutMs">

export function createSelectedShellTool(deps: SelectedDeps, bash: Tool, versionIdentity: VersionIdentity, retainedRunResult: RetainedRunResult, resolveCall: ResolveShellCall): Tool {
  type Args = { command: string; background?: boolean; sandbox_permissions?: string; justification?: string }
  type Binding = { shell: ResolvedAgentShell } | { error: string }
  const bindings = new WeakMap<Args, Binding>()
  function bindingFor(args: Args): Binding {
    const existing = bindings.get(args)
    if (existing) return existing
    let binding: Binding
    try { binding = { shell: capturedShell(deps.agentShell!()) } }
    catch (error) { binding = { error: error instanceof Error ? error.message : String(error) } }
    bindings.set(args, binding)
    return binding
  }
  const shell: Tool<Args> = {
    name: "shell",
    get description() {
      try { return `Run a command in the selected Agent Shell. ${agentShellPrompt(deps.agentShell!())} background: true returns a job id.` }
      catch (error) { return `The selected Agent Shell is unavailable: ${error instanceof Error ? error.message : String(error)}. Change Agent Shell in settings before executing commands.` }
    },
    inputSchema: bash.inputSchema,
    timeoutMs: deps.timeoutMs,
    commandDialect: (args) => {
      const binding = bindingFor(args)
      return "error" in binding ? undefined : binding.shell.dialect
    },
    getArgv: (args) => {
      const binding = bindingFor(args)
      return "error" in binding ? [] : getAgentArgv(args.command, binding.shell.dialect)
    },
    approvalIdentity: (args) => {
      const binding = bindingFor(args)
      return "error" in binding || binding.shell.executionTarget === "wsl" ? undefined : versionIdentity(args, binding.shell.command, binding.shell.dialect)
    },
    execute: async (args, exec) => {
      const binding = bindingFor(args)
      bindings.delete(args)
      if ("error" in binding) return { stdout: "", stderr: binding.error, exitCode: -1 }
      const selected = binding.shell
      try { selected.validate?.() }
      catch (error) { return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: -1 } }
      const flags = shellFlags(selected)
      const argv = [selected.command, ...flags, selected.dialect === "cmd" ? `"${args.command}"` : args.command]
      const ladder = await resolveCall("shell", exec, args, `run ${selected.label} command ${args.command.slice(0, 2048)}${args.command.length > 2048 ? "… [truncated]" : ""}${selected.executionContext ? `; target ${selected.executionTarget}, captured options ${selected.executionContext}` : ""}`)
      if (ladder.kind === "refused") return ladder.refusal
      const sandbox = ladder.policy
      const spec = { argv, ...boundShellEnvironment(selected), ...(selected.dialect === "cmd" ? { windowsVerbatimArguments: true } : {}), ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}), ...(sandbox !== undefined ? { sandbox } : {}) }
      try {
        if (args.background === true) return { job_id: (await deps.exec.runBackground(spec)).jobId }
        const command = { ...spec, abortSignal: exec.abortSignal }
        const backgroundAfterMs = deps.backgroundAfterMs
        const promotionWake = userSteerForTool(exec)
        const runOptions = {
          ...(backgroundAfterMs === undefined ? {} : { backgroundAfterMs }),
          ...(promotionWake === undefined ? {} : { promotionWake }),
        }
        const result = await deps.exec.run(command, runOptions)
        return "promoted" in result ? promotedResult(result, "shell", deps.timeoutMs) : retainedRunResult(result, "shell-stdout")
      } catch (error) {
        if (error instanceof SandboxUnavailableError) return sandboxUnavailableFailure("shell", "shell", sandbox, error.kind, error.detail ?? error.message)
        throw error
      }
    },
  }
  return shell
}
