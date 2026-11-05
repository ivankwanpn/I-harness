import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

it('binds and unbinds a project scope on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-project-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    await call('initialize')
    const created = await call('session/create') as { sessionId: string }
    await call('desktop/project/configure', { project: { id: 'p', name: 'Project', roots: [workspace], primaryRoot: workspace } })
    await call('desktop/session/project/bind', { sessionId: created.sessionId, projectId: 'p' })
    expect(await call('desktop/session/project/state', { sessionId: created.sessionId })).toEqual({ sessionId: created.sessionId, projectId: 'p' })
    const navigation = await call('desktop/session/navigation/state') as Record<string, { projectId?: string }>
    expect(navigation[created.sessionId]?.projectId).toBe('p')
    // A bind without a project id is idempotent on an already-bound session.
    await call('desktop/session/project/bind', { sessionId: created.sessionId })
    expect(await call('desktop/session/project/state', { sessionId: created.sessionId })).toEqual({ sessionId: created.sessionId, projectId: 'p' })
  } finally {
    await host.close()
  }
}, 60000)