// Team tools (M19 Task 9): the 10-tool surface of the Team scope.
//
// Ruling 3 (controller, binding): TeamToolDeps takes the RETURNED shapes of
// createRoster/createMailbox/createTaskBoard (the actual methods the created
// roster/mailbox/taskBoard expose), NOT the RosterDeps/MailboxDeps/
// TaskBoardDeps interfaces (which are the dep INPUTS of the create fns).
// Every tool resolves the exact caller first (deps.resolveCaller(exec)) and
// passes it to the domain layer — the domain layer owns authority checks
// (spawn/interrupt are Lead-only there; mailbox verifies membership).
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { TeamCaller, TeamMemberView, TeamTaskView } from "./types.ts"
import type { TeamWaitResult } from "./activity.ts"

export interface TeamToolDeps {
  resolveCaller(exec: ToolExec): TeamCaller
  roster: {
    listMembers(): TeamMemberView[]
    spawnTeammate(c: TeamCaller, n: string, o: { description: string; prompt: string; context?: "fresh" | "fork"; forkTurns?: "none" | "all" | number }): Promise<TeamMemberView>
    interrupt(c: TeamCaller, t: string): Promise<{ previousStatus: string }>
  }
  mailbox: {
    sendMessage(c: TeamCaller, t: string, m: string, d: "quiet" | "wakeup", s?: AbortSignal): Promise<{ messageId: string; status: "accepted" | "queued" }>
  }
  taskBoard: {
    createTask(c: TeamCaller, o: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[] }): Promise<TeamTaskView>
    getTask(c: TeamCaller, id: string): Promise<TeamTaskView>
    listTasks(c: TeamCaller, o?: unknown): Promise<{ tasks: TeamTaskView[]; nextCursor?: number }>
    updateTask(c: TeamCaller, r: unknown): Promise<TeamTaskView>
  }
  activity: {
    waitForChange(c: TeamCaller, timeoutMs?: number, signal?: AbortSignal, hasActivePeer?: () => boolean): Promise<TeamWaitResult>
    notify(): void
    close(): void
  }
}

type SpawnArgs = { name: string; description: string; prompt: string; context?: string; fork_turns?: string }
type ListArgs = Record<string, never>
type SendArgs = { target: string; message: string }
type WaitArgs = { timeout_ms?: number }
type TargetArgs = { target: string }
type TaskCreateArgs = { subject: string; description: string; blocked_by?: string[]; write_scopes?: string[] }
type TaskListArgs = { status?: string; owner?: string; ready?: boolean; cursor?: number; limit?: number }
type TaskGetArgs = { task_id: string }
type TaskUpdateArgs = { task_id: string; expected_revision: number; action: string; subject?: string; description?: string; blocked_by?: string[]; write_scopes?: string[]; owner?: string }

