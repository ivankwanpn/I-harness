import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('applies an automatic title on the first legacy turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-auto-title-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: true, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TITLE_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TITLE_KEY: 'controlled' } }))
  const frames: RpcMessage[] = []
  let titles = 0
  const host = await createDesktopHost({ workspace, sessionDir: join(root, 'sessions'), settingsPath, credentialsPath, onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() {
    if (request.systemPrompt.includes('You produce ONLY a short session title')) { titles++; yield { type: 'text/chunk', text: 'Controlled title' } }
    else yield { type: 'text/chunk', text: 'controlled answer' }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
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
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'hello there' })
    const history = await call('session/history', { sessionId: created.sessionId, afterSeq: 0, limit: 50 }) as { events?: { type: string; title?: string }[] }
    expect(titles).toBe(1)
    expect(JSON.stringify(history)).toContain('session/title')
    expect(JSON.stringify(history)).toContain('Controlled title')
  } finally { await host.close() }
}, 90000)