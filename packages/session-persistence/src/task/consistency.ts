import { validDeliveryEvent, type SessionEventView } from '@i-harness/core-session'
import type { TaskProtocolDocument } from './types.ts'

/** Pure calculation over history already validated by its original journal owner.
 * This function neither establishes completeness nor grants transition authority. */
export function calculateTaskDocumentConsistency(parent: string, events: readonly SessionEventView[], seedLength: number, value: unknown) {
  if (!parent || !Number.isSafeInteger(seedLength) || seedLength < 0 || seedLength > events.length) throw new Error('Invalid task history scope')
  const ids = new Set<string>()
  for (let index = seedLength; index < events.length; index++) {
    const event = events[index]!
    if ((event.type === 'subagent/start' || event.type === 'subagent/end') && event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq < 0)) throw new Error('Invalid local task sequence')
    if (event.type === 'subagent/start') {
      if (event.version !== 1 || typeof event.taskId !== 'string' || !event.taskId || typeof event.agentPath !== 'string' || !event.agentPath || typeof event.role !== 'string' || !event.role || typeof event.description !== 'string' || event.parentSessionId !== undefined && event.parentSessionId !== parent) throw new Error('Invalid local task start')
      ids.add(event.taskId)
    } else if (event.type === 'subagent/end') {
      if (event.version !== 1 || typeof event.taskId !== 'string' || !event.taskId || !['completed', 'error', 'cancelled', 'recovery-required'].includes(event.outcome)) throw new Error('Invalid local task end')
      ids.add(event.taskId)
    } else if (event.type === 'agent/delivery-source') {
      if (!validDeliveryEvent(event) || event.recipientSessionId !== parent) throw new Error('Foreign or invalid task delivery')
      // Exec reference/terminal proof stays in the original closed delivery
      // index. Only genuine subagent facts require TaskRegistry membership.
      if (event.kind === 'subagent') ids.add(event.sourceId)
    } else if (event.type === 'agent/delivery-received') {
      if (!validDeliveryEvent(event) || event.key.recipientSessionId !== parent) throw new Error('Foreign or invalid task delivery')
      if (event.key.kind === 'subagent') ids.add(event.key.sourceId)
    }
  }
  const knownIds = [...ids]
  if (value === undefined) return { kind: knownIds.length ? 'recovery-required' as const : 'consistent' as const, knownIds }

  const document = value as TaskProtocolDocument
  if (document.formatVersion === 3 && document.notifications.some(n => n.parentSessionId && n.parentSessionId !== parent)) return { kind: 'recovery-required' as const, knownIds }
  const counts = new Map<string, number>()
  for (const task of document.tasks) {
    if (typeof task.id !== 'string' || !task.id || typeof task.parentSessionId !== 'string' || task.parentSessionId && task.parentSessionId !== parent) return { kind: 'recovery-required' as const, knownIds }
    counts.set(task.id, (counts.get(task.id) ?? 0) + 1)
  }
  return { kind: knownIds.some(id => counts.get(id) !== 1) ? 'recovery-required' as const : 'consistent' as const, knownIds }
}
