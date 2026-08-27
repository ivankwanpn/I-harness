// M21: `todo_write` — a whole-list snapshot tool. Every call REPLACES the
// previous todo list entirely (the model must send the WHOLE list), which keeps
// status tracking race-free: no merge logic, last write wins. The list lives in
// the session log as `todo/write` events (core-session), so projection
// (deriveTodoList) is a pure function and persistence mirrors it for free.
import type { Session, TodoItem } from "@i-harness/core-session"
import { append } from "@i-harness/core-session" // 只用 append（deriveMessages 不需要——todo 事件 model-visible 外的存活由 deriveMessages 的 default-skip 保證）
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
