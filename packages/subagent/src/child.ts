import type { PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, type ToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import type { ModelClient } from "@i-harness/llm-seam"
import { buildModelClient, type ProviderRegistry } from "@i-harness/provider"
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
}

export function spawnChild(opts: SpawnOptions): { path: string; jobId: string } {
  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()
  const childSession = createSession()

  // fork_turns: seed the child session with the last N parent turns (default all).
  for (const ev of forkTurns(opts.parentSession.events, Infinity)) childSession.events.push({ ...ev })

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
  opts.table.add(childPath, {
    path: childPath,
    status: "running",
    session: childSession,
    controller,
    mailbox: [],
  })
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName)

  const agent = createAgent(childCtx, {
    session: childSession,
    tools: childReg,
    model,
    systemPrompt: opts.role.systemPrompt,
  })

  agent.run(opts.message).then(
    (result) => {
      const e = opts.table.get(childPath)
      if (e) { e.status = "completed"; e.finalText = result.finalText }
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
    },
    (err) => {
      const e = opts.table.get(childPath)
      if (e) { e.status = "error"; e.error = err instanceof Error ? err.message : String(err) }
      opts.jobs.updateJob(jobId, { status: "error", output: err instanceof Error ? err.message : String(err) })
    },
  )

  return { path: childPath, jobId }
}
