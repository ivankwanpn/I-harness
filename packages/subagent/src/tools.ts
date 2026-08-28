import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { append, createSession, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry, type Tool, type ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import { buildModelClient, type ProviderRegistry } from "@i-harness/provider"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { ExecService } from "@i-harness/exec"
import { createAgent, type AgentRegistry } from "@i-harness/core-agent"
import type { JobRegistry } from "./jobs.ts"
import type { AgentTable, ChildAgentEntry } from "./agent-table.ts"
import type { RoleRegistry } from "./roles.ts"
import { spawnChild } from "./child.ts"

export interface SubagentToolDeps {
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  parentModel: ModelClient
  providers: ProviderRegistry
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
}

export function createSubagentTools(deps: SubagentToolDeps): Tool[] {
  const spawnTool: Tool<{ message: string; task_name: string; agent_type?: string; fork_turns?: string | number }, { agent_path: string; job_id: string }> = {
    name: "spawn_agent",
    description: "Launch a subagent in the background. Returns an agent path and job id immediately. Use wait_agent or job_output to observe completion.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Initial task for the subagent." },
        task_name: { type: "string", description: "Short name used in the agent path." },
        agent_type: { type: "string", description: "Role name (default general)." },
        fork_turns: { type: ["string", "number"], description: "none, all, or N." },
      },
      required: ["message", "task_name"],
    },
    isReadOnly: false,
    execute: async (args) => {
      const role = deps.roles.get(args.agent_type ?? "general")
      if (!role) throw new Error(`unknown role: ${args.agent_type}`)
      // M24a (B2): max_depth guard — reject spawning once the caller is already
      // at (or beyond) the nesting limit. Default 1 keeps today's behavior
      // (top-level callers are depth 0; subagents cannot nest).
      //
      // M24a (Ruling M24a-T2a, carried finding — DEPTH-BINDING LIMITATION,
      // documented per the minimal-diff ruling): this guard reads
      // deps.parentSession.header.delegationDepth, but the tool mount is
      // SHARED — registerSubagent mounts createSubagentTools ONCE on the host
      // registry with ONE bound parent session (the root; index.ts and
      // run.ts both mount the root session), so through today's mount every
      // caller resolves callerDepth from the ROOT session (depth 0). A
      // subagent that somehow reached this tool would therefore be measured at
      // depth 0, and a host-raised maxDepth > 1 would under-enforce. A
      // per-session createSubagentTools mount (rebinding deps.parentSession
      // per child scope) was evaluated and rejected for M24a: it restructures
      // tool mounting for every consumer. This is MOOT in the shipped surface:
      // the builtin roles (roles.ts) do not include spawn_agent in their
      // tools, so no subagent can reach this guard until a custom role adds
      // it — exactly the configuration a host must pair with a maxDepth
      // review.
      const callerDepth = deps.parentSession.header?.delegationDepth ?? 0
      const maxDepth = deps.maxDepth ?? 1
      if (callerDepth >= maxDepth) {
        throw new Error(`subagent nesting depth limit reached (max ${maxDepth}) — cannot spawn from depth ${callerDepth}`)
      }
      const turns = parseForkTurns(args.fork_turns)
      const { path, jobId } = await spawnChild({
        taskName: args.task_name,
        message: args.message,
        parentPath: "root",
        parentRegistry: deps.parentRegistry,
        parentSession: deps.parentSession,
        parentCtx: deps.parentCtx,
        role,
        parentModel: deps.parentModel,
        providers: deps.providers,
        jobs: deps.jobs,
        table: deps.table,
        agents: deps.agents,
        forkTurns: turns,
        childSessions: deps.childSessions,
      })
      return { agent_path: path, job_id: jobId }
    },
  }

  const waitTool: Tool<{ timeout_ms?: number; target?: string }, { message: string; timed_out: boolean; path?: string; status?: string; finalText?: string; error?: string }> = {
    name: "wait_agent",
    description: "Wait for subagents to reach a terminal status. With target, waits for THAT subagent and returns its summary (path, status, finalText?, error?); otherwise waits for all live subagents to settle. Returns whether it timed out.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number", description: "Max wait in ms (default 30000, clamped to 100..300000)." }, target: { type: "string", description: "Optional agent path — wait for this specific subagent instead of all." } } },
    isReadOnly: true,
    execute: async (args) => {
      // M24a (B4): clamp the wait to [100ms, 300s] for both modes.
      const timeoutMs = Math.min(300_000, Math.max(100, args.timeout_ms ?? 30_000))
      const deadline = Date.now() + timeoutMs
      if (args.target !== undefined) {
        // M24a (B4): wait for THAT child's terminal status (not-running) and
        // return its summary.
        const entry = deps.table.get(args.target)
        if (!entry) throw new Error(`unknown subagent: ${args.target}`)
        while (Date.now() < deadline && entry.status === "running") {
          // M24a (minor hardening): the target can be closed mid-wait
          // (close_agent removes it from the table while its status object is
          // still "running") — stop polling instead of spinning to the deadline.
          if (deps.table.get(args.target) !== entry) break
          await new Promise((r) => setTimeout(r, 20))
        }
        const settled = entry.status !== "running"
        return {
          path: entry.path,
          status: entry.status,
          ...(entry.finalText !== undefined ? { finalText: entry.finalText } : {}),
          ...(entry.error !== undefined ? { error: entry.error } : {}),
          message: settled ? `subagent ${entry.path} settled: ${entry.status}` : `wait timed out for ${entry.path} (still running)`,
          timed_out: !settled,
        }
      }
      while (Date.now() < deadline) {
        const running = [...deps.table.entries().values()].some((e) => e.status === "running")
        if (!running) {
          const done = [...deps.table.entries().values()].map((e) => e.path)
          return { message: `All subagents settled: ${done.join(", ") || "(none)"}`, timed_out: false }
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      return { message: "wait timed out with subagents still running", timed_out: true }
    },
  }

  const listTool: Tool<{ path_prefix?: string; scope?: "children" | "descendants" }, { agents: { path: string; status: string; roleName?: string; jobId?: string; sessionId?: string; finalText?: string; error?: string }[] }> = {
    name: "list_agents",
    description: "List live subagents in the current tree with their role/job/session details. scope 'children' lists only direct children of the prefix (default base 'root'), 'descendants' the whole subtree; without scope, path_prefix keeps the legacy startsWith filter.",
    inputSchema: { type: "object", properties: { path_prefix: { type: "string" }, scope: { type: "string", enum: ["children", "descendants"], description: "children = direct children only; descendants = the whole subtree below the prefix." } } },
    isReadOnly: true,
    execute: async (args) => {
      const prefix = args.path_prefix ?? ""
      const agents = [...deps.table.entries().values()]
        .filter((e) => {
          // M24a (B5): scope filters the tree by depth. Paths look like
          // root/a/b — descendants of a base are everything under base/,
          // children only the next segment.
          if (args.scope === "descendants") {
            const base = args.path_prefix ?? "root"
            return e.path.startsWith(base + "/")
          }
          if (args.scope === "children") {
            const base = args.path_prefix ?? "root"
            if (!e.path.startsWith(base + "/")) return false
            return !e.path.slice(base.length + 1).includes("/")
          }
          return e.path.startsWith(prefix) // legacy behavior (backward compat)
        })
        .map((e) => ({
          path: e.path,
          status: e.status,
          ...(e.roleName !== undefined ? { roleName: e.roleName } : {}),
          ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
          ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
          ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
          ...(e.error !== undefined ? { error: e.error } : {}),
        }))
      return { agents }
    },
  }

  const sendTool: Tool<{ target: string; message: string }, { queued: boolean }> = {
    name: "send_message",
    description: "Send a message to an existing subagent. Queued; does not trigger a new turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox: append a model-hidden event through the child's mirror.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message })
      entry.mailbox.push(args.message)
      return { queued: true }
    },
  }

  const interruptTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "interrupt_agent",
    description: "Interrupt a subagent's current turn, if any, and return its previous status. The agent remains available.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      const previous = entry.status
      entry.controller.abort()
      return { previous_status: previous }
    },
  }

  const followupTool: Tool<{ target: string; message: string }, { delivered: boolean }> = {
    name: "followup_task",
    description: "Send a follow-up task to a subagent and trigger a new turn. Queues the message durably and wakes the child to process it as a serialized followup turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox + wake: queue the message and drive a turn on the child.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message })
      entry.mailbox.push(args.message)
      // M23 (Minor 4): inject the lazy rebuild so a wakeup for a restored
      // (fresh-registry) entry rebuilds the resident agent instead of
      // silently dropping the drive.
      if (entry.sessionId) void driveFollowups(followupDepsWithRebuild(deps), entry, entry.sessionId)
      return { delivered: true }
    },
  }

  const closeTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "close_agent",
    description: "Close a subagent and reclaim its resources (abort execution, unmount child scope, remove from the agent and job tables).",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      const previous = entry.status
      entry.controller.abort()
      entry.unmount?.()
      if (entry.jobId) deps.jobs.kill(entry.jobId)
      deps.table.remove(args.target)
      if (entry.sessionId) deps.agents.remove(entry.sessionId)
      return { previous_status: previous }
    },
  }

  const resumeTool: Tool<{ target: string }, { resumed: boolean }> = {
    name: "resume_agent",
    description: "Re-activate a previously settled subagent from its persisted session; queued inbox messages are processed.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const existing = deps.table.get(args.target)
      if (!existing) throw new Error(`unknown subagent: ${args.target}`)
      if (existing.status === "running") throw new Error(`subagent already running: ${args.target}`)
      if (existing.sessionId && deps.agents.get(existing.sessionId)) {
        // already resident (e.g. a waiting child) → just re-drive pending inbox
        void driveFollowups(followupDepsWithRebuild(deps), existing, existing.sessionId)
        return { resumed: true }
      }
      // M23 (Minor 4): the rebuild body moved into ensureResidentAgent so the
      // wakeup paths (driveFollowups / agent-team deliver gate) can lazily
      // rebuild a fresh-registry (post-resume) resident agent too. As an
      // explicit tool call, resume_agent still ERRORS on an unrebuildable
      // target instead of tolerating the false return like the wakeup paths.
      const roleName = existing.roleName ?? "general"
      const role = deps.roles.get(roleName)
      if (!role) throw new Error(`unknown role: ${roleName}`)
      if (!(await ensureResidentAgent(deps, existing))) {
        // After the role check the only remaining failure mode is the role's
        // model-provider resolution — mirror spawnChild's error shape so the
        // resume diagnostics match the spawn path.
        if (role.model && !deps.providers.get(role.model.provider)) {
          throw new Error(`role '${role.name}' references unknown provider '${role.model.provider}'`)
        }
        throw new Error(`could not resume subagent: ${args.target}`)
      }
      if (existing.sessionId) void driveFollowups(followupDepsWithRebuild(deps), existing, existing.sessionId)
      return { resumed: true }
    },
  }

  const jobOutputTool: Tool<{ job_id: string; wait?: boolean; timeout_ms?: number }, { text: string; status: string }> = {
    name: "job_output",
    description: "Read a background job (subagent or shell). Non-blocking unless wait: true. Every response ends with [status: ...].",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, wait: { type: "boolean" }, timeout_ms: { type: "number" } }, required: ["job_id"] },
    isReadOnly: true,
    execute: async (args) => {
      // Prefer the subagent JobRegistry; fall back to the exec service (bash/pwsh jobs).
      try {
        if (args.wait === true) await deps.jobs.wait(args.job_id, args.timeout_ms ?? 30_000)
        const snapshot = deps.jobs.read(args.job_id)
        const body = snapshot.output.length > 0 ? snapshot.output : "(no output)"
        return { text: `${body}\n[status: ${snapshot.status}]`, status: snapshot.status }
      } catch (e) {
        if (!(e instanceof Error) || !/unknown job/i.test(e.message)) throw e
      }
      if (args.wait === true) {
        const deadline = Date.now() + (args.timeout_ms ?? 30_000)
        while (Date.now() < deadline && deps.exec.getOutput(args.job_id).status === "running") {
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      const view = deps.exec.getOutput(args.job_id)
      const body = view.stdout.length > 0 ? view.stdout : "(no output)"
      return { text: `${body}\n[status: ${view.status}]`, status: view.status }
    },
  }

  const jobListTool: Tool<Record<string, never>, { jobs: { id: string; kind: string; status: string; label: string }[] }> = {
    name: "job_list",
    description: "List your background jobs (subagent and shell) with ids, kinds, and statuses.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => {
      const sub = deps.jobs.list("root").map((j) => ({ id: j.id, kind: j.kind, status: j.status, label: j.label }))
      const shell = deps.exec.listJobs().map((v) => ({ id: v.id, kind: "bash", status: v.status, label: v.id }))
      return { jobs: [...sub, ...shell] }
    },
  }

  const jobKillTool: Tool<{ job_id: string; reason?: string }, { outcome: string }> = {
    name: "job_kill",
    description: "Request cancellation of a running background job (subagent or shell).",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, reason: { type: "string" } }, required: ["job_id"] },
    isReadOnly: false,
    execute: async (args) => {
      try {
        return { outcome: deps.jobs.kill(args.job_id) }
      } catch (e) {
        if (!(e instanceof Error) || !/unknown job/i.test(e.message)) throw e
        return { outcome: deps.exec.killJob(args.job_id) }
      }
    },
  }

  return [spawnTool, waitTool, listTool, sendTool, interruptTool, followupTool, closeTool, resumeTool, jobOutputTool, jobListTool, jobKillTool]
}

