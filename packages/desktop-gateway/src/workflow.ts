import { createHash, randomUUID } from "node:crypto"
import { append, derivePlanMode, type Session, type GoalOperation } from "@i-harness/core-session"
import { applyGoalMutation, foldGoal, type GoalView, type GoalMutationRequest } from "@i-harness/goal"
import { enterPlanMode } from "@i-harness/plan-mode"
import { foldJobs, projectJobsDoc, type JobView } from "@i-harness/jobs"
import { foldTeam, teamLedger, type TeamMemberSnapshot, type TeamTaskSnapshot } from "@i-harness/agent-team"
import { validateJsonSchemaValue, type JsonSchemaNode, type Tool } from "@i-harness/core-tools"
import type { GuardianReviewRecord } from "@i-harness/guard-approval"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"

export interface DesktopWorkflowView {
  goal: GoalView | null
  goalRun?: { running: boolean; error?: string }
  plan: { active: boolean; proposal?: string }
  jobs: (JobView & { live: boolean; canCancel: boolean })[]
  team: { enabled: boolean; members: TeamMemberSnapshot[]; tasks: TeamTaskSnapshot[] }
  reviews: GuardianReviewRecord[]
}
export type WorkflowCommand =
  | { action: "goal"; operation: GoalOperation; request: GoalMutationRequest; start?: boolean }
  | { action: "plan"; enabled: boolean; proposal?: string }
  | { action: "team"; tool: "spawn_teammate" | "send_message" | "followup_task" | "interrupt_agent" | "team_task_create" | "team_task_update"; args: Record<string, unknown> }
  | { action: "job/cancel"; id: string }

const TEAM_TOOLS = new Set(["spawn_teammate", "send_message", "followup_task", "interrupt_agent", "team_task_create", "team_task_update"])
const GOAL_OPERATIONS = new Set(["create", "edit", "pause", "resume", "complete", "clear"])
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow command")
  return value as Record<string, unknown>
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error("Invalid workflow text")
  return value
}

