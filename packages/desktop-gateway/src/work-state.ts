import { foldGoal, type GoalView } from "@i-harness/goal"
import { deriveTodoList, validateTodoItems } from "@i-harness/todo"
import { append, type Session, type TodoItem } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createDurableSessionLoader, type SessionService } from "@i-harness/session-executor"

export interface DesktopWorkStateView {
  todos: TodoItem[] | null
  /** Number of accepted whole-list writes, including legacy model snapshots.
   * Optional only for older read-only peers; editable hosts always return it. */
  todosRevision?: number
  goal: GoalView | null
}

export interface DesktopTodoWriteInput {
  items: TodoItem[]
  expectedRevision: number
}

export class TodoRevisionConflictError extends Error {
  readonly code = "TODO_REVISION_CONFLICT"
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Todo list changed (revision ${actualRevision}). Reload it before saving your edit.`)
    this.name = "TodoRevisionConflictError"
  }
}

function view(session: Session): DesktopWorkStateView {
  return {
    todos: deriveTodoList(session)?.map((item) => ({ ...item })) ?? null,
    todosRevision: session.events.filter((event) => event.type === "todo/write").length,
    goal: foldGoal(session.events),
  }
}

function validatedInput(input: DesktopTodoWriteInput): DesktopTodoWriteInput {
  if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("todo: expectedRevision must be a non-negative integer")
  if (!Array.isArray(input.items)) throw new Error("todo: items must be an array")
  const items = input.items.map((item) => {
    if (!item || typeof item.content !== "string" || !["pending", "in_progress", "completed"].includes(item.status)) throw new Error("todo: each item needs content and a valid status")
    return { content: item.content.trim(), status: item.status }
  })
  validateTodoItems(items, false)
  return { items, expectedRevision: input.expectedRevision }
}

/** Session events own Todo and Goal state. Reads scan the full log. Human
 * replacements carry their displayed revision so a stale editor cannot erase
 * a newer human or model snapshot. Hosts should share sessionFor with their
 * SessionService to keep cold edits and simultaneous model startup on one log. */
export function createDesktopWorkState(coordinator: SessionCoordinator, service: SessionService, options: { sessionFor?: (sessionId: string) => Promise<Session> } = {}) {
  const sessionFor = options.sessionFor ?? createDurableSessionLoader(coordinator)
  const writes = new Map<string, Promise<void>>()
  return {
    async read(sessionId: string): Promise<DesktopWorkStateView> {
      await coordinator.profile(sessionId)
      const session = service.liveSession(sessionId) ?? (options.sessionFor
        ? await sessionFor(sessionId)
        : (await (coordinator.snapshot?.(sessionId) ?? coordinator.load(sessionId))).session)
      return view(session)
    },
    async writeTodos(sessionId: string, input: DesktopTodoWriteInput): Promise<DesktopWorkStateView> {
      const { items, expectedRevision } = validatedInput(input)
      const previous = writes.get(sessionId) ?? Promise.resolve()
      const gate = Promise.withResolvers<void>()
      writes.set(sessionId, gate.promise)
      await previous
      try {
        await coordinator.profile(sessionId)
        const restored = service.liveSession(sessionId) ?? await sessionFor(sessionId)
        const session = service.liveSession(sessionId) ?? restored
        const actualRevision = view(session).todosRevision!
        if (actualRevision !== expectedRevision) throw new TodoRevisionConflictError(expectedRevision, actualRevision)
        // No await between compare and append: a live model tool cannot write
        // between the revision check and this whole-list replacement.
        append(session, { type: "todo/write", version: 1, items })
        await coordinator.flush(sessionId)
        return view(session)
      } finally {
        gate.resolve()
        if (writes.get(sessionId) === gate.promise) writes.delete(sessionId)
      }
    },
  }
}
