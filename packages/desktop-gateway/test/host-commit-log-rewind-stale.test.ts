import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { RewindStore, sha256Hex } from '@i-harness/rewind'
import { createDesktopHost } from '../src/host.ts'

// The fingerprint covers the plan (including the tracked files), so a working
// tree that changed after the preview must be re-previewed instead of applied.
it('refuses a rewind fingerprint invalidated by a changed working tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-rewind-stale-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
  try {
    expect(isRpcSuccess(await call('initialize'))).toBe(true)
    const plan = await call('desktop/rewind/plan', { sessionId: 'source', target: 0, mode: 'conversation' })
    if (!isRpcSuccess(plan)) throw new Error(JSON.stringify(plan))
    const fingerprint = (plan.result as { fingerprint: string }).fingerprint
    // The tracked file changes after the preview: the plan now describes a
    // different working tree, so the confirmed fingerprint must be refused.
    await writeFile(join(workspace, 'tracked.txt'), 'after, but changed again')
    const writer = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      await writer.append('source', [
        { type: 'turn/start', seq: 4 }, { type: 'user/message', seq: 5, text: 'second task' },
        { type: 'assistant/message', seq: 6, text: 'second answer' }, { type: 'turn/end', seq: 7 },
      ])
    } finally { await writer.close() }
    const executed = await call('desktop/rewind/execute', { sessionId: 'source', target: 0, mode: 'conversation', fingerprint })
    expect(isRpcSuccess(executed)).toBe(false)
    expect(JSON.stringify(executed)).toContain('Rewind preview changed; preview again before confirming')
    const loaded = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const events = (await loaded.load('source')).session.events.map(event => event.type)
      expect(events).not.toContain('rewind/point')
      expect(events).toContain('turn/end')
    } finally { await loaded.close() }
  } finally { await host.close() }
}, 90000)