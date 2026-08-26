import { randomUUID } from "node:crypto"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamTaskSnapshot, type TeamTaskStatus, type TeamTaskView } from "./types.ts"
import type { TeamFoldState } from "./fold.ts"
import type { TeamTransaction } from "./transact.ts"

export type TaskAction = "claim" | "release" | "edit" | "set_dependencies" | "complete" | "reopen" | "reassign" | "delete"

// Advisory write-scope normalization: backslashes → slashes, leading "./" and
// trailing "/" stripped, then invalid scopes rejected (absolute, parent
// traversal, empty, drive-letter paths) — an invalid scope THROWS rather than
// silently dropping the entry (callers must not lose a permission silently).
export function normalizeWriteScopes(scopes: string[]): string[] {
  const out: string[] = []
  for (const raw of scopes) {
    const s = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
    if (s.length === 0 || s.startsWith("/") || s.includes("..") || /^[a-zA-Z]:(\/|$)/.test(s)) {
      throw new TeamError(TEAM_CODES.INVALID_WRITE_SCOPE, `invalid write scope ${JSON.stringify(raw)}`)
    }
    out.push(s)
  }
  return out
}

export interface TaskBoardDeps {
  teamId: string
  state: TeamFoldState
  transact: TeamTransaction
  maxTasks?: number
}

