import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('reaches the compaction engine on the legacy store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-legacy-compact-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_COMPACT_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_COMPACT_KEY: 'controlled' } }))
  const model = controlledModel(request => ({ async *stream() {
    request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
    yield { type: 'text/chunk', text: 'answer' }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir: join(root, 'sessions'), settingsPath, credentialsPath, onWrite: frame => frames.push(frame), buildProviderClient: () => model })
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id) as { result?: unknown; error?: unknown }
    if (!frame) throw new Error('missing reply for ' + method)
    if (frame.error) throw new Error(JSON.stringify(frame.error))
    return frame.result
  }
  try {
    await call('initialize')
    const created = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'hello' })
    const compacted = await call('desktop/session/compact', { sessionId: created.sessionId }) as { outcome?: string; reason?: string; blockedReason?: string }
    console.log('COMPACT ' + JSON.stringify(compacted))
    expect(compacted.outcome).toEqual(expect.any(String))
  } finally { await host.close() }
}, 90000)
