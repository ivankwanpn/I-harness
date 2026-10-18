import type { ExecutionOwner } from "@i-harness/sandbox"
import { createLocalExecutionBackends } from "@i-harness/sandbox-local"
import { assertExecutionAuthority, compileExecutionPolicy } from "@i-harness/sandbox-policy"
import type { ExecExecutionHost } from "./index.ts"

export function defaultHost(workspaceRoot: string, legacyArgvProvider = false, owner: Readonly<ExecutionOwner> = { sessionId: "standalone-exec" }): ExecExecutionHost {
  const configured = process.env.IH_WINDOWS_SANDBOX ?? "legacy"
  if (configured !== "legacy" && configured !== "psec" && configured !== "wsl") throw new Error("IH_WINDOWS_SANDBOX requires legacy, psec or wsl")
  const network = process.env.IH_WSL_NETWORK
  if (network !== undefined && network !== "allow" && network !== "deny") throw new Error("IH_WSL_NETWORK requires allow or deny")
  const backends = createLocalExecutionBackends({ windowsSelection: configured, wslExecution: {
    distribution: process.env.IH_WSL_DISTRIBUTION ?? "Ubuntu", networkAccess: process.env.IH_WSL_NETWORK === "allow", workspaceDependencies: true,
  } })
  const authority = Object.freeze({ kind: "unbound" as const, revision: "standalone-workspace", workspaceRoot })
  return {
    defaultOwner: Object.freeze({ sessionId: owner.sessionId, ...(owner.parentSessionId === undefined ? {} : { parentSessionId: owner.parentSessionId }) }),
    selectBackend: (policy, transport, spec) => {
      if (legacyArgvProvider && policy.mode !== "danger-full-access") {
        throw new Error("argv-only sandbox provider cannot own a supervised process; compose a transport backend")
      }
      return backends.select(policy, transport, spec)
    },
    resolvePolicy: (owner, requested) => compileExecutionPolicy({ mode: requested?.mode ?? "danger-full-access", owner, authority }),
    validateAuthority: policy => assertExecutionAuthority(policy, compileExecutionPolicy({ mode: policy.mode, owner: policy.owner, authority })),
    dispose: () => backends.dispose(),
  }
}
