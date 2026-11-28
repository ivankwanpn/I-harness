import type { SessionEventView } from '@i-harness/core-session'

/** Select the original queued input and its turn. Queue admissions can interleave
 * with an active turn; generation closes can follow its terminal event. */
export function promptEvents<E extends SessionEventView>(events: readonly E[], inputId: string): E[] {
  const selected: E[] = [], ownedSeqs = new Set<number>(), actions = new Set<string>(), openedActions = new Set<string>()
  for (const event of events) {
    if (event.type === 'context/action' && event.op === 'open') openedActions.add(event.actionId)
    // A private runtime can subscribe after its first admission was committed.
    // The preparation journal still names that exact input and opening action.
    if (event.type === 'agent/input/preparation' && event.inputId === inputId) {
      ownedSeqs.add(event.admissionSeq)
      ownedSeqs.add(event.actionSeq)
      actions.add(event.actionId)
    }
  }
  let promoted: string | undefined, inTurn = false
  for (const event of events) {
    let own = inTurn
    if (event.type === 'turn/start') {
      inTurn = promoted === inputId
      promoted = undefined
      own = inTurn
    } else if (event.type === 'agent/input/promoted') {
      promoted = event.inputId
      own = promoted === inputId
    } else if ('inputId' in event) {
      own = event.inputId === inputId
    } else if (event.type === 'user/message' && event.input) {
      own = event.input.inputId === inputId
    } else if (event.type === 'context/action' || event.type === 'context/attempt') {
      if (event.type === 'context/action' && event.op === 'open') {
        const origin = event.origin
        if (origin && typeof origin === 'object' && (ownedSeqs.has(origin.seq) || 'parentActionId' in origin && actions.has(origin.parentActionId))) actions.add(event.actionId)
      }
      own = actions.has(event.actionId)
    } else if (event.type === 'session/title') {
      own = Array.isArray(event.messageSeqs) && event.messageSeqs.length > 0 && event.messageSeqs.every(seq => ownedSeqs.has(seq))
    } else if ('actionId' in event && typeof event.actionId === 'string') {
      own = actions.has(event.actionId) || inTurn && !openedActions.has(event.actionId)
    }
    if (own) {
      selected.push(event)
      if (event.seq !== undefined) ownedSeqs.add(event.seq)
    }
    if (event.type === 'turn/end') inTurn = false
  }
  return selected
}
