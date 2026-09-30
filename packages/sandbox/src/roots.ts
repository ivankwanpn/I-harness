import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
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
