import type { Session, SessionHeader } from '../events/types.ts'
import type { SessionEventView } from './types.ts'
import { managedSessions, managedFactOwners, conversationIndexes, appendHooks, subscribers } from '../events/state.ts'
import { createBootstrapConversationIndex, createConversationIndex } from '../conversation/validation.ts'
import { captureLegacyFact } from './capture.ts'
import { hasNondurableFactOwner } from './nondurable.ts'

export interface MemoryBootstrapReceipt { kind: 'memory-ready'; seedLength: number; initial?: { inputId: string; seq: number; startedAt: number; expiresAt: number } }
/** A single synchronous standalone installation, over the existing index owner.
 * No partial target is observable and this produces no durable FactReceipt. */
export function bootstrapMemorySession(session: Session, header: SessionHeader, recordsWithCompletion: readonly SessionEventView[], current: () => boolean): MemoryBootstrapReceipt {
  const installable = () => {
    const fields = Object.getOwnPropertyDescriptors(session), events = fields.events, header = fields.header
    if (managedSessions.has(session) || managedFactOwners.has(session) || hasNondurableFactOwner(session) || conversationIndexes.has(session)
      || !events || !('value' in events) || !events.writable || !events.enumerable || !Array.isArray(events.value) || events.value.length
      || header && (!('value' in header) || !header.writable || !header.enumerable || header.value !== undefined)
      || fields.formatVersion?.value !== 11 || !Object.isExtensible(session)) throw new TypeError('Bootstrap requires a pristine unbound installable memory session')
    return events.value as Session['events']
  }
  const originalEvents = installable()
  const captured = captureLegacyFact({ header, events: recordsWithCompletion })
  if (captured.kind !== 'captured') throw new TypeError('Invalid bootstrap data')
  const candidate = { formatVersion: session.formatVersion, header: captured.value.header, events: [...captured.value.events] } as Session
  const staging = createBootstrapConversationIndex([], undefined, session.formatVersion, candidate.header!)
  staging.stage(candidate.events).commit()
  const index = createConversationIndex(candidate.events, position => session.events[position], session.formatVersion, candidate.header)
  const reservation = candidate.header!.semanticSeed
  if (!reservation) throw new TypeError('Bootstrap reservation required')
  if (!current()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' })
  if (installable() !== originalEvents) throw new TypeError('Bootstrap target changed')
  session.header = candidate.header
  session.events = candidate.events
  conversationIndexes.set(session, { formatVersion: session.formatVersion, events: session.events, index })
  for (const event of session.events) for (const observer of [appendHooks.get(session), ...subscribers.get(session) ?? []]) {
    if (observer) try { Promise.resolve(observer(event)).catch(() => {}) } catch { /* Observers cannot undo complete installation. */ }
  }
  return { kind: 'memory-ready', seedLength: reservation.seedLength, ...(reservation.initialInputId === undefined ? {} : { initial: {
    inputId: reservation.initialInputId, seq: reservation.seedLength + 1, startedAt: reservation.initialStartedAt!, expiresAt: reservation.initialExpiresAt!,
  } }) }
}
