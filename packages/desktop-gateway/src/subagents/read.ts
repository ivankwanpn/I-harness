import type { HistoryRange } from "@i-harness/sdk"
import { transportSessionEvents } from "@i-harness/sdk/server"
import type { SubagentScope } from "./scope.ts"
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { readTaskResultPage, taskDocKey } from '@i-harness/subagent'
import { validRetainedResultRevision } from '@i-harness/core-session'
import { object, records, type SubagentReadOptions, type SubagentResultArgs, type AgentRecord } from './types.ts'
export function createSubagentReader(scope: SubagentScope, coordinator: SessionCoordinator, options: SubagentReadOptions) {
  const { parent, lineage, open, snapshot, liveChild, authority } = scope
  async function history(parentId: string, childId: string, paging: { afterSeq?: number; limit?: number } = {}): Promise<HistoryRange> {
    await parent(parentId); const chain = await lineage(parentId, childId); open()
    const afterSeq = paging.afterSeq ?? 0, limit = paging.limit ?? 200
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid history page")
    // Explicit history reads keep the real owner's pending-receipt fence
    // before accessing a live child port. Marker visibility grants none.
    if (coordinator.snapshot) await coordinator.snapshot(childId)
    const session = await snapshot(childId, liveChild(childId, authority(parentId, childId, chain)))
    const start = Math.min(afterSeq, session.events.length), end = Math.min(start + limit, session.events.length)
    return { events: transportSessionEvents(session, session.events.slice(start, end)), nextSeq: end }
  }
  async function result(parentId: string, childId: string, args: SubagentResultArgs = {}) {
    await parent(parentId)
    const chain = await lineage(parentId, childId)
    open()
    let owned = authority(parentId, childId, chain)
    let selected: { ownerId: string; row: AgentRecord } | undefined = owned?.entry.result ? { ownerId: owned.ownerId, row: owned.entry } : undefined
    for (const ownerId of [...new Set([parentId, ...chain.map(meta => meta.parentSession!).filter(Boolean)])]) {
      if (selected) break
      const doc = object(await coordinator.getDocument(ownerId))
      if (doc && doc.formatVersion !== 1 && doc.formatVersion !== 2) throw new Error('Unsupported subagent state version')
      const row = doc ? records(doc.agentTable).find(row => row.sessionId === childId) : undefined
      if (row?.result) { selected = { ownerId, row }; break }
      const tasks = object(await coordinator.getDocument(taskDocKey(ownerId)))
      if (tasks && (tasks.formatVersion !== 1 && tasks.formatVersion !== 2 || !Array.isArray(tasks.tasks))) throw new Error('Unsupported task document version')
      const task = (tasks?.tasks as unknown[] | undefined)?.map(object).find(task => task?.childSessionId === childId)
      if (task?.result) {
        if (!validRetainedResultRevision(task.result)) throw new Error('Invalid retained child metadata')
        selected = { ownerId, row: { sessionId: childId, path: String(task.agentPath), status: String(task.status), result: task.result } }
      }
    }
    if (!selected?.row.result || !options.readResult) throw new Error('Retained child result unavailable')
    // Read identity comes from the current owned registry/document, never a
    // renderer-supplied ref or path. Recheck lineage before and after I/O.
    await parent(parentId); await lineage(parentId, childId); open()
    const page = await readTaskResultPage({ read: (_target, ref, paging) => options.readResult!({ sessionId: parentId, ownerSessionId: selected!.ownerId }, ref, paging) },
      { id: childId, parentSessionId: parentId, result: selected.row.result },
      { offset: args.offset, maxBytes: args.maxBytes, revision: args.resultRevision, refId: args.refId, refRevision: args.refRevision })
    await parent(parentId); await lineage(parentId, childId); open()
    return page
  }
  return { history, result }
}
