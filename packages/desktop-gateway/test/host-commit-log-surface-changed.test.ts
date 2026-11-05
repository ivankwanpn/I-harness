import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('notifies a surface subscriber when the session changes on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-changed-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_CHANGED_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_CHANGED_KEY: 'controlled' } }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() {
    request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
    yield { type: 'text/chunk', text: 'answer' }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
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
    const lease = await call('desktop/surface/subscribe', { requestKey: 'r1:1', surface: 'execution', sessionId: created.sessionId }) as { subscriptionId: string; stamp: { epoch: string } }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'change please' })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !frames.some(frame => 'method' in frame && frame.method === 'desktop/surface/changed')) await new Promise(resolve => setTimeout(resolve, 50))
    const notices = frames.filter(frame => 'method' in frame && frame.method === 'desktop/surface/changed')
    expect(notices.length).toBeGreaterThan(0)
    await call('desktop/surface/unsubscribe', { subscriptionId: lease.subscriptionId })
  } finally {
    await host.close()
  }
}, 60000)
