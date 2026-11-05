import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

it('renames, archives, restores and reloads a session on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-manage-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    await call('desktop/session/manage', { sessionId: created.sessionId, action: 'rename', title: 'Renamed session' })
    const renamed = await call('session/list') as { sessions: { id: string; title: string }[] }
    expect(renamed.sessions.find(row => row.id === created.sessionId)?.title).toBe('Renamed session')
    await call('desktop/session/manage', { sessionId: created.sessionId, action: 'archive' })
    const visible = await call('session/list') as { sessions: { id: string }[] }
    expect(visible.sessions.map(row => row.id)).not.toContain(created.sessionId)
    const archived = await call('desktop/session/archived') as { id: string }[]
    expect(archived.map(row => row.id)).toContain(created.sessionId)
    await call('desktop/session/manage', { sessionId: created.sessionId, action: 'restore' })
    const restored = await call('session/list') as { sessions: { id: string }[] }
    expect(restored.sessions.map(row => row.id)).toContain(created.sessionId)
    expect(await call('desktop/session/reload', { sessionId: created.sessionId })).toEqual({ reloaded: true })
    expect(await call('desktop/session/navigation/state')).toBeTruthy()
    const second = await call('session/create') as { sessionId: string }
    await call('desktop/session/batch', { command: { action: 'archive', sessionIds: [second.sessionId] } })
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).not.toContain(second.sessionId)
    await call('desktop/session/batch', { command: { action: 'restore', sessionIds: [second.sessionId] } })
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).toContain(second.sessionId)
    await call('desktop/session/batch', { command: { action: 'delete', sessionIds: [second.sessionId] } })
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).not.toContain(second.sessionId)
    expect(await call('desktop/environment/diagnostics', { sessionId: created.sessionId })).toBeTruthy()
    await call('desktop/project/configure', { project: { id: 'p', name: 'Project', roots: [workspace], primaryRoot: workspace } })
    const moved = await call('desktop/session/batch', { command: { action: 'move', sessionIds: [created.sessionId], projectId: 'p', expectedOwners: { [created.sessionId]: null } } }) as { results: { ok: boolean; error?: string }[] }
    expect(moved.results[0]?.ok).toBe(true)
    expect(await call('desktop/session/project/state', { sessionId: created.sessionId })).toEqual({ sessionId: created.sessionId, projectId: 'p' })
  } finally {
    await host.close()
  }
}, 60000)