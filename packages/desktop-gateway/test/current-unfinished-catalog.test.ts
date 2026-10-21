import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService, createDurableSessionLoader } from '@i-harness/session-executor'
import { createTaskResultRetention } from '../../session-executor/src/lifecycle/task-result-retention.ts'
import { createTaskRegistry, SHIPPING_REPORT_POLICY, taskDocKey, type TaskProtocolDocument } from '@i-harness/subagent'
import { createDesktopSubagents } from '../src/session-subagents.ts'

// Catches either provenance being dropped or no-result being mistaken for
// legacy before loading a child's complete transcript just to infer status.
it.each(['marker', 'task', 'state', 'pending', 'stale-followup', 'body-kind', 'legacy', 'migrated', 'future-state', 'future-task', 'corrupt-state', 'no-doc-legacy', 'marked-migrated', 'state-migrated', 'forged-migration'] as const)('public cold catalog qualifies %s provenance before transcript fallback', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'current-catalog-'))
  let coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let catalog: ReturnType<typeof createDesktopSubagents> | undefined
  let service: ReturnType<typeof createSessionService> | undefined
  try {
    await coordinator.create({ sessionId: 'parent' })
    await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', ...((kind === 'marker' || kind === 'marked-migrated') ? { subagentProtocolVersion: 1 as const } : {}) })
    await coordinator.append('child', [{ type: 'turn/start' }, { type: 'assistant/message', text: 'child-only history' }, { type: 'turn/end' }, ...(kind === 'stale-followup' ? [{ type: 'turn/start' as const }] : [])])
    const current = !['legacy', 'migrated', 'marker', 'state', 'marked-migrated', 'state-migrated'].includes(kind)
    if (!['marker', 'future-state', 'future-task', 'corrupt-state', 'no-doc-legacy'].includes(kind)) {
      const tasks = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ...(current ? { results: createTaskResultRetention(undefined, undefined, 'parent') } : {}) })
      const row = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, childSessionId: 'child', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
      tasks.claim(row.id); await tasks.flushPersistence()
      if (['migrated', 'marked-migrated', 'state-migrated'].includes(kind)) {
        const migration = createTaskRegistry({ coordinator, stateId: 'parent', results: createTaskResultRetention(undefined, undefined, 'parent') })
        migration.restore(await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument); await migration.save(); await migration.flushPersistence()
      }
      if (kind === 'body-kind' || kind === 'forged-migration') {
        const doc = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
        doc.tasks[0]!.bodyKind = 'legacy-text'; if (kind === 'forged-migration') Object.assign(doc.tasks[0]!, { legacyFormatVersion: 2 }); await coordinator.putDocumentStrict!(taskDocKey('parent'), doc)
      }
    }
    if (kind === 'state' || kind === 'state-migrated' || kind === 'stale-followup' || kind === 'pending') await coordinator.putDocumentStrict!('parent', { formatVersion: 2, jobs: [], roles: [], agentTable: [{ sessionId: 'child', path: 'root/a', status: kind === 'stale-followup' ? 'completed' : 'running', ...(kind === 'pending' ? { result: { version: 1, kind: 'pending', revision: 'original-pending' } } : {}) }] })
    if (kind === 'future-state' || kind === 'corrupt-state') await coordinator.putDocumentStrict!('parent', kind === 'future-state' ? { formatVersion: 3, agentTable: [] } : { formatVersion: 2, agentTable: 'invalid' })
    if (kind === 'future-task') await coordinator.putDocumentStrict!(taskDocKey('parent'), { formatVersion: 3, tasks: [] })
    await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    let sends = 0, assemblies = 0
    const snapshots = vi.spyOn(coordinator as typeof coordinator & { snapshot: NonNullable<typeof coordinator.snapshot> }, 'snapshot')
    service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model: { async *stream() { sends++; throw Error('Read-created model work') } } })
    service.onAssembly(() => { assemblies++ })
    catalog = createDesktopSubagents(coordinator, service)
    const row = (await catalog.list('parent')).agents[0]!
    const legacy = kind === 'legacy' || kind === 'migrated' || kind === 'no-doc-legacy'
    expect(row.status).toBe(legacy ? 'completed' : 'unavailable')
    expect(row.finalText).toBe(legacy ? 'child-only history' : undefined)
    expect(snapshots.mock.calls.some(([id]) => id === 'child')).toBe(legacy)
    if (!legacy) await expect(catalog.result('parent', 'child')).rejects.toThrow(/unavailable|version/)
    const history = await catalog.history('parent', 'child')
    expect(JSON.stringify(history.events)).toContain('child-only history')
    expect({ sends, assemblies }).toEqual({ sends: 0, assemblies: 0 })
    expect((await coordinator.snapshot!('parent')).session.events.filter(event => event.type === 'subagent/end')).toEqual([])
  } finally { await catalog?.close(); await service?.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
