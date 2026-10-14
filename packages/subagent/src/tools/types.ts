import type { PluginContext } from "@i-harness/core-plugin"
import type { createSession } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { ExecService } from "@i-harness/exec"
import type { WorkflowExecutor } from "@i-harness/workflow"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { JobRegistry } from "../jobs.ts"
import type { AgentTable } from "../agent-table.ts"
import type { RoleRegistry } from "../roles.ts"
import type { RoleModelHost, RoleModelSelection, RoleModelState } from "../child.ts"
import type { TaskRegistry } from "../task-protocol.ts"
import type { ReportPolicy } from "../report-policy.ts"

export interface SubagentToolDeps extends RoleModelHost {
  reportPolicy?: ReportPolicy
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  parentModel: ModelClient
  /** Resolve a selection to a live client through the HOST's provider plane —
   * the same one the session's own model went through, so a role gets the same
   * credentials, the same card table and the same protocol chain.
   *
   * It replaced a `ProviderRegistry` that `assembly.ts` built empty and nothing
   * ever registered into, which made `role.model` throw `references unknown
   * provider` for every value it could ever hold. */
  resolveModel(selection: RoleModelSelection): Promise<RoleModelState>
  exec: ExecService
  // M9: live Agent instances retained for the child's session id, enabling
  // followup re-drives (Task 3) without re-creating the agent.
  agents: AgentRegistry
  // M8: when present, spawned children get durable child-<uuid> sessions with
  // the parent-session lineage header (P1).
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  // M24a (B2): max subagent nesting depth for spawn_agent — a caller whose
  // session header records delegationDepth >= maxDepth is rejected. Default 1
  // (zero behavior change: top-level callers are depth 0 and can spawn, but
  // subagents cannot nest) — only a host that raises maxDepth enables nesting.
  maxDepth?: number
  // M24b (spec §3.3): the workflow executor whose job store backs the job_*
  // third layer. Optional — absent = current behavior. When present, a
  // `workflow-` prefixed job id routes to it (getOutput/listJobs/killJob)
  // instead of falling through to the exec bridge.
  workflow?: WorkflowExecutor
  // M26-D1: the durable task protocol registry — spawn_agent submissions go
  // through it (identity-keyed submit/claim/terminalize; cancelTree/wait read it).
  tasks: TaskRegistry
  // W12: the bound on the `background: false` settle-wait. Absent = 300_000 (the
  // shipped behavior; no host passes it). The wait observes settlement up to this
  // deadline, so this is what lets a test drive a genuine timeout through the
  // real registry instead of pinning the timeout arm's shape with a mock.
  foregroundWaitMs?: number
}
