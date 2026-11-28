import type { SessionEventView, SessionView } from '@i-harness/core-session'
import { readManagedConversationObservationFrontier } from '@i-harness/core-session/internal/restoration'
import type { ChildAgentEntry } from '../agent-table.ts'

type InboxEvent = Extract<SessionEventView, { type: 'subagent/inbox' }>

export function pendingInboxEvents(view: SessionView, cursor: number, sessionId?: string, start = 0): InboxEvent[] {
  const events = view.events
  // Only a qualified original prefix proves every seq is positional. Even
  // a managed legacy view may have gaps or a higher seq before the cursor.
  const positional = Number.isSafeInteger(cursor) && cursor >= start && sessionId !== undefined
    && readManagedConversationObservationFrontier(view, sessionId) !== undefined
  const afterCursor = positional ? cursor + 1 : 0
  const first = Math.max(view.header?.seedLength ?? 0, afterCursor, start)
  const pending: InboxEvent[] = []
  for (let index = first; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'subagent/inbox' && (event.seq ?? 0) > cursor) pending.push(event)
  }
  return pending
}

// A second send can commit before the first sender observes its receipt.
// Track the journal prefix already mirrored, so either acknowledgment can
// pick up both inputs in their original order without duplicating either.
type MirroredInbox = { view: SessionView; events: SessionView['events']; seedLength: number; cursor: number; count: number; messages: string[]; unmatched: string[] }
const mirrored = new WeakMap<ChildAgentEntry, MirroredInbox>()

function sameMessages(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index])
}

// Pre-journal snapshots could carry mailbox-only messages. Preserve any
// such occurrences as evidence. Only an actual inbox fact can start a turn.
function unmatchedMessages(saved: readonly string[], view: SessionView): string[] {
  if (!saved.length) return []
  const occurrences = new Map<string, number>()
  for (const event of pendingInboxEvents(view, -1)) {
    occurrences.set(event.message, (occurrences.get(event.message) ?? 0) + 1)
  }
  return saved.filter(message => {
    const count = occurrences.get(message) ?? 0
    if (!count) return true
    occurrences.set(message, count - 1)
    return false
  })
}

export function pendingMailbox(entry: ChildAgentEntry, view = entry.session, cursor = entry.lastInboxSeq ?? -1): string[] {
  const events = view.events, count = events.length, seedLength = view.header?.seedLength ?? 0
  const previous = mirrored.get(entry)
  const original = previous?.view === view && previous.events === events && previous.seedLength === seedLength && previous.count <= count
    && sameMessages(entry.mailbox, previous.messages)
  const extend = original && previous.cursor === cursor
  if (extend && previous.count === count) return entry.mailbox

  const unmatched = original ? previous.unmatched : unmatchedMessages(entry.mailbox, view)
  const pending = pendingInboxEvents(view, cursor, entry.sessionId, extend ? previous.count : 0)
  const added = pending.map(event => event.message)
  const prior = extend ? previous.messages : unmatched
  const messages = added.length ? prior.concat(added) : prior
  mirrored.set(entry, { view, events, seedLength, cursor, count, messages, unmatched })
  // Public entries retain their mutable compatibility array. It cannot
  // alias the cache used to decide which journal facts are still pending.
  return sameMessages(entry.mailbox, messages) ? entry.mailbox : [...messages]
}

export function advanceInboxCursor(entry: ChildAgentEntry, seq: number): void {
  const mailbox = pendingMailbox(entry, entry.session, seq)
  entry.lastInboxSeq = seq
  entry.mailbox = mailbox
}