/** Scope and state remain owned by the existing session/domain registries. */
export function createDesktopWorkflow(coordinator: SessionCoordinator, service: SessionService, options: {
  teamEnabled?: boolean
  reviews?: (sessionId: string) => Promise<GuardianReviewRecord[]>
  onChanged?: (sessionId: string) => void
  onRunningChanged?: (sessionId: string, running: boolean, error?: string) => void
} = {}) {
  const goalRuns = new Map<string, { controller: AbortController; job: Promise<void> }>()
  const goalFailures = new Map<string, { goalId?: string; error: string }>()
  const goalVersions = new Map<string, number>()
  let closed = false
  const goalDoc = (id: string) => `desktop-goal-${createHash("sha256").update(id).digest("hex")}`
  async function sessionFor(id: string): Promise<Session> {
    await coordinator.profile(id)
    return service.liveSession(id) ?? (await (coordinator.snapshot?.(id) ?? coordinator.load(id))).session
  }
  async function read(id: string): Promise<DesktopWorkflowView> {
    const session = await sessionFor(id)
    const jobs = new Map([...projectJobsDoc(await coordinator.getDocument(id)), ...foldJobs(session.events)].map((job) => [job.jobId, job]))
    const live = service.tasks(id)
    const team = foldTeam(teamLedger(session)).state
    const goal = foldGoal(session.events)
    const savedFailure = await coordinator.getDocument(goalDoc(id)) as { goalId?: string; error?: string } | undefined
    const last = goalFailures.get(id) ?? savedFailure
    const goalRunning = Boolean(goalRuns.get(id) && !goalRuns.get(id)!.controller.signal.aborted)
    return {
      goal, goalRun: { running: goalRunning, ...(!goalRunning && last?.goalId === goal?.id && last?.error ? { error: last.error.slice(0, 2000) } : {}) }, plan: derivePlanMode(session),
      jobs: [...jobs.values()].slice(-200).map((job) => { const task = live.find((row) => row.id === job.jobId); return { ...job, live: Boolean(task), canCancel: task?.canCancel === true } }),
      team: { enabled: options.teamEnabled === true, members: [...team.members.values()], tasks: [...team.tasks.values()].filter((task) => task.status !== "deleted") },
      reviews: await options.reviews?.(id) ?? [],
    }
  }
  function stopGoal(id: string) { goalRuns.get(id)?.controller.abort(new Error("Goal stopped by user")) }
  function startGoal(id: string, objective: string) {
    if (closed) throw new Error("Workflow closed")
    const previous = goalRuns.get(id)
    if (previous && !previous.controller.signal.aborted) return
    const controller = new AbortController()
    const version = (goalVersions.get(id) ?? 0) + 1
    goalVersions.set(id, version)
    const entry = { controller, job: Promise.resolve() }
    let failure: string | undefined
    goalRuns.set(id, entry)
    goalFailures.delete(id)
    try { options.onRunningChanged?.(id, true) } catch { /* closed notification sink */ }
    entry.job = (async () => {
      let prompt = `執行目前目標：${objective}\n完成後先驗證結果，再呼叫 goal_complete。不要自行變更使用者暫停的目標。`
      while (!closed && !controller.signal.aborted) {
        const current = foldGoal((await sessionFor(id)).events)
        if (!current || current.phase !== "active") break
        const before = service.liveSession(id)?.events.length ?? 0
        await service.submit(id, prompt, controller.signal)
        const end = service.liveSession(id)?.events.slice(before).filter((event) => event.type === "step/end").at(-1)
        if (end?.refused || end?.empty) throw new Error(end.refused ? "Provider refused the Goal request; resume only after reviewing the refusal" : "Provider returned no usable result; Goal continuation was paused")
        const latest = foldGoal((await sessionFor(id)).events)
        if (!latest || latest.phase !== "active") break
        prompt = `目標自動續行：${latest.objective}\n接續未完成工作；若已驗證完成，呼叫 goal_complete。`
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 250)
          function done() { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve() }
          controller.signal.addEventListener("abort", done, { once: true })
          if (controller.signal.aborted) done()
        })
      }
    })().catch(async (error) => {
      if (!controller.signal.aborted) {
        failure = error instanceof Error ? error.message : String(error)
        controller.abort(error)
        const session = service.liveSession(id)
        const current = session && foldGoal(session.events)
        goalFailures.set(id, { goalId: current?.id, error: failure })
        if (session && current?.phase === "active") append(session, applyGoalMutation(current, "pause", { ref: current }, Date.now()).event)
        await coordinator.putDocument(goalDoc(id), { goalId: current?.id, error: failure.slice(0, 2000) })
        await coordinator.flush(id)
        console.warn(`[desktop] goal run stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }).finally(() => {
      if (goalRuns.get(id) !== entry) return
      goalRuns.delete(id); options.onRunningChanged?.(id, false, failure); options.onChanged?.(id)
    }).catch((error) => {
      if (goalVersions.get(id) !== version) return
      const message = `Goal stopped, but recovery could not be saved: ${error instanceof Error ? error.message : String(error)}`
      goalFailures.set(id, { goalId: foldGoal(service.liveSession(id)?.events ?? [])?.id, error: message })
      try { options.onRunningChanged?.(id, false, message); options.onChanged?.(id) } catch { /* closed notification sink */ }
      console.warn(`[desktop] ${message}`)
    })
  }
  async function mutate(id: string, value: unknown): Promise<DesktopWorkflowView> {
    if (closed) throw new Error("Workflow closed")
    const command = object(value)
    const assembly = await service.assemblyFor(id)
    const session = assembly.session
    if (command.action === "goal") {
      if (!GOAL_OPERATIONS.has(String(command.operation))) throw new Error("Invalid Goal operation")
      const request = object(command.request)
      if (Object.keys(request).some((key) => !["objective", "ref"].includes(key))) throw new Error("Unsupported Goal field")
      if (request.objective !== undefined) text(request.objective)
      if (command.start !== undefined && typeof command.start !== "boolean") throw new Error("Invalid Goal start flag")
      if (command.start === true && !goalRuns.has(id) && (service.queueState(id).running || service.queueState(id).queued)) throw new Error("Wait for the current turn before starting a Goal")
      const current = foldGoal(session.events)
      const startingActive = command.operation === "resume" && command.start === true && current?.phase === "active"
      if (startingActive) {
        const ref = object(request.ref)
        if (ref.id !== current.id || ref.revision !== current.revision) throw new Error("Stale Goal revision")
      } else append(session, applyGoalMutation(current, command.operation as GoalOperation, request as GoalMutationRequest, Date.now()).event)
      if (["pause", "clear", "complete"].includes(String(command.operation))) stopGoal(id)
      await coordinator.flush(id)
      const goal = foldGoal(session.events)
      if (command.start === true && goal?.phase === "active") startGoal(id, goal.objective)
    } else if (command.action === "plan") {
      if (typeof command.enabled !== "boolean") throw new Error("Invalid Plan mode flag")
      if (service.queueState(id).running || service.queueState(id).queued) throw new Error("Wait for the current turn before changing Plan Mode")
      if (command.proposal !== undefined) text(command.proposal)
      if (command.enabled && command.proposal) enterPlanMode(session, command.proposal as string)
      else append(session, { type: "plan/mode", mode: command.enabled ? "on" : "off" })
      await coordinator.flush(id)
    } else if (command.action === "team") {
      if (!options.teamEnabled || !TEAM_TOOLS.has(String(command.tool))) throw new Error("Team action unavailable")
      if (derivePlanMode(session).active) throw new Error("Leave Plan Mode before changing team state")
      const args = object(command.args)
      if (JSON.stringify(args).length > 65536) throw new Error("Team request too large")
      const registry = assembly.tools
      const tool = registry.get(`team_${String(command.tool)}`) ?? registry.get(String(command.tool))
      if (!tool) throw new Error("Team tool unavailable")
      const invalid = validateJsonSchemaValue(tool.inputSchema as JsonSchemaNode, args)
      if (invalid.length) throw new Error(`Invalid team arguments: ${invalid[0]}`)
      // This fixed-vocabulary UI operation is an explicit human action. Child
      // execution still uses its normal sandbox and per-tool approval policy.
      await tool.execute(args, { sessionId: id, callId: `desktop-${randomUUID()}` })
      await coordinator.flush(id)
    } else if (command.action === "job/cancel") {
      service.cancelTask(id, text(command.id, 256))
    } else throw new Error("Unknown workflow command")
    options.onChanged?.(id)
    return read(id)
  }
  return {
    read, mutate,
    async cancel(id: string) {
      if (!goalRuns.has(id)) return
      stopGoal(id)
      const session = service.liveSession(id)
      const current = session && foldGoal(session.events)
      if (session && current?.phase === "active") append(session, applyGoalMutation(current, "pause", { ref: current }, Date.now()).event)
      await coordinator.flush(id)
      options.onChanged?.(id)
    },
    async output(id: string, jobId: string) {
      await coordinator.profile(id)
      const doc = await coordinator.getDocument(id) as { jobs?: { id: string; output?: string }[] } | undefined
      const row = doc?.jobs?.find((job) => job.id === jobId)
      if (!row) throw new Error("Job output unavailable")
      const output = row.output ?? ""
      return { text: output.slice(0, 131072), truncated: output.length > 131072 }
    },
    async close() { closed = true; for (const row of goalRuns.values()) row.controller.abort(); await Promise.allSettled([...goalRuns.values()].map((row) => row.job)) },
  }
}

export function createDesktopGoalTools(sessionFor: (id: string) => Session | undefined, changed: (id: string) => void): Tool[] {
  return [
    { name: "goal_read", description: "Read this conversation's persisted goal and revision.", inputSchema: { type: "object", properties: {} }, isReadOnly: true,
      execute: async (_args, exec) => { const session = exec.sessionId && sessionFor(exec.sessionId); return session ? foldGoal(session.events) : null } },
    { name: "goal_complete", description: "Mark the current goal complete only after the work is actually verified. Include its latest id and revision from goal_read.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["id", "revision"] }, isReadOnly: true,
      execute: async (args, exec) => { const id = exec.sessionId; const session = id && sessionFor(id); if (!id || !session) throw new Error("Goal session unavailable"); const current = foldGoal(session.events); if (current?.phase !== "active") throw new Error("Goal is not active"); append(session, applyGoalMutation(current, "complete", { ref: object(args) as unknown as { id: string; revision: number } }, Date.now()).event); changed(id); return foldGoal(session.events) } },
  ]
}
