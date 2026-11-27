import type { SessionEventView, SessionView } from './types.ts'

export type WorkflowEventType = 'plan/mode' | 'todo/write' | 'goal/change'
export type CommittedEventGroup = WorkflowEventType | 'assessment'
type CommittedEventsReader = (group: CommittedEventGroup) => readonly SessionEventView[] | undefined
const originalReaders = new WeakMap<SessionView, CommittedEventsReader>()

/** The original managed constructor installs the only read link for its view. */
export function associateManagedCommittedEvents(view: SessionView, read: CommittedEventsReader): void {
  if (originalReaders.has(view)) throw new TypeError('Managed event reader already associated')
  originalReaders.set(view, read)
}

export function readManagedWorkflowEvents(view: SessionView, type: WorkflowEventType): readonly SessionEventView[] | undefined {
  return originalReaders.get(view)?.(type)
}

/** Usage and recovery markers share the physical order used by budget revisions. */
export function readManagedAssessmentEvents(view: SessionView): readonly SessionEventView[] | undefined {
  return originalReaders.get(view)?.('assessment')
}
