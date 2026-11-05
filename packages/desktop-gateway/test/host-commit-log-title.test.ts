import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createDesktopHost } from '../src/host.ts'

it('derives and stores a session title on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-title-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: true, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TITLE_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TITLE_KEY: 'controlled' } }))
  const frames: RpcMessage[] = []
  let titles = 0
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() {
    request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
    if (request.systemPrompt.includes('short session title')) { titles++; yield { type: 'text/chunk', text: 'Titled Session' } }
    else yield { type: 'text/chunk', text: 'answer' }
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
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'name this conversation' })
    const observer = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const deadline = Date.now() + 5000
      let document: { formatVersion?: number; title?: string | null } | undefined
      while (Date.now() < deadline) {
        document = await observer.getDocument('session-title/' + created.sessionId) as typeof document
        if (document?.title === 'Titled Session') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(titles).toBeGreaterThan(0)
      expect(document).toMatchObject({ formatVersion: 1, title: 'Titled Session' })
    } finally { await observer.close() }
  } finally {
    await host.close()
  }
}, 60000)