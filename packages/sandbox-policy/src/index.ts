import { resolve as resolvePath } from "node:path"
import { workspaceRoots as projectRoots, type SandboxExecutionPolicy, type SandboxMode } from "@i-harness/sandbox"
import type { Session } from "@i-harness/core-session"
import { SANDBOX_MODES, effectiveSandboxMode } from "./session-mode.ts"

export { SANDBOX_MODES, effectiveSandboxMode }
export { compileExecutionPolicy, assertExecutionAuthority } from "./execution-policy.ts"
export { checkWrite, realTarget, type PathDecision } from "./paths.ts"

export interface SandboxPolicyConfig {
  mode?: SandboxMode
  workspaceRoot?: string
  workspaceRoots?: readonly string[]
}

export interface SandboxPolicyRequest {
  session?: Session
  mode?: SandboxMode
  workspaceRoot?: string
  workspaceRoots?: readonly string[]
}

export interface SandboxPolicyService {
  defaultMode: SandboxMode
  workspaceRoot: string
  workspaceRoots?: readonly string[]
  resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy
}

export function createSandboxPolicy(config: SandboxPolicyConfig = {}): SandboxPolicyService {
  const defaultMode = config.mode ?? "read-only"
  const workspaceRoot = resolvePath(config.workspaceRoot ?? process.cwd())
  const configuredRoots = config.workspaceRoots === undefined ? undefined : projectRoots({ mode: defaultMode, workspaceRoot, workspaceRoots: config.workspaceRoots.map((root) => resolvePath(root)) })
  return {
    defaultMode,
    workspaceRoot,
    ...(configuredRoots === undefined ? {} : { workspaceRoots: [...configuredRoots] }),
    resolve(request = {}) {
      const sessionOverride = request.session === undefined ? undefined : effectiveSandboxMode(request.session.events)
      const root = resolvePath(request.workspaceRoot ?? workspaceRoot)
      const roots = request.workspaceRoots ?? (root === workspaceRoot ? configuredRoots : undefined)
      return {
        mode: request.mode ?? sessionOverride ?? defaultMode,
        workspaceRoot: root,
        ...(roots === undefined ? {} : { workspaceRoots: projectRoots({ mode: defaultMode, workspaceRoot: root, workspaceRoots: roots.map((path) => resolvePath(path)) }) }),
      }
    },
  }
}

export function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  // M62 Task 3 (Step 6): this fragment is rendered into THIS harness's own system
  // prompt, one line after DEFAULT_AGENT_PRESET's "You are I-harness"
  // (packages/preset/src/default.ts:14). It said "Current DSH file policy" — a
  // different product's name — in the same prompt. Pinned by
  // test/policy.test.ts ("names THIS harness, not another product").
  switch (policy.mode) {
    case "read-only":
      return "Current I-harness file policy: read-only. Any available operation enforced by the I-harness file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns."
    case "workspace-write":
      return `Current I-harness file policy: workspace-write. Any available operation enforced by the I-harness file sandbox may modify files under the session workspace roots: ${JSON.stringify(projectRoots(policy))}. Some platform temporary areas may also be writable.`
    case "danger-full-access":
      return "Current I-harness file policy: danger-full-access. The I-harness file sandbox does not restrict file modifications by available operations."
    default:
      return ""
  }
}
