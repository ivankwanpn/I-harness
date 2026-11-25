import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import type { AuthorityState } from "./execution.ts"
import type { SandboxExecutionPolicy } from "./index.ts"

// Single home for the workspace-write meaning so the profile dialects and any
// in-process fence can never drift apart.
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== "workspace-write") return []
  return [...new Set([...workspaceRoots(policy), "/tmp", tmpdir()].map(canonicalPath))]
}

/** Every project folder for this call, without retaining a previous call's roots. */
export function workspaceRoots(policy: SandboxExecutionPolicy): string[] {
  return [...new Set([policy.workspaceRoot, ...(policy.workspaceRoots ?? [])].map(canonicalPath))]
}

/** Keep the stored directory while WSL can start inside the current project. */
export function resolveWslWorkingDirectory(workspace: string, authority: AuthorityState): string {
  if (authority.kind === "revoked" || authority.kind === "unavailable") throw new Error(`Execution authority ${authority.kind}: ${authority.reason}`)
  if (authority.kind === "unbound" || authority.roots.some(root => {
    const path = relative(root, workspace)
    return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
  })) return workspace
  const { primaryRoot, roots } = authority
  if (!isAbsolute(primaryRoot) || !roots.some(root => isAbsolute(root) && relative(root, primaryRoot) === "")) {
    throw new Error("Original WSL project working directory unavailable")
  }
  return primaryRoot
}
