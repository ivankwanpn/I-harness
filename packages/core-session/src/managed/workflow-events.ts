import type { SessionEventView, SessionView } from './types.ts'

export type WorkflowEventType = 'plan/mode' | 'todo/write' | 'goal/change'
type WorkflowEventsReader = (type: WorkflowEventType) => readonly SessionEventView[] | undefined
const originalReaders = new WeakMap<SessionView, WorkflowEventsReader>()

/** The original managed constructor installs the only read link for its view. */
export function associateManagedWorkflowEvents(view: SessionView, read: WorkflowEventsReader): void {
  if (originalReaders.has(view)) throw new TypeError('Managed workflow reader already associated')
  originalReaders.set(view, read)
}

export function readManagedWorkflowEvents(view: SessionView, type: WorkflowEventType): readonly SessionEventView[] | undefined {
  return originalReaders.get(view)?.(type)
}
