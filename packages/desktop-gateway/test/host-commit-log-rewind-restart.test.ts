import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { RewindStore, sha256Hex } from '@i-harness/rewind'
import { createDesktopHost } from '../src/host.ts'

// A rewind planned by one host must be executable by the next host on the same
// store (desktop restart between preview and confirm): the fingerprint and the
// point files are durable, not host memory.
it('executes a rewind planned by a previous host on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-rewind-restart-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: {} }))
  const seed = asSessionCoordinator(createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }))
  await seed.create({ sessionId: 'source', title: 'Source' })
  await seed.append('source', [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'first task' },
    { type: 'assistant/message', seq: 2, text: 'done' }, { type: 'turn/end', seq: 3 },
  ])
  await seed.close()
  const store = new RewindStore({ root: sessionDir, sessionId: 'source', workspace })
  const preBlob = await store.writeBlob(new TextEncoder().encode('before'))
  await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: 'first task', files: [{ path: 'tracked.txt', status: 'modified', preBlob, afterHash: sha256Hex(new TextEncoder().encode('after')) }] })
  const open = async () => {
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame) })
    let serial = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++serial
      await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const frame = frames.findLast(frame => 'id' in frame && frame.id === id)
      if (!frame) throw new Error('missing reply for ' + method)
      return frame
    }
    expect(isRpcSuccess(await call('initialize'))).toBe(true)
    return { host, call }
  }
  const first = await open()
  let fingerprint: string
  try {
    const points = await first.call('desktop/rewind/points', { sessionId: 'source' })
    if (!isRpcSuccess(points)) throw new Error(JSON.stringify(points))
    expect(points.result).toEqual([{ turnIndex: 0, preview: 'first task', files: 1 }])
    const plan = await first.call('desktop/rewind/plan', { sessionId: 'source', target: 0, mode: 'conversation' })
    if (!isRpcSuccess(plan)) throw new Error(JSON.stringify(plan))
    fingerprint = (plan.result as { fingerprint: string }).fingerprint
    expect(fingerprint).toBeTruthy()
  } finally { await first.host.close() }
  const second = await open()
  try {
    const executed = await second.call('desktop/rewind/execute', { sessionId: 'source', target: 0, mode: 'conversation', fingerprint })
    if (!isRpcSuccess(executed)) throw new Error(JSON.stringify(executed))
    expect(executed.result).toMatchObject({ eventAppended: true, truncated: true })
    const points = await second.call('desktop/rewind/points', { sessionId: 'source' })
    if (!isRpcSuccess(points)) throw new Error(JSON.stringify(points))
    expect(points.result).toEqual([])
    const loaded = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const loadedEvents = (await loaded.load('source')).session.events
      // The durable model keeps history and appends a rewind marker rather than
      // rewriting the log.
      expect(loadedEvents.map(event => event.type)).toContain('rewind/point')
    } finally { await loaded.close() }
  } finally { await second.host.close() }
}, 90000)