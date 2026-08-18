import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry, type ToolRegistry } from "@i-harness/core-tools"
import { createAgent, type AgentRegistry } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import { buildModelClient, type ProviderRegistry } from "@i-harness/provider"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { JobRegistry } from "./jobs.ts"
import type { AgentTable } from "./agent-table.ts"
import type { SubagentRole } from "./roles.ts"
import { forkTurns } from "./fork.ts"

export interface SpawnOptions {
  taskName: string
  message: string
  parentPath: string
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  role: SubagentRole
  parentModel: ModelClient
  providers: ProviderRegistry
  jobs: JobRegistry
  table: AgentTable
  agents: AgentRegistry
  forkTurns?: "none" | "all" | number
  // M8: when present, the child session is durable — minted as child-<uuid>,
  // created through the coordinator with the lineage header, and mirrored to
  // the parent's write-behind coordinator.
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
}

export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string }> {
  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()

  // fork_turns: last N parent turns (default all). The seed events are the
  // child's inherited context; with persistence they are stored in the child's
  // log and seedLength marks the boundary (dsh lineage).
  const turns = opts.forkTurns ?? "all"
  const seedEvents = turns === "none" ? [] : forkTurns(opts.parentSession.events, turns === "all" ? Infinity : turns)

  let childSession: ReturnType<typeof createSession>
  let sessionId: string | undefined
  if (opts.childSessions) {
    sessionId = `child-${randomUUID()}`
    await opts.childSessions.coordinator.create({
      sessionId,
      parentSession: opts.childSessions.parentSessionId,
      seedLength: seedEvents.length,
      origin: "subagent",
      // dsh: resolveChildDepth = delegationDepthOf(parent) + 1 — a child of a
      // top-level (depth 0) session is depth 1.
      delegationDepth: 1,
    })
    childSession = createSession((ev) => {
      opts.childSessions!.coordinator.enqueue(sessionId!, [ev])
      if (ev.type === "turn/end") void opts.childSessions!.coordinator.flush(sessionId!).catch(() => {})
    })
    // Persist the seed through the mirror so the child log starts at seq 0
    // with the inherited context (dsh: seed events live in the child log).
    for (const ev of seedEvents) append(childSession, { ...ev })
    // dsh parent+1 rule: same depth as the coordinator.create lineage above.
    childSession.header = { parentSession: opts.childSessions.parentSessionId, seedLength: seedEvents.length, origin: "subagent", delegationDepth: 1 }
  } else {
    childSession = createSession()
    for (const ev of seedEvents) childSession.events.push({ ...ev })
  }

  // child registry: register the role's allowed tools (resolved from the parent).
  const childReg = createToolRegistry(childCtx)
  for (const name of opts.role.tools) {
    const tool = opts.parentRegistry.get(name)
    if (tool) childReg.register(tool)
  }

  // model: role model via provider, else inherit parent.
  let model = opts.parentModel
  if (opts.role.model) {
    const profile = opts.providers.get(opts.role.model.provider)
    if (!profile) throw new Error(`role '${opts.role.name}' references unknown provider '${opts.role.model.provider}'`)
    model = buildModelClient(profile, opts.role.model.model, opts.role.model.extra)
  }

  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: childSession,
    tools: childReg,
    model,
    systemPrompt: opts.role.systemPrompt,
    signal: controller.signal,
  })
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName)
  opts.table.add(childPath, {
    path: childPath,
    status: "running",
    session: childSession,
    controller,
    mailbox: [],
    jobId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    roleName: opts.role.name,
    unmount: () => childCtx.scope.unmount(),
  })

  agent.run(opts.message, controller.signal).then(
    (result) => {
      const e = opts.table.get(childPath)
      // The turn is done, but the child is KEPT alive (waiting) so a later
      // followup can re-drive the same agent (M9 spec §2.2).
      if (e) { e.status = "waiting"; e.finalText = result.finalText }
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
    },
    (err) => {
      const aborted = controller.signal.aborted
      const e = opts.table.get(childPath)
      if (e) {
        // An interrupted turn leaves the child ALIVE (waiting) so followups still work.
        e.status = "waiting"
        e.error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
      }
      opts.jobs.updateJob(jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
    },
  )

  return { path: childPath, jobId, sessionId }
}
