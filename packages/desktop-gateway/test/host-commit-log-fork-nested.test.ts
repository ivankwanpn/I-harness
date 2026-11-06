import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createForkOperation } from '@i-harness/session-persistence'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

// A fork child is a first-class continuation: it can run its own turns and
// record its own rewind points.
it('forks and continues a nested conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-fork-turn-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'fork this conversation' })
    await call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } })
    await call('desktop/session/project/bind', { sessionId: created.sessionId, projectId: 'p' })
    const prepared = await call('session/fork/prepare', { version: 1, sourceSessionId: created.sessionId })
    if ((prepared as { kind?: string }).kind !== 'prepared') throw new Error('preparation refused: ' + JSON.stringify(prepared))
    const operation = createForkOperation((prepared as { prepared: Parameters<typeof createForkOperation>[0] }).prepared, { operationId: 'fork-after-turn', targetSessionId: 'forked', createdAt: new Date().toISOString() })
    expect(await call('session/fork/begin', { operation })).toMatchObject({ kind: 'ready', sessionId: 'forked' })
    const listed = await call('session/list') as { sessions: { id: string }[] }
    expect(listed.sessions.map(row => row.id)).toContain('forked')
    expect(await call('desktop/session/project/state', { sessionId: 'forked' })).toEqual({ sessionId: 'forked', projectId: 'p' })
    await call('session/prompt', { sessionId: 'forked', prompt: 'child turn' })
    const nested = await call('session/fork/prepare', { version: 1, sourceSessionId: 'forked' })
    if ((nested as { kind?: string }).kind !== 'prepared') throw new Error('nested preparation refused: ' + JSON.stringify(nested))
    const nestedOperation = createForkOperation((nested as { prepared: Parameters<typeof createForkOperation>[0] }).prepared, { operationId: 'fork-nested', targetSessionId: 'grandchild', createdAt: new Date().toISOString() })
    expect(await call('session/fork/begin', { operation: nestedOperation })).toMatchObject({ kind: 'ready', sessionId: 'grandchild' })
    await call('session/prompt', { sessionId: 'grandchild', prompt: 'grandchild turn' })
    const listed2 = await call('session/list') as { sessions: { id: string }[] }
    expect(listed2.sessions.map(row => row.id)).toEqual(expect.arrayContaining([created.sessionId, 'forked', 'grandchild']))
    expect(await call('desktop/session/project/state', { sessionId: 'grandchild' })).toEqual({ sessionId: 'grandchild', projectId: 'p' })
    for (const id of ['grandchild', 'forked', created.sessionId]) expect((await call('desktop/session/batch', { command: { action: 'delete', sessionIds: [id] } }) as { results: { ok: boolean }[] }).results[0]!.ok).toBe(true)
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions).toHaveLength(0)
  } finally { await host.close() }
}, 90000)