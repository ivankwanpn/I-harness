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
export { driveFollowups, ensureResidentAgent, sweepPendingInbox, type FollowupDeps } from "./tools.ts"
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
import { createAgentTable, type AgentTable, type ChildAgentEntry } from "./agent-table.ts"
import { createSubagentTools, ensureResidentAgent, sweepPendingInbox } from "./tools.ts"
import type { SubagentToolDeps } from "./tools.ts"
import { createAgentRegistry, type AgentRegistry } from "@i-harness/core-agent"
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
  // M19 (Ruling 17): the live Agent instances registry — the team scheduler
  // (agent-team) uses it to wake spawned child agents (followup re-drives).
  // Additive: existing consumers destructure { roles, jobs, table } and are
  // unaffected.
  agents: AgentRegistry
  // M23 (Minor 4): lazy resident rebuild closure over this mount's REAL
  // SubagentToolDeps. registerSubagent encapsulates the deps object, so hosts
  // (run.ts → mountAgentTeams) wire this into the agent-team deliver gate to
  // fix the post-resume wakeup no-op without duplicating the deps shape.
  ensureResident: (entry: ChildAgentEntry) => Promise<boolean>
  // M24a (G1a/G4): resolves when the post-restore async steps complete — the
  // G1a hooked-mirror rebuild (each restored child's durable log loaded into
  // a live mirror session) followed by the G4 pending-inbox sweep. Hosts MUST
  // await this BEFORE mounting agent teams (mountAgentTeams' recoverRoot
  // delivers queued team messages to entry.session, which must be a live
  // mirror by then) and before the main agent can touch the tools. Resolves
  // immediately (no-op) when there is no restored state.
  ready: Promise<void>
}

// Mount entry point (spec §1.1.6 / §2.3): seeds the role registry with the
// four built-in roles, creates the job registry + agent table, builds the 11
// subagent/job tools, and registers them on the parent registry.
export function registerSubagent(ctx: PluginContext, parentRegistry: ToolRegistry, opts: RegisterSubagentOptions): RegisterSubagentResult {
  // M24a (G1a/G4): resolved to the real post-restore step below when BOTH a
  // restored state and persistence are present; otherwise a no-op.
  let ready: Promise<void> = Promise.resolve()
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
    // M24a (Ruling M24a-P2): restoreState stays SYNC — it rebuilds the
    // registries with empty stub sessions; the async G1a mirror rebuild and
    // the G4 sweep run afterwards behind `ready` (below).
    restoreState({ jobs, table, roles }, opts.restoredState, opts.persist)
  }
  if (opts.persist) {
    const wired = wireSubagentPersistence({ jobs, table, roles }, opts.persist)
    jobs = wired.jobs
    table = wired.table
    roles = wired.roles
  }
  const agents = createAgentRegistry()
  // M23 (Minor 4): the deps object is kept in a named variable so the
  // ensureResident closure below closes over the SAME (persist-wrapped)
  // registries the tools use.
  const subagentDeps: SubagentToolDeps = {
    table, jobs, roles, parentRegistry, parentSession: opts.parentSession, parentCtx: ctx,
    parentModel: opts.parentModel, providers: opts.providers, exec: opts.exec,
    agents,
    // M8: when persistence has a known main-session id, spawns get durable
    // child-<uuid> sessions with the lineage header.
    ...(opts.persist
      ? { childSessions: { coordinator: opts.persist.coordinator, parentSessionId: opts.persist.parentSessionId } }
      : {}),
  }
  const tools = createSubagentTools(subagentDeps)
  // ToolRegistry.register throws on duplicate names, so skip tools the parent
  // already has — makes registerSubagent idempotent for repeat mounts.
  for (const tool of tools) {
    if (!parentRegistry.get(tool.name)) parentRegistry.register(tool)
  }
  if (opts.restoredState && opts.persist) {
    // M24a (G1a/G4): the async after-restore step — rebuild each child's
    // hooked mirror from its durable log, then sweep the pending inbox. The
    // returned `ready` gates hosts until this completes (run.ts awaits it
    // before mountAgentTeams' recoverRoot delivers to entry.session).
    ready = restoreMirrorsAndSweep(subagentDeps, table)
  }
  return { roles, jobs, table, agents, ensureResident: (entry: ChildAgentEntry) => ensureResidentAgent(subagentDeps, entry), ready }
}

// M24a (G1a): rebuild each restored child's hooked mirror session from its
// durable log — the async complement to the sync restoreState (Ruling
// M24a-P2). The mirror is the SAME shape the CLI's former host-side loop
// built (run.ts, now deleted): a fresh createSession with an enqueue+flush
// write-behind hook so subsequent appends (send_message / followup_task /
// child turns) keep persisting through the coordinator. A child whose durable
// log is missing/corrupt fails VISIBLE (the pre-M24a host loop silently kept
// the empty stub): the entry is marked error with an explanatory message so
// wait_agent / list_agents can surface why the child is unusable. Afterwards
// the G4 sweep drives waiting entries with unconsumed inbox events.
async function restoreMirrorsAndSweep(deps: SubagentToolDeps, table: AgentTable): Promise<void> {
  for (const entry of table.entries().values()) {
    if (!entry.sessionId || !deps.childSessions) continue
    try {
      const loaded = await deps.childSessions.coordinator.load(entry.sessionId)
      const resumed = createSession((ev) => {
        deps.childSessions!.coordinator.enqueue(entry.sessionId!, [ev])
        if (ev.type === "turn/end") void deps.childSessions!.coordinator.flush(entry.sessionId!).catch(() => {})
      })
      resumed.events.push(...loaded.session.events)
      resumed.formatVersion = loaded.session.formatVersion
      resumed.header = loaded.session.header
      entry.session = resumed
    } catch {
      // G1a fail-visible: no silent empty-stub downgrade.
      entry.status = "error"
      entry.error = "child log unavailable after resume"
    }
  }
  await sweepPendingInbox(deps, table)
}
