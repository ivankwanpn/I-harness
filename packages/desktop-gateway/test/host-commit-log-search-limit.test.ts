import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('limits search results across commit-log sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-search-limit-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    const a = (await call('session/create') as { sessionId: string }).sessionId
    const b = (await call('session/create') as { sessionId: string }).sessionId
    await call('session/prompt', { sessionId: a, prompt: 'limit-token one' })
    await call('session/prompt', { sessionId: a, prompt: 'limit-token two' })
    await call('session/prompt', { sessionId: b, prompt: 'limit-token three' })
    const limited = await call('desktop/session/search', { query: 'limit-token', limit: 2 }) as { hits: { sessionId: string; snippet: string }[] }
    expect(limited.hits).toHaveLength(2)
    const all = await call('desktop/session/search', { query: 'limit-token', limit: 100 }) as { hits: { sessionId: string }[] }
    expect(all.hits).toHaveLength(3)
    expect(new Set(all.hits.map(hit => hit.sessionId))).toEqual(new Set([a, b]))
  } finally { await host.close() }
}, 90000)
