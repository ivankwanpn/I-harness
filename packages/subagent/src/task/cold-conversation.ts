import { createHash } from 'node:crypto'
import { canonicalJsonData, readGenerationActions, validRetainedResultRevision, type SessionView } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { ChildAgentEntry } from '../agent-table.ts'
import type { JobRegistry } from '../jobs.ts'
import type { DurableAgentEntry, DurableJobRecord, SubagentStateSnapshot } from '../persist.ts'
import { unknownResult, validResultPublication } from '../result-publication.ts'
import { taskBodyPreview } from './result.ts'
import type { TaskRecord } from './types.ts'

type Conversation = {
  removed?: boolean
  agent?: Partial<Pick<ChildAgentEntry, 'lastInboxSeq' | 'status' | 'finalText' | 'error' | 'retention' | 'retentionError' | 'result' | 'publication' | 'savedObservation'>>
  job?: Parameters<JobRegistry['updateJob']>[1]
}
type SavedObservation = Pick<DurableAgentEntry, 'result' | 'status' | 'error' | 'finalText' | 'lastInboxSeq' | 'retention' | 'retentionError' | 'publication' | 'savedObservation'>

function retention(row: Pick<DurableAgentEntry, 'retention' | 'retentionError'>) {
  return {
    ...(row.retention && ['memory', 'pending', 'durable', 'failed'].includes(row.retention) ? { retention: row.retention } : {}),
    ...(typeof row.retentionError === 'string' ? { retentionError: row.retentionError } : {}),
  }
}

function savedProjection(task: Readonly<TaskRecord>, row: SavedObservation, job: DurableJobRecord | undefined): Conversation | undefined {
  const result = row.result
  if (!result || !validRetainedResultRevision(result) || !validResultPublication(row) || result.revision === task.result?.revision) return
  if (row.finalText !== undefined && typeof row.finalText !== 'string' || row.error !== undefined && typeof row.error !== 'string' ||
      row.finalText !== undefined && row.error !== undefined || row.finalText === undefined && row.error === undefined && result.kind !== 'pending') return
  if (job && (!job.result || !validRetainedResultRevision(job.result) || !validResultPublication(job) ||
      canonicalJsonData(unknownResult(job.result)) !== canonicalJsonData(unknownResult(result)) || job.output !== (row.error ?? row.finalText ?? ''))) return
  const observed = row.savedObservation ?? { status: row.status, ...(result.kind === 'retained' ? { execution: result.envelope.execution } : {}) }
  const jobObserved = job?.savedObservation ?? { status: job?.status ?? (row.error === undefined ? 'completed' : 'error'), ...(observed.execution ? { execution: observed.execution } : {}) }
  if (!validResultPublication({ publication: 'unqualified', savedObservation: observed }) || !validResultPublication({ publication: 'unqualified', savedObservation: jobObserved })) return
  const saved = unknownResult(result)
  return {
    agent: { ...retention(row), status: 'recovery-required', result: saved, publication: 'unqualified', savedObservation: observed,
      finalText: row.finalText, error: row.error },
    job: { status: 'recovery-required', result: saved, publication: 'unqualified', output: row.error ?? row.finalText ?? '', savedObservation: jobObserved,
      ...(job?.endedAt !== undefined ? { endedAt: job.endedAt } : {}) },
  }
}

/** The Task describes the initial launch. A later resident result is a saved
 * observation, and never qualifies its own execution or reopens that Task. */
function observeColdConversation(task: Readonly<TaskRecord>, row: SavedObservation, projection: Conversation | undefined, view: SessionView, removed: boolean): Conversation {
  const header = view.header
  if (header?.origin !== 'subagent' || header.parentSession !== task.parentSessionId ||
      header.subagentTaskId !== undefined && header.subagentTaskId !== task.id ||
      header.subagentAgentPath !== undefined && header.subagentAgentPath !== task.agentPath) return {}
  const scope = { ...view.header, sessionId: task.childSessionId }
  const inboxes = readGenerationActions(view.events, scope, view.formatVersion).filter(action =>
    action.opened.ownerSessionId === task.childSessionId && action.opened.purpose === 'main' &&
    action.opened.origin.kind === 'delegated-input' && action.opened.origin.ref === 'inbox')
  const latest = inboxes.at(-1)
  if (!latest) return {}
  const cursor = row.lastInboxSeq
  if (cursor !== undefined && !inboxes.some(action => action.opened.origin.seq === cursor && (action.closed ||
      view.events[action.opened.seq! + 1]?.type === 'turn/start'))) return {}
  const agent: Conversation['agent'] = cursor === undefined ? {} : { lastInboxSeq: cursor }
  const result = row.result
  if (!result || !projection) return { agent }
  const afterOpen = view.events.slice(latest.opened.seq! + 1)
  const started = afterOpen.some(event => event.type === 'turn/start')
  // A missing journal on a previous mount deliberately withheld the cursor.
  // Recover it for a completed inbox only after checking its full result below.
  const revalidate = cursor === undefined && row.publication === 'unqualified' && row.finalText !== undefined &&
    latest.closed === 'accepted' && result.kind === 'retained' && result.envelope.retention.kind !== 'unavailable'
  if (started && !removed && !revalidate && cursor !== latest.opened.origin.seq) return { agent }
  if (!started && latest.closed !== 'failed' && latest.closed !== 'stopped') return { agent }
  if (row.finalText !== undefined) {
    const final = afterOpen.findLast(event => event.type === 'assistant/message')
    if (row.error !== undefined || !started || !afterOpen.some(event => event.type === 'turn/end') ||
        !final || taskBodyPreview({ resultText: final.text }).resultText !== row.finalText) return { agent }
    if (result.kind === 'retained') {
      const retained = result.envelope.retention, body = JSON.stringify({ resultText: final.text })
      if (retained.kind === 'artifact' && (retained.ref.codec !== 'json-utf8-v1' || retained.ref.encodedBytes !== Buffer.byteLength(body) ||
          retained.ref.contentDigest !== createHash('sha256').update(body).digest('hex'))) return { agent }
      if (retained.kind === 'inline' && canonicalJsonData(retained.value) !== body) return { agent }
    }
  }
  if (revalidate) agent.lastInboxSeq = latest.opened.origin.seq
  return { ...projection, agent: { ...projection.agent, ...agent } }
}

