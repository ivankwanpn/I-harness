import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

// Archiving a session that has already run a turn used to fail with
// "Session management is in progress or session is deleted" because the
// exclusive operation's own cold-rewind recovery retained the managed runtime
// while the fence was blocked.
it('archives and restores a session that has run a turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-archive-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TURN_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TURN_KEY: 'controlled' } }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() { yield { type: 'text/chunk', text: 'answer' }; yield { type: 'end' } } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id)
    if (!frame || !isRpcSuccess(frame)) throw new Error(JSON.stringify(frame))
    return frame.result
  }
  try {
    await call('initialize')
    const created = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'archive me' })
    expect((await call('desktop/session/manage', { sessionId: created.sessionId, action: 'archive' }))).toMatchObject({ sessionId: created.sessionId })
    const active = await call('session/list') as { sessions: { id: string }[] }
    expect(active.sessions.map(row => row.id)).not.toContain(created.sessionId)
    const archived = await call('desktop/session/archived') as { id: string }[]
    expect(archived.map(row => row.id)).toContain(created.sessionId)
    await call('desktop/session/manage', { sessionId: created.sessionId, action: 'restore' })
    const restored = await call('session/list') as { sessions: { id: string; turnCount: number }[] }
    expect(restored.sessions.find(row => row.id === created.sessionId)?.turnCount).toBe(1)
    const batchArchived = await call('desktop/session/batch', { command: { action: 'archive', sessionIds: [created.sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(batchArchived.results[0]!.ok).toBe(true)
    expect(((await call('desktop/session/archived')) as { id: string }[]).map(row => row.id)).toContain(created.sessionId)
    const batchRestored = await call('desktop/session/batch', { command: { action: 'restore', sessionIds: [created.sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(batchRestored.results[0]!.ok).toBe(true)
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).toContain(created.sessionId)
  } finally { await host.close() }
}, 90000)