export function createTeamTools(deps: TeamToolDeps): Tool[] {
  const spawn: Tool<SpawnArgs, { member: TeamMemberView }> = {
    name: "spawn_teammate",
    description: "Create one named, durable teammate. Only the Team Lead may call this.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, prompt: { type: "string" }, context: { type: "string", enum: ["fresh", "fork"] }, fork_turns: { type: "string" } }, required: ["name", "description", "prompt"] },
    isReadOnly: false,
    execute: async (args, exec) => ({ member: await deps.roster.spawnTeammate(deps.resolveCaller(exec), args.name, { description: args.description, prompt: args.prompt, ...(args.context ? { context: args.context as "fresh" | "fork" } : {}), ...(args.fork_turns ? { forkTurns: args.fork_turns as never } : {}) }) }),
  }
  const list: Tool<ListArgs, { members: TeamMemberView[] }> = {
    name: "list_members",
    description: "List the Lead and every teammate with current runtime status. Positions are 1-based: the Lead is position #1 and teammates follow in creation order (position #2 and up). Target teammates by name elsewhere.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async (_args, exec) => {
      deps.resolveCaller(exec) // scope gate: identity must resolve before any tool body runs (spec §5); list_members is read-only and caller-less at the domain layer.
      return { members: await deps.roster.listMembers() }
    },
  }
  const send: Tool<SendArgs, { messageId: string; status: "accepted" | "queued" }> = {
    name: "send_message",
    description: "Send durable information to another Team member without starting an idle member.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args, exec) => deps.mailbox.sendMessage(deps.resolveCaller(exec), args.target, args.message, "quiet", exec.abortSignal),
  }
  const followup: Tool<SendArgs, { messageId: string; status: "accepted" | "queued" }> = {
    name: "followup_task",
    description: "Send a durable follow-up task to another Team member and start a turn when needed.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args, exec) => deps.mailbox.sendMessage(deps.resolveCaller(exec), args.target, args.message, "wakeup", exec.abortSignal),
  }
  const wait: Tool<WaitArgs, TeamWaitResult> = {
    name: "wait_agent",
    description: "Wait for the next teammate status, mailbox, or task change after this call starts. Never wakes inactive members: returns noProgress immediately when no other member is running or provisioning — re-list with list_members, use followup_task to wake an inactive teammate, then wait again instead of polling.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number" } } },
    isReadOnly: true,
    execute: async (args, exec) => {
      const caller = deps.resolveCaller(exec)
      // dsh noProgress semantics: short-circuit only when NO OTHER member is
      // running or provisioning. The caller must exclude itself — the lead
      // pseudo-row is status "running" by construction, so a lead caller must
      // not count itself as an active peer.
      const hasActivePeer = () =>
        deps.roster.listMembers().some((m) => m.id !== caller.id && (m.status === "running" || m.status === "provisioning"))
      return deps.activity.waitForChange(caller, args.timeout_ms, exec.abortSignal, hasActivePeer)
    },
  }
  const interrupt: Tool<TargetArgs, { previousStatus: string }> = {
    name: "interrupt_agent",
    description: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args, exec) => deps.roster.interrupt(deps.resolveCaller(exec), args.target),
  }
  const taskCreate: Tool<TaskCreateArgs, TeamTaskView> = {
    name: "team_task_create",
    description: "Create one unowned pending task on the shared team board.",
    inputSchema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } }, write_scopes: { type: "array", items: { type: "string" } } }, required: ["subject", "description"] },
    isReadOnly: false,
    execute: async (args, exec) => deps.taskBoard.createTask(deps.resolveCaller(exec), { subject: args.subject, description: args.description, ...(args.blocked_by ? { blockedBy: args.blocked_by } : {}), ...(args.write_scopes ? { writeScopes: args.write_scopes } : {}) }),
  }
  const taskList: Tool<TaskListArgs, { tasks: TeamTaskView[]; nextCursor?: number }> = {
    name: "team_task_list",
    description: "List shared tasks with readiness, owner, revision, blockers, and write-scope warnings.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" }, ready: { type: "boolean" }, cursor: { type: "number" }, limit: { type: "number" } } },
    isReadOnly: true,
    execute: async (args, exec) => deps.taskBoard.listTasks(deps.resolveCaller(exec), { status: args.status as never, owner: args.owner, ready: args.ready, cursor: args.cursor, limit: args.limit }),
  }
  const taskGet: Tool<TaskGetArgs, TeamTaskView> = {
    name: "team_task_get",
    description: "Read the complete latest value of one shared task before changing it.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    isReadOnly: true,
    execute: async (args, exec) => deps.taskBoard.getTask(deps.resolveCaller(exec), args.task_id),
  }
  const taskUpdate: Tool<TaskUpdateArgs, TeamTaskView> = {
    name: "team_task_update",
    description: "Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, expected_revision: { type: "number" }, action: { type: "string", enum: ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"] }, subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } }, write_scopes: { type: "array", items: { type: "string" } }, owner: { type: "string" } }, required: ["task_id", "expected_revision", "action"] },
    isReadOnly: false,
    execute: async (args, exec) => deps.taskBoard.updateTask(deps.resolveCaller(exec), { taskId: args.task_id, expectedRevision: args.expected_revision, action: args.action as never, ...(args.subject ? { subject: args.subject } : {}), ...(args.description ? { description: args.description } : {}), ...(args.blocked_by ? { blockedBy: args.blocked_by } : {}), ...(args.write_scopes ? { writeScopes: args.write_scopes } : {}), ...(args.owner ? { owner: args.owner } : {}) }),
  }
  return [spawn, list, send, followup, wait, interrupt, taskCreate, taskList, taskGet, taskUpdate]
}