// M23 (Minor 4): lazy resident rebuild, extracted verbatim from resume_agent's
// rebuild body (M19). On resume the subagent Agent registry is fresh-empty
// (entries are registered per spawn/turn), so a wakeup for a restored teammate
// found no resident agent and silently dropped the drive. This rebuilds the
// resident agent from the restored entry (durable session + role + model):
//   - returns true when the entry is already resident OR the rebuild succeeded
//   - returns false when it cannot rebuild (unknown role / unknown provider) —
//     the CALLER decides the fail behavior (resume_agent throws; the wakeup
//     paths just drop the drive like before)
export async function ensureResidentAgent(deps: SubagentToolDeps, entry: ChildAgentEntry): Promise<boolean> {
  if (entry.sessionId) {
    const resident = deps.agents.get(entry.sessionId)
    if (resident) return true
  }
  const role = deps.roles.get(entry.roleName ?? "general")
  if (!role) return false
  const childCtx = deps.parentCtx.scope.mount()
  const childReg = createToolRegistry(childCtx)
  for (const name of role.tools) {
    const tool = deps.parentRegistry.get(name)
    if (tool) childReg.register(tool)
  }
  // model resolution identical to spawnChild (child.ts): role.model →
  // provider → buildModelClient; else inherit the parent model.
  let model = deps.parentModel
  if (role.model) {
    const profile = deps.providers.get(role.model.provider)
    if (!profile) return false
    model = buildModelClient(profile, role.model.model, role.model.extra)
  }
  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: entry.session, tools: childReg, model,
    systemPrompt: role.systemPrompt, signal: controller.signal,
    // M19 (Ruling 24): attribute the resumed child's tool calls to its
    // team member via the durable session id.
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
  })
  if (entry.sessionId) deps.agents.register(entry.sessionId, agent)
  entry.status = "waiting"
  entry.controller = controller
  entry.unmount = () => childCtx.scope.unmount()
  return true
}

