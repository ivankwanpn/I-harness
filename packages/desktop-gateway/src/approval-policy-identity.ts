import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { derivePlanMode } from "@i-harness/core-session"
import type { SessionAssembly, SessionProjectContext } from "@i-harness/session-executor"
import type { AuthorityState } from "@i-harness/sandbox"

/** Current host authority, synchronously reassessed both at prepare and dispatch. */
export function approvalPolicyIdentity(assembly: SessionAssembly, options: {
  workspace: string; sandbox: string; approval: string
  project: () => SessionProjectContext | undefined
  executionAuthority?: () => AuthorityState
  hookConfigs: readonly string[]; grantPaths: readonly string[]
  pluginAuthority: unknown
  /** Snapshot from the mounted HookRegistry's normalized handlers and artifacts. */
  hookAuthority?: () => unknown | undefined
}): { workspaceId: string; revision: string } | undefined {
  try {
    const optional = (path: string) => {
      try { return readFileSync(path, "utf8") }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
    }
    const hooks = options.hookConfigs.length === 0 ? [] : options.hookAuthority?.()
    if (hooks === undefined) throw new Error("Mounted Hook authority unavailable")
    const project = options.project()
    const executionAuthority = options.executionAuthority?.()
    if (executionAuthority?.kind === "revoked" || executionAuthority?.kind === "unavailable") return undefined
    // Model-facing schema projection is a read; its live presentation metadata
    // is separate from the owned registry catalog fingerprinted below.
    const modelTools = assembly.executionState?.()
    const authority = {
      sandbox: options.sandbox, approval: options.approval, plan: derivePlanMode(assembly.session),
      caller: { role: "main" },
      project: project ?? { roots: [options.workspace], primaryRoot: options.workspace },
      executionAuthority,
      roles: assembly.subagentState().roles, catalog: assembly.tools.genToolCatalog(), deferred: assembly.tools.deferredSearchIndex(),
      modelTools, plugins: options.pluginAuthority,
      mcp: [...assembly.pluginMcpResults], agents: [...assembly.pluginAgentResults],
      hooks, grants: options.grantPaths.map(path => [path, optional(path)]),
    }
    return { workspaceId: options.workspace, revision: createHash("sha256").update(JSON.stringify(authority)).digest("hex") }
  } catch { return undefined }
}
