import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { derivePlanMode } from "@i-harness/core-session"
import type { SessionAssembly, SessionProjectContext } from "@i-harness/session-executor"
import type { AuthorityState } from "@i-harness/sandbox"

export interface ApprovalIdentitySources {
  plan: unknown; roles: unknown
}
export interface ApprovalIdentityOptions {
  workspace: string; sandbox: string; approval: string
  project: () => SessionProjectContext | undefined
  executionAuthority?: () => AuthorityState
  hookConfigs: readonly string[]; grantPaths: readonly string[]
  pluginAuthority: unknown
  hookAuthority?: () => unknown | undefined
}
/** Current host authority, synchronously reassessed both at prepare and dispatch. */
export function approvalPolicyIdentity(assembly: SessionAssembly, options: ApprovalIdentityOptions): { workspaceId: string; revision: string } | undefined {
  return approvalPolicyIdentityFromSources(() => ({ plan: derivePlanMode(assembly.session), roles: assembly.subagentState().roles }), options)
}

/** Values must come from the live original registry and metadata owners. */
export function approvalPolicyIdentityFromSources(sources: () => ApprovalIdentitySources, options: ApprovalIdentityOptions): { workspaceId: string; revision: string } | undefined {
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
    // Tool registration is validated by the prepared call's original binding.
    // Policy identity reads only the independent authority inputs below.
    const source = sources()
    const authority = {
      sandbox: options.sandbox, approval: options.approval, plan: source.plan,
      caller: { role: "main" },
      project: project ?? { roots: [options.workspace], primaryRoot: options.workspace },
      executionAuthority,
      roles: source.roles, plugins: options.pluginAuthority,
      hooks, grants: options.grantPaths.map(path => [path, optional(path)]),
    }
    return { workspaceId: options.workspace, revision: createHash("sha256").update(JSON.stringify(authority)).digest("hex") }
  } catch { return undefined }
}