async function readObservation(coordinator: SessionCoordinator, task: Readonly<TaskRecord>, row: SavedObservation, job: DurableJobRecord | undefined, removed = false): Promise<Conversation> {
  const observation = savedProjection(task, row, job)
  if (!coordinator.snapshot) return observation ?? {}
  let view: SessionView
  try { view = (await coordinator.snapshot(task.childSessionId!)).session }
  catch { return observation ?? {} } // Retain the saved observation. Only a verified journal supplies an executable cursor.
  try { return observeColdConversation(task, row, observation, view, removed) }
  catch { return {} } // A malformed generation history cannot certify this child's metadata.
}

/** An ambiguous saved key must never select either child. */
function indexUnique<T>(rows: readonly T[], keyOf: (row: T) => string | undefined) {
  const index = new Map<string, T | null>()
  for (const row of rows) {
    const key = row && keyOf(row)
    if (typeof key === 'string') index.set(key, index.has(key) ? null : row)
  }
  return index
}

/** Read the auxiliary document only for already acknowledged canonical Task
 * children. It cannot supply roles, execution bindings, or additional rows. */
export async function readColdTaskConversations(coordinator: SessionCoordinator, parentId: string, tasks: readonly Readonly<TaskRecord>[]) {
  const conversations = new Map<string, Conversation>()
  if (!tasks.length) return conversations
  const raw = await coordinator.getDocument(parentId) as Partial<SubagentStateSnapshot> | undefined
  if (raw === undefined) return conversations
  if (!raw || raw.formatVersion !== 1 && raw.formatVersion !== 2 || !Array.isArray(raw.agentTable) || !Array.isArray(raw.jobs)) {
    throw Error('Invalid saved subagent conversation document')
  }
  const byPath = indexUnique(raw.agentTable, row => row.path)
  const bySession = indexUnique(raw.agentTable, row => row.sessionId)
  const byJob = indexUnique(raw.jobs, job => job.id)
  for (const task of tasks) {
    if (!task.jobId || !task.childSessionId) continue
    const row = bySession.get(task.childSessionId)
    if (row === null || byPath.get(task.agentPath) !== row) continue
    const job = byJob.get(task.jobId)
    if (job === null || job && (job.owner !== 'root' || job.kind !== 'subagent' || job.taskId !== task.id || job.agentPath !== task.agentPath || job.sessionId !== task.childSessionId)) continue
    if (!row && job) {
      let archivedJob: Conversation['job']
      if (raw.formatVersion === 2 && job.result && job.result.revision !== task.result?.revision) {
        const status = job.savedObservation?.status ?? job.status
        const observation = { ...job, status, ...(status === 'completed' ? { finalText: job.output } : { error: job.output }) }
        archivedJob = (await readObservation(coordinator, task, observation, job, true)).job
      }
      conversations.set(task.id, { removed: true, ...(archivedJob ? { job: archivedJob } : {}) })
      continue
    }
    if (!row || row.taskId !== task.id || row.jobId !== task.jobId ||
        row.roleName !== undefined && row.roleName !== task.agent) continue
    if (row.result?.revision === task.result?.revision && row.lastInboxSeq === undefined) {
      conversations.set(task.id, { agent: retention(row) })
      continue
    }
    if (raw.formatVersion === 2 && (row.lastInboxSeq !== undefined || row.result)) {
      conversations.set(task.id, await readObservation(coordinator, task, row, job))
    }
  }
  return conversations
}
