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
  return [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))]
}
