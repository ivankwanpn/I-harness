import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('moves sessions between projects from a second host with owner guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-batch-move-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TURN_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TURN_KEY: 'controlled' } }))
  const open = async () => {
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
    await call('initialize')
    return { host, call }
  }
  const first = await open()
  let bound = '', unbound = ''
  try {
    bound = (await first.call('session/create') as { sessionId: string }).sessionId
    unbound = (await first.call('session/create') as { sessionId: string }).sessionId
    await first.call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } })
    await first.call('desktop/project/configure', { project: { id: 'q', name: 'Q', roots: [workspace], primaryRoot: workspace } })
    await first.call('desktop/session/project/bind', { sessionId: bound, projectId: 'p' })
  } finally { await first.host.close() }
  const second = await open()
  try {
    // Projects are main-process state: the restarted app re-reads them from its
    // project settings before it can move sessions between them.
    await second.call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } })
    await second.call('desktop/project/configure', { project: { id: 'q', name: 'Q', roots: [workspace], primaryRoot: workspace } })
    const moved = await second.call('desktop/session/batch', { command: { action: 'move', sessionIds: [bound, unbound], projectId: 'q', expectedOwners: { [bound]: 'p', [unbound]: null } } }) as { results: { ok: boolean; error?: string }[] }
    expect(moved.results.map(row => row.ok)).toEqual([true, true])
    expect(await second.call('desktop/session/project/state', { sessionId: bound })).toEqual({ sessionId: bound, projectId: 'q' })
    expect(await second.call('desktop/session/project/state', { sessionId: unbound })).toEqual({ sessionId: unbound, projectId: 'q' })
    const guarded = await second.call('desktop/session/batch', { command: { action: 'move', sessionIds: [bound], projectId: 'p', expectedOwners: { [bound]: 'p' } } }) as { results: { ok: boolean; error?: string }[] }
    expect(guarded.results[0]!.ok).toBe(false)
    expect(await second.call('desktop/session/project/state', { sessionId: bound })).toEqual({ sessionId: bound, projectId: 'q' })
  } finally { await second.host.close() }
}, 90000)