import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { derivePlanMode } from "@i-harness/core-session"
import type { SessionAssembly, SessionProjectContext } from "@i-harness/session-executor"

/** Current host authority, synchronously reassessed both at prepare and dispatch. */
export function approvalPolicyIdentity(assembly: SessionAssembly, options: {
  workspace: string; sandbox: string; approval: string
  project: () => SessionProjectContext | undefined
  hookConfigs: readonly string[]; grantPaths: readonly string[]
  pluginAuthority: unknown
}): { workspaceId: string; revision: string } | undefined {
  try {
    const optional = (path: string) => {
      try { return readFileSync(path, "utf8") }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
    }
    const hooks = options.hookConfigs.map(path => {
      const body = readFileSync(path, "utf8")
      const config = JSON.parse(body) as { handlers?: { trust?: { script?: string } }[] }
      if (!Array.isArray(config.handlers)) throw new Error("Opaque Hook authority")
      return [path, body, config.handlers.map(handler => {
        if (typeof handler.trust?.script !== "string") throw new Error("Opaque Hook script")
        const script = resolve(dirname(path), handler.trust.script)
        return [script, createHash("sha256").update(readFileSync(script)).digest("hex")]
      })]
    })
    const project = options.project()
    // Model-facing schema projection is a read; its live presentation metadata
    // is separate from the owned registry catalog fingerprinted below.
    const modelTools = assembly.executionState?.()
    const authority = {
      sandbox: options.sandbox, approval: options.approval, plan: derivePlanMode(assembly.session),
      caller: { role: "main" },
      project: project ?? { roots: [options.workspace], primaryRoot: options.workspace },
      roles: assembly.subagentState().roles, catalog: assembly.tools.genToolCatalog(), deferred: assembly.tools.deferredSearchIndex(),
      modelTools, plugins: options.pluginAuthority,
      mcp: [...assembly.pluginMcpResults], agents: [...assembly.pluginAgentResults],
      hooks, grants: options.grantPaths.map(path => [path, optional(path)]),
    }
    return { workspaceId: options.workspace, revision: createHash("sha256").update(JSON.stringify(authority)).digest("hex") }
  } catch { return undefined }
}
