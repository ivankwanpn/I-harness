import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { RewindStore, sha256Hex } from '@i-harness/rewind'
import { createDesktopHost } from '../src/host.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-rewind-modes-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
  const tracked = join(workspace, 'tracked.txt')
  await writeFile(tracked, 'after')
  const preBlob = await store.writeBlob(new TextEncoder().encode('before'))
  await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: 'first task', files: [{ path: 'tracked.txt', status: 'modified', preBlob, afterHash: sha256Hex(new TextEncoder().encode('after')) }] })
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
  return { host, call, workspace, sessionDir, tracked }
}

it('rewinds files only and keeps the conversation', async () => {
  const { host, call, sessionDir, tracked } = await fixture()
  try {
    expect(isRpcSuccess(await call('initialize'))).toBe(true)
    const plan = await call('desktop/rewind/plan', { sessionId: 'source', target: 0, mode: 'files' })
    if (!isRpcSuccess(plan)) throw new Error(JSON.stringify(plan))
    const fingerprint = (plan.result as { fingerprint: string }).fingerprint
    const executed = await call('desktop/rewind/execute', { sessionId: 'source', target: 0, mode: 'files', fingerprint })
    if (!isRpcSuccess(executed)) throw new Error(JSON.stringify(executed))
    expect(await readFile(tracked, 'utf8')).toBe('before')
    const loaded = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const events = (await loaded.load('source')).session.events.map(event => event.type)
      expect(events).toContain('assistant/message')
    } finally { await loaded.close() }
    // 'both' is not a rewind mode: the request is refused before it can touch
    // the conversation or the files.
    const invalid = await call('desktop/rewind/plan', { sessionId: 'source', target: 0, mode: 'both' })
    expect(isRpcSuccess(invalid)).toBe(false)
    expect(JSON.stringify(invalid)).toContain('Invalid rewind request')
  } finally { await host.close() }
}, 90000)