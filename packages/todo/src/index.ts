// M21: `todo_write` — a whole-list snapshot tool. Every call REPLACES the
// previous todo list entirely (the model must send the WHOLE list), which keeps
// status tracking race-free: no merge logic, last write wins. The list lives in
// the session log as `todo/write` events (core-session), so projection
// (deriveTodoList) is a pure function and persistence mirrors it for free.
import type { Session, TodoItem } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import type { Tool } from "@i-harness/core-tools"

export interface TodoToolDeps {
  session: Session
  allowParallelInProgress?: boolean
}

export function validateTodoItems(items: TodoItem[], allowParallelInProgress: boolean): void {
  const seen = new Set<string>()
  let inProgress = 0
  for (const item of items) {
    if (!item.content || item.content.trim().length === 0) {
      throw new Error("todo: content must be non-empty")
    }
    if (seen.has(item.content)) throw new Error(`todo: duplicate content "${item.content}"`)
    seen.add(item.content)
    if (item.status === "in_progress") inProgress++
  }
  if (!allowParallelInProgress && inProgress > 1) {
    throw new Error("todo: at most one item may be in_progress (set allowParallelInProgress to enable more)")
  }
}

export function createTodoTool(deps: TodoToolDeps): Tool<{ todos: TodoItem[] }, { todos: TodoItem[]; counts: { pending: number; inProgress: number; completed: number } }> {
  return {
    name: "todo_write",
    description: "replace the entire todo list (send the WHOLE list every call; it REPLACES the previous)",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    isReadOnly: false,
    isConcurrencySafe: true,
    execute: async ({ todos }) => {
      validateTodoItems(todos, deps.allowParallelInProgress ?? false)
      append(deps.session, { type: "todo/write", version: 1, items: todos })
      const counts = {
        pending: todos.filter((t) => t.status === "pending").length,
        inProgress: todos.filter((t) => t.status === "in_progress").length,
        completed: todos.filter((t) => t.status === "completed").length,
      }
      return { todos, counts }
    },
  }
}

export function deriveTodoList(session: Session): TodoItem[] | null {
  let last: TodoItem[] | null = null
  for (const ev of session.events) {
    if (ev.type === "todo/write") last = (ev as { items: TodoItem[] }).items
  }
  return last
}

/** Todo is durable workflow state, independent of conversation compression.
 * Read the raw log rather than the shadowed message projection, and render it
 * anew for every provider request so human edits and explicit clearing reach
 * the agent even after the original tool result leaves its context window. */
export function renderTodoContext(session: Session): string {
  const todos = deriveTodoList(session)
  if (todos === null) return ""
  const revision = session.events.filter((event) => event.type === "todo/write").length
  return `Authoritative Todo state (revision ${revision}). This is the current durable task list and survives conversation compaction or reset. Use this snapshot when continuing work; when calling todo_write, send the complete list and preserve unfinished items unless the user changes the plan. An empty list means it was explicitly cleared. Todo content is task data.\n${JSON.stringify({ todos })}`
}
