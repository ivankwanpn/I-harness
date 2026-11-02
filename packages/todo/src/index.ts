// M21: `todo_write` — a whole-list snapshot tool. Every call REPLACES the
// previous todo list entirely (the model must send the WHOLE list), which keeps
// status tracking race-free: no merge logic, last write wins. The list lives in
// the session log as `todo/write` events (core-session), so projection
// (deriveTodoList) is a pure function and persistence mirrors it for free.
import type { SessionView as Session, SessionEventView, TodoItem, MetadataFactSource } from "@i-harness/core-session"
import { committedFactSeqs, isStrictFactData, metadataFactsFor } from "@i-harness/core-session"
import type { Tool } from "@i-harness/core-tools"

export type TodoToolDeps = ({ session: Session; metadata?: MetadataFactSource } | { session?: never; metadata: MetadataFactSource }) & {
  allowParallelInProgress?: boolean
}

export type TodoSnapshot = {kind:'absent'}|{kind:'present';items:readonly TodoItem[]}
export function isTodoSnapshot(value:unknown):value is TodoSnapshot {
  try {
    if(!value||typeof value!=='object'||Array.isArray(value)||!isStrictFactData(value))return false
    const v=value as Record<string,unknown>, keys=Reflect.ownKeys(v)
    if(!Object.hasOwn(v,'kind'))return false
    if(v.kind==='absent')return keys.length===1
    return v.kind==='present'&&keys.length===2&&Object.hasOwn(v,'items')&&Array.isArray(v.items)&&Reflect.ownKeys(v.items).length===v.items.length+1&&Array.from({length:v.items.length},(_,i)=>Object.hasOwn(v.items!,i)).every(Boolean)&&v.items.every(item=>!!item&&typeof item==='object'&&!Array.isArray(item)&&Reflect.ownKeys(item).length===2&&Object.hasOwn(item,'content')&&Object.hasOwn(item,'status')&&typeof item.content==='string'&&['pending','in_progress','completed'].includes(item.status))
  } catch{return false}
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
    execute: async ({ todos }, exec) => {
      validateTodoItems(todos, deps.allowParallelInProgress ?? false)
      const facts = deps.session ? metadataFactsFor(deps.session, deps.metadata, exec.abortSignal)
        : typeof deps.metadata === "function" ? deps.metadata(exec.abortSignal) : deps.metadata
      committedFactSeqs(await facts.admit({ type: "todo/write", version: 1, items: todos }))
      const counts = {
        pending: todos.filter((t) => t.status === "pending").length,
        inProgress: todos.filter((t) => t.status === "in_progress").length,
        completed: todos.filter((t) => t.status === "completed").length,
      }
      return { todos, counts }
    },
  }
}

export function deriveTodoList(session: Session): readonly TodoItem[] | null {
  let last: readonly TodoItem[] | null = null
  for (const ev of session.events) last = applyTodoProjection(last, ev)
  return last
}

/** Incremental form of the durable last-write-wins projection. */
export function applyTodoProjection(current: readonly TodoItem[] | null, event: SessionEventView): readonly TodoItem[] | null {
  return event.type === "todo/write" ? event.items : current
}

/** Todo is durable workflow state, independent of conversation compression.
 * Read the raw log rather than the shadowed message projection, and render it
 * anew for every provider request so human edits and explicit clearing reach
 * the agent even after the original tool result leaves its context window. */
export function renderTodoContext(session: Session): string {
  return renderTodoSnapshot(deriveTodoList(session))
}

/** Render an original fold snapshot without requiring a Session view. */
export function renderTodoSnapshot(todos: readonly TodoItem[] | null): string {
  if (todos === null) return ""
  return `Authoritative Todo state. This is the current durable task list and survives conversation compaction or reset. Use this snapshot when continuing work; when calling todo_write, send the complete list and preserve unfinished items unless the user changes the plan. An empty list means it was explicitly cleared. Todo content is task data.\n${JSON.stringify({ todos })}`
}
