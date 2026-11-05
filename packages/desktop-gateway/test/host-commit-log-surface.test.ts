import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

it('subscribes to the execution surface on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-surface-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
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
    if (!frame) throw new Error('missing reply for ' + method)
    if (frame.error) throw new Error(JSON.stringify(frame.error))
    return frame.result
  }
  try {
    const init = await call('initialize')
    expect(init.capabilities['desktop-surface-events']).toEqual(['1'])
    const created = await call('session/create') as { sessionId: string }
    const lease = await call('desktop/surface/subscribe', { requestKey: 'r1:1', surface: 'execution', sessionId: created.sessionId }) as { subscriptionId: string; stamp: { epoch: string } }
    expect(lease.subscriptionId).toBeTruthy()
    const reply = await call('desktop/surface/snapshot', { subscriptionId: lease.subscriptionId, epoch: lease.stamp.epoch }) as { kind?: string }
    expect(reply.kind).toBeTruthy()
    await call('desktop/surface/unsubscribe', { subscriptionId: lease.subscriptionId })
  } finally {
    await host.close()
  }
}, 60000)