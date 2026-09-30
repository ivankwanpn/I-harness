import { workspaceRoots, type SandboxPolicy } from "@i-harness/sandbox"

export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"]
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp")
    for (const root of workspaceRoots(policy)) args.push("--bind", root, root)
  }
  return args
}
