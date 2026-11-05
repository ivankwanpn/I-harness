import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { createForkOperation } from '@i-harness/session-persistence'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createDesktopHost } from '../src/host.ts'

// A prepared fork lives on disk; a second host must be able to begin it after
// the first host that prepared it has closed (desktop restart between prepare
// and begin).
for (const store of ['commit-log', 'jsonl'] as const) it('refuses a fork prepared by a previous host (' + store + ')', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-fork-restart-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json')
  await writeFile(settingsPath, '{}')
  const seed = store === 'commit-log'
    ? asSessionCoordinator(createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }))
    : createJsonlTaskTransitionCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }, taskDocumentStorageContract)
  await seed.create({ sessionId: 'source' })
  await seed.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'source for restart' }, { type: 'turn/end' }])
  await seed.close()
  const open = async () => {
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, sessionStore: store, onWrite: frame => frames.push(frame), buildProviderClient() { throw new Error('Fork must not assemble a provider') } })
    let serial = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++serial
      await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const frame = frames.findLast(frame => 'id' in frame && frame.id === id) as { result?: unknown; error?: unknown }
      if (frame?.error) throw new Error(JSON.stringify(frame.error))
      return frame?.result
    }
    await call('initialize')
    return { host, call }
  }
  const first = await open()
  let prepared: { prepared: Parameters<typeof createForkOperation>[0] }
  try {
    await first.call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } })
    await first.call('desktop/session/project/bind', { sessionId: 'source', projectId: 'p' })
    const result = await first.call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    if ((result as { kind?: string }).kind !== 'prepared') throw new Error('preparation refused: ' + JSON.stringify(result))
    prepared = result as { prepared: Parameters<typeof createForkOperation>[0] }
  } finally { await first.host.close() }
  const second = await open()
  try {
    const operation = createForkOperation(prepared.prepared, { operationId: 'scl-fork-restart', targetSessionId: 'child', createdAt: new Date().toISOString() })
    // Prepared forks are held in memory by the host that prepared them: a
    // restart between prepare and begin cannot resume, on either store. The
    // desktop must prepare again; this pins the current contract.
    await expect(second.call('session/fork/begin', { operation })).rejects.toThrow(/Session fork unavailable/)
  } finally { await second.host.close() }
}, 90000)