import type { PluginContext } from "@i-harness/core-plugin"
import type { SessionView } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { JobRegistry } from "../jobs.ts"
import type { AgentTable } from "../agent-table.ts"
import type { SubagentRole } from "../roles.ts"
import type { RoleModelHost, RoleModelSelection, RoleModelState } from "./model-binding.ts"

export interface SpawnOptions extends RoleModelHost {
  /** Parent-owned approval exception, never normal child allowance. */
  sharedGeneration?: import('@i-harness/llm-seam').ApprovalGenerationAction
  signal?: AbortSignal
  taskName: string
  message: string
  parentPath: string
  parentRegistry: ToolRegistry
  parentSession: SessionView
  parentCtx: PluginContext
  role: SubagentRole
  parentModel: ModelClient
  /** Resolve a selection to a live client through the HOST's provider plane —
   * the same one the session's own model went through, so a role gets the same
   * credentials, the same card table and the same protocol chain.
   *
   * It replaced a `ProviderRegistry` that `assembly.ts` built empty and nothing
   * ever registered into, which made `role.model` throw `references unknown
   * provider` for every value it could ever hold. */
  resolveModel(selection: RoleModelSelection): Promise<RoleModelState>
  jobs: JobRegistry
  table: AgentTable
  agents: AgentRegistry
  forkTurns?: "none" | "all" | number
  // M8: when present, the child session is durable — minted as child-<uuid>,
  // created through the coordinator with the lineage header, and mirrored to
  // the parent's write-behind coordinator.
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string; origin?: "approval-review" }
  // M26-D1: settle callback — fires once when the initial run settles (the
  // task protocol's spawn record transitions on it). Additive: absent = today.
  validateBeforeLaunch?: () => void
  onPublished?: (info: { path: string; jobId: string; sessionId?: string; modelLabel?: string }) => void
  onSettled?: (info: { finalText?: string; error?: string; aborted: boolean }) => void | Promise<void>
}
