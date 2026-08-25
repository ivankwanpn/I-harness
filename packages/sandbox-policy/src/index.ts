import { resolve as resolvePath } from "node:path"
import type { SandboxExecutionPolicy, SandboxMode } from "@i-harness/sandbox"
import type { Session } from "@i-harness/core-session"
import { SANDBOX_MODES, effectiveSandboxMode } from "./session-mode.ts"

export { SANDBOX_MODES, effectiveSandboxMode }

export interface SandboxPolicyConfig {
  mode?: SandboxMode
  workspaceRoot?: string
}

export interface SandboxPolicyRequest {
  session?: Session
  mode?: SandboxMode
  workspaceRoot?: string
}

export interface SandboxPolicyService {
  defaultMode: SandboxMode
  workspaceRoot: string
  resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy
}

export function createSandboxPolicy(config: SandboxPolicyConfig = {}): SandboxPolicyService {
  const defaultMode = config.mode ?? "read-only"
  const workspaceRoot = resolvePath(config.workspaceRoot ?? process.cwd())
  return {
    defaultMode,
    workspaceRoot,
    resolve(request = {}) {
      const sessionOverride = request.session === undefined ? undefined : effectiveSandboxMode(request.session.events)
      return {
        mode: request.mode ?? sessionOverride ?? defaultMode,
        workspaceRoot: resolvePath(request.workspaceRoot ?? workspaceRoot),
      }
    },
  }
}

export function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case "read-only":
      return "Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns."
    case "workspace-write":
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case "danger-full-access":
      return "Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations."
    default:
      return ""
  }
}
