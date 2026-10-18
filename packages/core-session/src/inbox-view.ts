import type { DeepReadonly, SessionView } from './managed/types.ts'
import type { PendingInput } from './inbox.ts'

/** Sole readonly pending fold. Observation never acquires mutation authority. */
export function readInbox(session: SessionView, fromSeq = 0) {
  const pending = (): readonly DeepReadonly<PendingInput>[] => {
    const inputs = new Map<string, DeepReadonly<PendingInput>>()
    for (const event of session.events) {
      if (event.type === 'agent/input/promoted' || event.type === 'agent/input/cancelled') inputs.delete(event.inputId)
      if (event.type !== 'agent/input/admitted' || (event.seq ?? 0) < fromSeq) continue
      const { seq, type: _type, version: _version, ignorable: _ignorable, ...input } = event
      inputs.set(event.inputId, { ...input, admittedSeq: seq ?? 0 })
    }
    return [...inputs.values()]
  }
  return { pending, isPending: (inputId: string) => pending().some(input => input.inputId === inputId) }
}