// M23 (Minor 4): the FollowupDeps passed to driveFollowups from the subagent
// tools carries the lazy rebuild so a wakeup for a restored (fresh-registry)
// entry recovers the resident agent instead of silently dropping the drive.
function followupDepsWithRebuild(deps: SubagentToolDeps): FollowupDeps {
  return { agents: deps.agents, table: deps.table, jobs: deps.jobs, rebuild: (entry) => ensureResidentAgent(deps, entry) }
}

function parseForkTurns(value: string | number | undefined): "none" | "all" | number {
  if (value === undefined || value === "all") return "all"
  if (value === "none") return "none"
  const n = typeof value === "number" ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : "all"
}

// Drain all unconsumed durable inbox events as serialized turns on the child.
// Turns are chained through entry.followupChain (one at a time, per child), a
// fresh AbortController is minted per turn so interrupt_agent targets the
// current turn, and each turn re-opens the entry's job (running -> completed /
// killed / error) so wait_agent/job_output observe the followup lifecycle.
// Exported for the agent-team scheduler (M19 Ruling 28): the team wakeup
// policy is the SAME serialized drain, shared instead of vendored.
export interface FollowupDeps {
  agents: AgentRegistry
  table: AgentTable
  jobs: JobRegistry
  // M23 (Minor 4): optional lazy rebuild — called when the resident agent is
  // missing (e.g. a restored entry after resume) so the wakeup drive recovers
  // it instead of silently no-oping. Backward-compatible: absent (the default,
  // e.g. the agent-team scheduler without the seam) keeps the old no-op.
  rebuild?: (entry: ChildAgentEntry) => Promise<boolean>
}
export function driveFollowups(deps: FollowupDeps, entry: ChildAgentEntry, sessionId: string): Promise<void> {
  const prev = entry.followupChain ?? Promise.resolve()
  const next = prev.then(async () => {
    let agent = deps.agents.get(sessionId)
    if (!agent) {
      if (!deps.rebuild) return // no rebuild ability → keep the old no-op
      const ok = await deps.rebuild(entry)
      if (!ok) return
      agent = deps.agents.get(sessionId)
      if (!agent) return
    }
    const pending = entry.session.events.filter(
      (e): e is Extract<SessionEvent, { type: "subagent/inbox" }> =>
        e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    for (const ev of pending) {
      if (!deps.table.get(entry.path)) return // closed mid-drain → stop
      entry.lastInboxSeq = ev.seq ?? 0
      entry.status = "running"
      entry.controller = new AbortController() // fresh signal per turn (interrupt targets this)
      if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "running", output: "" })
      try {
        const result = await agent.followup(ev.message, entry.controller.signal)
        // Clear a stale error (e.g. "aborted" from an earlier interrupted
        // turn) once a followup succeeds — otherwise a misleading error would
        // persist into the M6 snapshot.
        entry.error = undefined
        entry.status = "waiting"
        entry.finalText = result.finalText
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "completed", output: result.finalText })
      } catch (err) {
        const aborted = entry.controller.signal.aborted
        entry.status = "waiting"
        entry.error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      }
    }
  })
  // Defensive hardening: the body fully try/catches, but a future throwing
  // statement before the try must not reject the chain and silently kill all
  // later followups for this child.
  entry.followupChain = next.catch(() => {})
  return next
}

