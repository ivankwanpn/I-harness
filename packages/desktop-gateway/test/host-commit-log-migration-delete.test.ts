import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createDesktopHost } from '../src/host.ts'

import { createJsonlBackend, composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { openCommitLog } from '../../session-commit-log/src/store.ts'

it('deletes migrated legacy sessions through gateway, retries and recreates without old documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-delete-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const legacy = composeJsonlTaskTransitionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } }, taskDocumentStorageContract)
  await legacy.create({ sessionId: 'old' })
  await legacy.append('old', [{ type: 'user/message', text: 'legacy conversation' } as never])
  await legacy.close()
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: {} }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame) })
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id) as { result?: any; error?: unknown }
    if (!frame || frame.error) throw new Error(JSON.stringify(frame))
    return frame.result
  }
  try {
    await call('initialize')
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).toContain('old')
    await call('desktop/session/manage', { sessionId: 'old', action: 'rename', title: 'migrated' })
    const listed = (await call('session/list')).sessions.find((row: { id: string }) => row.id === 'old')
    expect(typeof listed.updatedAt).toBe('number')
    expect(Number.isFinite(listed.updatedAt)).toBe(true)
    const recency = createJsonlCommitCoordinator(sessionDir)
    try { expect((await recency.profile('old')).updatedAt).toBe(listed.updatedAt) } finally { await recency.close() }
    const stale = await openCommitLog({ root: sessionDir, sessionId: 'old' }, 'read')
    const command = { command: { sessionIds: ['old'], action: 'delete' } }
    expect((await call('desktop/session/batch', command)).results[0].ok).toBe(true)
    expect((await call('desktop/session/batch', command)).results[0].ok).toBe(true)
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).not.toContain('old')
    expect(stale.view().deleted).toBe(false)
    await stale.refresh()
    expect(stale.view().deleted).toBe(true)
    await stale.close()
    const coordinator = createJsonlCommitCoordinator(sessionDir)
    try {
      await coordinator.create({ sessionId: 'old' })
      expect(await coordinator.getDocument('task-old')).toBeUndefined()
      expect(await coordinator.deletionReceipt('old')).toBeUndefined()
    } finally { await coordinator.close() }
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).toContain('old')
  } finally { await host.close() }
}, 60000)
