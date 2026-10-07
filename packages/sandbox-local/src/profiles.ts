import { workspaceRoots, type SandboxPolicy } from "@i-harness/sandbox"
import { spawnSync } from "node:child_process"

export const BWRAP_DENIAL_SIGNATURES = Object.freeze(["read-only file system"])
export const BWRAP_RUNNER_FAILURE_RULES = Object.freeze([
  Object.freeze({ allowedExitCodes: Object.freeze([125]), fatalSignatures: Object.freeze(["bwrap: failed to"]) }),
])

export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"]
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp")
    for (const root of workspaceRoots(policy)) args.push("--bind", root, root)
  }
  return args
}

export function probeBwrap(timeoutMs?: number): boolean {
  const probe = spawnSync("bwrap", [...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "true"], {
    timeout: timeoutMs ?? 5000, stdio: "ignore",
  })
  return probe.status === 0
}
