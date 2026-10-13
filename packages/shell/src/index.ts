import type { Tool } from "@i-harness/core-tools"
import type { ShellToolDeps } from "./types.ts"
import { createVersionIdentity } from "./command/identity.ts"
import { createResultRetention } from "./tools/retention.ts"
import { createNativeShellTools } from "./tools/foreground.ts"
import { createSelectedShellTool } from "./tools/selected.ts"
import { resolveShellCall } from "./tools/policy.ts"

export type { ResolvedShell, ResolvedAgentShell, ShellRetentionOptions, ShellToolDeps } from "./types.ts"
export { resolveWslAgentShell, agentShellPrompt, resolveShell } from "./command/resolve.ts"
export { powerShellExecutableAvailable, bashAvailable, resolvePwshExe } from "./discovery/windows.ts"
export { getArgv } from "./command/argv.ts"
export { registerShell } from "./tools/registration.ts"

export function createShellTools(deps: ShellToolDeps): Tool[] {
  const versionIdentity = createVersionIdentity(deps)
  const bashBindings = new WeakMap<object, string>()
  const retainedRunResult = createResultRetention(deps)
  // Keep dependency reads lazy and retain their receiver across policy awaits.
  const resolveCall: import("./tools/policy.ts").ResolveShellCall = (tool, exec, args, subject) => resolveShellCall(deps, exec, tool, args, subject)
  const [bash, pwsh] = createNativeShellTools(deps, bashBindings, versionIdentity, retainedRunResult, resolveCall)
  if (!deps.agentShell) return [bash, pwsh]
  const shell = createSelectedShellTool(deps, bash, versionIdentity, retainedRunResult, resolveCall)
  return [bash, pwsh, shell]
}
