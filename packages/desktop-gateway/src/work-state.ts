import { foldGoal, type GoalView } from "@i-harness/goal"
import { deriveTodoList, validateTodoItems } from "@i-harness/todo"
import { committedFactSeqs, type SessionView as Session, type TodoItem } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { actionMetadataFacts, type SessionService } from "@i-harness/session-executor"
import {createOwnedWorkState,TodoRevisionConflictError} from './owned-work-state.ts'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
export {TodoRevisionConflictError} from './owned-work-state.ts'

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

/** Inspection uses an available original managed fold, otherwise the coordinator's
 * committed snapshot. Human replacements retain their displayed revision
 * through admission so they cannot erase a newer accepted snapshot. Read-only
 * inspection never enters the writable loader or constructs an assembly. */
export function createDesktopWorkState(coordinator: SessionCoordinator, _service: SessionService, options: { sessionFor?: (sessionId: string) => Promise<Session>;managed?:{
  /** Read-only lookup of an already-held original attachment; no new-work admission. */
  current(sessionId:string):ManagedExecutionAttachment|undefined
  retain(sessionId:string,execution:ManagedExecutionAttachment,cleanup:()=>Promise<void>):void
} } = {}) {
  const writes = new Map<string, Promise<void>>()
  let closed=false
  const current=options.managed?.current.bind(options.managed),retain=options.managed?.retain.bind(options.managed)
  const owned=new Map<string,{execution:ManagedExecutionAttachment;adapter:ReturnType<typeof createOwnedWorkState>;close():Promise<void>}>()
  async function managedFor(id:string){
    if(closed)throw Object.assign(new Error('Work-state is closed'),{code:'FACT_CLOSED'})
    const execution=current?.(id),previous=owned.get(id)
    if(previous){if(previous.execution!==execution)throw Object.assign(new Error('Original work-state owner retirement requires recovery'),{code:'FACT_RECOVERY_REQUIRED'});return previous.adapter}
    if(!execution)return
    if(!retain)throw TypeError('Original work-state cleanup retention required')
    const adapter=createOwnedWorkState(execution,()=>current?.(id)===execution),closeAdapter=adapter.close.bind(adapter)
    const row={execution,adapter,async close(){await closeAdapter();if(owned.get(id)===row)owned.delete(id)}}
    owned.set(id,row)
    try{retain(id,execution,row.close)}catch(error){try{await row.close()}catch(cleanup){throw new AggregateError([error,cleanup],'Work-state construction cleanup requires recovery',{cause:error})}throw error}
    return adapter
  }
  return {
    async read(sessionId: string): Promise<DesktopWorkStateView> {
      const managed = await managedFor(sessionId)
      if (managed) return managed.read()
      await coordinator.profile(sessionId)
      if (!coordinator.snapshot) throw new Error("Read-only work-state snapshots unavailable")
      return view((await coordinator.snapshot(sessionId)).session)
    },
    async writeTodos(sessionId: string, input: DesktopTodoWriteInput): Promise<DesktopWorkStateView> {
      const { items, expectedRevision } = validatedInput(input)
      const previous = writes.get(sessionId) ?? Promise.resolve()
      const gate = Promise.withResolvers<void>()
      writes.set(sessionId, gate.promise)
      await previous
      try {
        const managed=await managedFor(sessionId)
        if(managed)return await managed.writeTodos({items,expectedRevision})
        await coordinator.profile(sessionId)
        // The cold path writes through the coordinator document directly: the
        // service's writable sessionmarks the session as a complete selection
        // and would refuse the managed runtime for every later turn.
        const document = await coordinator.openManagedDocument(sessionId)
        try {
          const session = document.view as unknown as Session
          const actualRevision = view(session).todosRevision!
          if (actualRevision !== expectedRevision) throw new TodoRevisionConflictError(expectedRevision, actualRevision)
          committedFactSeqs(await actionMetadataFacts(document).admit({ type: "todo/write", version: 1, items }))
          return view(document.view as unknown as Session)
        } finally { await coordinator.closeManagedDocument?.(sessionId).catch(() => {}) }
      } finally {
        gate.resolve()
        if (writes.get(sessionId) === gate.promise) writes.delete(sessionId)
      }
    },
    async close(){closed=true;for(const row of [...owned.values()].reverse())await row.close()},
  }
}
