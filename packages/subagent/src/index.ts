export { createJobRegistry } from "./jobs.ts"
export type { JobRegistry, JobSnapshot, JobStatus } from "./jobs.ts"
export { createRoleRegistry, builtinRoles } from "./roles.ts"
export type { SubagentRole, RoleRegistry } from "./roles.ts"
export { createAgentTable } from "./agent-table.ts"
export type { ChildStatus, ChildAgentEntry, AgentTable } from "./agent-table.ts"
export { forkTurns } from "./fork.ts"
export { spawnChild } from "./child.ts"
export type { SpawnOptions } from "./child.ts"
export { createSubagentTools } from "./tools.ts"
export type { SubagentToolDeps } from "./tools.ts"
export { restoreState, wireSubagentPersistence } from "./persist.ts"
export type { SubagentPersistence, SubagentStateSnapshot } from "./persist.ts"

import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { ExecService } from "@i-harness/exec"
import { createJobRegistry, type JobRegistry } from "./jobs.ts"
import { createRoleRegistry, builtinRoles, type RoleRegistry } from "./roles.ts"
import { createAgentTable, type AgentTable } from "./agent-table.ts"
import { createSubagentTools } from "./tools.ts"
import { restoreState, wireSubagentPersistence } from "./persist.ts"
import type { SubagentPersistence, SubagentStateSnapshot } from "./persist.ts"

export interface RegisterSubagentOptions {
  providers: ProviderRegistry
  exec: ExecService
  parentModel: ModelClient
  parentSession: ReturnType<typeof createSession>
  // M6 state persistence: when set, every registry mutation persists the full
  // snapshot through the coordinator document API.
  persist?: SubagentPersistence
  // M6 resume: snapshot whose roles/jobs/agent-table are authoritative. When
  // present the builtin seeding below is SKIPPED — the snapshot's roles list
  // already contains the builtins (possibly user-edited) plus any custom roles,
  // and RoleRegistry.register throws on duplicates.
  restoredState?: SubagentStateSnapshot
}

export interface RegisterSubagentResult {
  roles: RoleRegistry
  jobs: JobRegistry
  table: AgentTable
}

// Mount entry point (spec §1.1.6 / §2.3): seeds the role registry with the
// four built-in roles, creates the job registry + agent table, builds the 11
// subagent/job tools, and registers them on the parent registry.
export function registerSubagent(ctx: PluginContext, parentRegistry: ToolRegistry, opts: RegisterSubagentOptions): RegisterSubagentResult {
  let roles: RoleRegistry = createRoleRegistry()
  let jobs: JobRegistry = createJobRegistry()
  let table: AgentTable = createAgentTable()
  if (!opts.restoredState) {
    // Snapshot roles are authoritative (builtins + custom/edited); seeding
    // builtins now would throw on duplicates and shadow edited builtins.
    for (const r of builtinRoles()) roles.register(r)
  }
  if (opts.restoredState) {
    // Restore BEFORE wrapping so the first save persists the restored state.
    restoreState({ jobs, table, roles }, opts.restoredState)
  }
  if (opts.persist) {
    const wired = wireSubagentPersistence({ jobs, table, roles }, opts.persist)
    jobs = wired.jobs
    table = wired.table
    roles = wired.roles
  }
  const tools = createSubagentTools({
    table,
    jobs,
    roles,
    parentRegistry,
    parentSession: opts.parentSession,
    parentCtx: ctx,
    parentModel: opts.parentModel,
    providers: opts.providers,
    exec: opts.exec,
    // M8: when persistence has a known main-session id, spawns get durable
    // child-<uuid> sessions with the lineage header.
    ...(opts.persist && opts.persist.parentSessionId
      ? { childSessions: { coordinator: opts.persist.coordinator, parentSessionId: opts.persist.parentSessionId } }
      : {}),
  })
  // ToolRegistry.register throws on duplicate names, so skip tools the parent
  // already has — makes registerSubagent idempotent for repeat mounts.
  for (const tool of tools) {
    if (!parentRegistry.get(tool.name)) parentRegistry.register(tool)
  }
  return { roles, jobs, table }
}
