import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, type RetainedResultRevision } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { SessionService } from '@i-harness/session-executor'
import { createDesktopSubagents } from '../src/session-subagents.ts'

const retained = (revision: string, id: string): RetainedResultRevision => ({ version: 1, revision, kind: 'retained', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { version: 1, id: 'ctxv1_' + id.repeat(64), revision: id.repeat(64), contentDigest: id.repeat(64), encodedBytes: 10, codec: 'json-utf8-v1', completeness: 'complete' } } } })

it.each([false, true])('qualifies a retained catalog row against its actual parent and exact ref identity (foreign-ref=%s)', async foreignRef => {
  const root = await mkdtemp(join(tmpdir(), 'retained-parent-proof-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let catalog: ReturnType<typeof createDesktopSubagents> | undefined
  try {
    await coordinator.create({ sessionId: 'parent' })
    await coordinator.create({ sessionId: 'middle', parentSession: 'parent', origin: 'subagent', subagentProtocolVersion: 1 })
    await coordinator.create({ sessionId: 'leaf', parentSession: 'middle', origin: 'subagent', subagentProtocolVersion: 1 })
    const initial = retained('middle-revision', '1'), actual = retained('leaf-revision', '2'), saved = foreignRef ? retained('leaf-revision', '3') : actual
    for (const [owner, child, result] of [['parent', 'middle', initial], ['middle', 'leaf', actual]] as const) {
      const document = await coordinator.openManagedDocument(owner), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
      committedFactSeqs(await source.delivery.record({ type: 'job/status', version: 1, job: { jobId: 'subagent-1', kind: 'subagent', label: child, status: 'completed', outputAvailable: true, result } }))
      await source.close(); action.finish()
      await coordinator.putDocument(owner, { formatVersion: 2, roles: [], jobs: [{ id: 'subagent-1', owner: 'root', kind: 'subagent', label: child, status: 'completed', output: 'preview', terminal: true, agentPath: 'root/' + child, sessionId: child, result: owner === 'middle' ? saved : result }], agentTable: [] })
    }
    const readOnly = { liveAssembly: () => undefined, liveSession: () => undefined, onAssembly: () => () => {} } as unknown as SessionService
    catalog = createDesktopSubagents(coordinator, readOnly)
    const rows = (await catalog.list('parent')).agents
    const leaf = rows.find(row => row.sessionId === 'leaf')!
    expect(leaf.status).toBe(foreignRef ? 'unavailable' : 'completed')
    expect(leaf.result?.kind === 'retained' ? leaf.result.envelope.execution.outcome : undefined).toBe(foreignRef ? 'unknown' : 'succeeded')
  } finally { await catalog?.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
