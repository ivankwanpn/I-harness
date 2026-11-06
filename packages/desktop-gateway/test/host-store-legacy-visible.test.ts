import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createDesktopHost } from '../src/host.ts'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'

// Switching the store must not hide sessions written by the other one: the
// commit log lists legacy ids and adopts them on first read/write.
it('lists a legacy session on a commit-log host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-store-legacy-visible-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const seed = createJsonlTaskTransitionCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }, taskDocumentStorageContract)
  await seed.create({ sessionId: 'legacy-one', title: 'Legacy session' })
  await seed.append('legacy-one', [{ type: 'user/message', text: 'from the legacy store' }])
  await seed.close()
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' } }), 'utf8')
  await writeFile(credentialsPath, JSON.stringify({ refs: {} }), 'utf8')
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: (frame: RpcMessage) => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() { yield { type: 'text/chunk', text: 'unused' }; yield { type: 'end' } } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const reply = frames.findLast(frame => 'id' in frame && frame.id === id)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    await call('initialize')
    const listed = await call('session/list') as { sessions: { id: string; title?: string }[] }
    expect(listed.sessions.find(row => row.id === 'legacy-one')?.title).toBe('Legacy session')
    const history = await call('session/history', { sessionId: 'legacy-one', afterSeq: 0, limit: 20 }) as { events: { type: string; text?: string }[] }
    expect(history.events.some(event => event.type === 'user/message' && event.text === 'from the legacy store')).toBe(true)
  } finally { await host.close() }
}, 60000)