// M24a (G4): pending-inbox sweep for cold resume. After the sync restoreState
// rebuilds the agent table (Ruling M24a-P2) and the G1a mirror step has
// reloaded each child's durable log into a live mirror (index.ts
// restoreMirrorsAndSweep), entries that were WAITING with a queued-but-
// unconsumed durable inbox event (seq > lastInboxSeq) get the same serialized
// followup drain a live wakeup would have given them. Guards:
//   - ONLY "waiting" entries are swept (Ruling M24a-P6): entries that were
//     running were already mapped to "error" by restoreState and need an
//     explicit resume_agent; completed/killed/error entries have no live
//     conversation to resume.
//   - A failed resident rebuild is skipped conservatively (the followup
//     wakeup paths rebuild lazily later; the sweep itself must never throw).
// Exported for direct testing: the drive is fire-and-forget (same semantics
// as followup_task), so a caller asserting the OUTCOME awaits
// entry.followupChain.
export async function sweepPendingInbox(deps: SubagentToolDeps, table: AgentTable): Promise<void> {
  for (const entry of table.entries().values()) {
    if (entry.status !== "waiting" || !entry.sessionId) continue
    const hasPending = entry.session.events.some(
      (e) => e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    if (!hasPending) continue
    if (!deps.agents.get(entry.sessionId)) {
      const ok = await ensureResidentAgent(deps, entry)
      if (!ok) continue // rebuild failed → skip (conservative; wakeup paths may retry lazily)
    }
    void driveFollowups(followupDepsWithRebuild(deps), entry, entry.sessionId).catch(() => {
      // fail-visible log, not throw: one child's failed sweep must not break
      // the host resume (the error stays on the entry for wait_agent /
      // job_output to surface).
      console.warn(`[subagent] pending inbox sweep failed for ${entry.sessionId}`)
    })
  }
}