export function createTaskBoard(deps: TaskBoardDeps) {
  const maxTasks = deps.maxTasks ?? 256

  function memberName(id: string): string | undefined {
    return [...deps.state.members.values()].find((m) => m.id === id)?.name
  }

  // Advisory projection over a committed snapshot: ready = all blockers
  // completed (vacuous true with no blockers); writeScopeWarnings = scope
  // overlap with other in_progress tasks (warnings never block anything).
  // Blockers are resolved against the live state; a missing blocker
  // (tombstoned concurrently) reads as not-ready.
  function view(task: TeamTaskSnapshot): TeamTaskView {
    const blockers = task.blockedBy.map((b) => deps.state.tasks.get(b))
    const ready = blockers.every((b) => b !== undefined && b.status === "completed")
    const warnings: string[] = []
    for (const [id, other] of deps.state.tasks) {
      if (id === task.id || other.status !== "in_progress") continue
      for (const scope of task.writeScopes) {
        if (other.writeScopes.some((s) => s === scope || s.startsWith(scope + "/") || scope.startsWith(s + "/"))) {
          warnings.push(`write scopes overlap with ${id}`)
        }
      }
    }
    return { ...task, ...(task.ownerId !== undefined ? { ownerName: memberName(task.ownerId) } : {}), ready, writeScopeWarnings: [...new Set(warnings)] }
  }

  async function createTask(
    caller: TeamCaller,
    opts: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[] },
  ): Promise<TeamTaskView> {
    void caller
    const id = `task-${randomUUID()}`
    let committed: TeamTaskSnapshot | undefined
    // Pure-read transact fn: limit, blocker existence/self/dup checks against
    // the snapshot (serialized, authoritative); nothing is mutated.
    await deps.transact.transact((state) => {
      const nonDeleted = [...state.tasks.values()].filter((t) => t.status !== "deleted").length
      if (nonDeleted >= maxTasks) throw new TeamError(TEAM_CODES.TASK_LIMIT, `maxTasks ${maxTasks} reached`)
      const blockedBy = opts.blockedBy ?? []
      if (blockedBy.includes(id)) throw new TeamError(TEAM_CODES.TASK_DEPENDENCY_CYCLE, `task "${id}" cannot depend on itself`)
      if (new Set(blockedBy).size !== blockedBy.length) throw new TeamError(TEAM_CODES.INVALID_ARGUMENT, "duplicate blockedBy entries")
      for (const b of blockedBy) {
        const t = state.tasks.get(b)
        if (!t || t.status === "deleted") throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `blocker "${b}" does not exist`)
      }
      committed = {
        id,
        revision: 1,
        subject: opts.subject,
        description: opts.description,
        status: "pending",
        blockedBy,
        writeScopes: normalizeWriteScopes(opts.writeScopes ?? []),
      }
      return { events: [{ type: "team/task", version: 1, teamId: deps.teamId, task: committed }], result: undefined }
    })
    return view(committed!)
  }

  async function getTask(caller: TeamCaller, id: string): Promise<TeamTaskView> {
    void caller
    const task = deps.state.tasks.get(id)
    if (!task) throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `no task "${id}"`)
    return view(task)
  }

  async function listTasks(
    caller: TeamCaller,
    opts?: { status?: TeamTaskStatus; owner?: string; ready?: boolean; cursor?: number; limit?: number },
  ): Promise<{ tasks: TeamTaskView[]; nextCursor?: number }> {
    void caller
    const statuses: TeamTaskStatus[] = opts?.status !== undefined ? [opts.status] : ["pending", "in_progress", "completed"]
    const all = [...deps.state.tasks.values()]
      .filter((t) => statuses.includes(t.status))
      .filter((t) => opts?.owner === undefined || (opts.owner === "unowned" ? t.ownerId === undefined : t.ownerId !== undefined && memberName(t.ownerId) === opts.owner))
      .map((t) => view(t))
      .filter((t) => opts?.ready === undefined || t.ready === opts.ready)
    const cursor = opts?.cursor ?? 0
    const limit = opts?.limit ?? 50
    return { tasks: all.slice(cursor, cursor + limit), ...(cursor + limit < all.length ? { nextCursor: cursor + limit } : {}) }
  }

  // does making `taskId` depend on `blockedBy` close a cycle? DFS over the
  // current dependency graph (blockers of blockers); reaching taskId = cycle.
  function createsCycle(state: TeamFoldState, taskId: string, blockedBy: string[]): boolean {
    const seen = new Set<string>()
    const pending = [...blockedBy]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (current === taskId) return true
      if (seen.has(current)) continue
      seen.add(current)
      const deps_ = state.tasks.get(current)?.blockedBy ?? []
      pending.push(...deps_)
    }
    return false
  }

  async function updateTask(
    caller: TeamCaller,
    req: { taskId: string; expectedRevision: number; action: TaskAction; subject?: string; description?: string; blockedBy?: string[]; writeScopes?: string[]; owner?: string },
  ): Promise<TeamTaskView> {
    let committed: TeamTaskSnapshot | undefined
    // Pure-read transact fn: EVERY guard (existence, tombstone, CAS revision,
    // ownership/authority, readiness, dependents, cycles) is checked against
    // the snapshot the event will be validated against — serialized, so a
    // concurrent update bumps the revision and the CAS re-check wins.
    await deps.transact.transact((state) => {
      const existing = state.tasks.get(req.taskId)
      if (!existing) throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `no task "${req.taskId}"`)
      if (existing.status === "deleted") throw new TeamError(TEAM_CODES.TASK_DELETED, `task "${req.taskId}" is deleted`)
      if (req.expectedRevision !== existing.revision) {
        throw new TeamError(TEAM_CODES.TASK_STALE_REVISION, `task ${req.taskId} revision ${existing.revision} (expected ${req.expectedRevision})`)
      }
      const isOwner = existing.ownerId !== undefined && existing.ownerId === caller.id
      const isLead = caller.role === "lead"
      const unauthorized = () => new TeamError(TEAM_CODES.TASK_UNAUTHORIZED, "owner or Lead may perform this action")

      let next: TeamTaskSnapshot
      switch (req.action) {
        case "claim": {
          if (existing.ownerId !== undefined) throw new TeamError(TEAM_CODES.TASK_ALREADY_CLAIMED, `task "${req.taskId}" already claimed`)
          const ready = existing.blockedBy.every((b) => {
            const t = state.tasks.get(b)
            return t !== undefined && t.status === "completed"
          })
          if (!ready) throw new TeamError(TEAM_CODES.TASK_BLOCKED, `task "${req.taskId}" is blocked by incomplete prerequisites`)
          next = { ...existing, status: "in_progress", ownerId: caller.id }
          break
        }
        case "release": {
          if (!isOwner && !isLead) throw unauthorized()
          next = { ...existing, status: "pending", ownerId: undefined }
          break
        }
        case "complete": {
          if (!isOwner && !isLead) throw unauthorized()
          next = { ...existing, status: "completed" }
          break
        }
        case "reopen": {
          if (!isOwner && !isLead) throw unauthorized()
          next = { ...existing, status: "pending", ownerId: undefined }
          break
        }
        case "edit": {
          if (!isOwner && !isLead) throw unauthorized()
          next = {
            ...existing,
            subject: req.subject ?? existing.subject,
            description: req.description ?? existing.description,
            writeScopes: req.writeScopes !== undefined ? normalizeWriteScopes(req.writeScopes) : existing.writeScopes,
          }
          break
        }
        case "set_dependencies": {
          if (!isOwner && !isLead) throw unauthorized()
          const blockedBy = req.blockedBy ?? []
          for (const b of blockedBy) {
            const t = state.tasks.get(b)
            if (!t || t.status === "deleted") throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `blocker "${b}" does not exist`)
          }
          if (blockedBy.includes(existing.id)) throw new TeamError(TEAM_CODES.TASK_DEPENDENCY_CYCLE, `task "${req.taskId}" cannot depend on itself`)
          if (new Set(blockedBy).size !== blockedBy.length) throw new TeamError(TEAM_CODES.INVALID_ARGUMENT, "duplicate blockedBy entries")
          if (createsCycle(state, existing.id, blockedBy)) throw new TeamError(TEAM_CODES.TASK_DEPENDENCY_CYCLE, `task "${req.taskId}" dependency cycle`)
          next = { ...existing, blockedBy }
          break
        }
        case "reassign": {
          if (!isLead) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Lead may reassign tasks")
          let ownerId: string | undefined
          if (req.owner !== undefined) {
            const member = [...state.members.values()].find((m) => m.name === req.owner)
            if (!member) throw new TeamError(TEAM_CODES.INVALID_ARGUMENT, `unknown owner "${req.owner}"`)
            ownerId = member.id
          }
          next = { ...existing, ownerId }
          break
        }
        case "delete": {
          if (!isOwner && !isLead) throw unauthorized()
          const hasDependents = [...state.tasks.values()].some((t) => t.status !== "deleted" && t.blockedBy.includes(existing.id))
          if (hasDependents) throw new TeamError(TEAM_CODES.TASK_HAS_DEPENDENTS, `task "${req.taskId}" has non-deleted dependents`)
          next = { ...existing, status: "deleted" }
          break
        }
        default:
          throw new TeamError(TEAM_CODES.TASK_INVALID_TRANSITION, `invalid action "${req.action}"`)
      }
      committed = { ...next, revision: existing.revision + 1 }
      return { events: [{ type: "team/task", version: 1, teamId: deps.teamId, task: committed }], result: undefined }
    })
    return view(committed!)
  }

  return { createTask, getTask, listTasks, updateTask }
}
