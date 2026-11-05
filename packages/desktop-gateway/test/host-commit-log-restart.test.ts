import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

// A desktop restart is a second host on the same commit-log store: the session
// must load cold and accept another turn, and the first host must have released
// its ownership pins (otherwise the second prompt waits on the capability lock).
it('continues a session through a second host on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-restart-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TURN_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TURN_KEY: 'controlled' } }))
  let requests = 0
  const open = async () => {
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream(request) {
      request.signal?.throwIfAborted()
      request.validateBeforeTransport?.()
      requests++
      yield { type: 'text/chunk', text: 'answer ' + requests }
      yield { type: 'end' }
    } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
    let serial = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++serial
      await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const frame = frames.findLast(frame => 'id' in frame && frame.id === id)
      if (!frame) throw new Error('missing reply for ' + method)
      if (!isRpcSuccess(frame)) throw new Error(JSON.stringify(frame))
      return frame.result
    }
    await call('initialize')
    return { host, call }
  }
  const first = await open()
  let sessionId = ''
  try {
    sessionId = (await first.call('session/create') as { sessionId: string }).sessionId
    await first.call('session/prompt', { sessionId, prompt: 'first' })
    expect((await first.call('session/list') as { sessions: { id: string; turnCount: number }[] }).sessions.find(row => row.id === sessionId)?.turnCount).toBe(1)
  } finally { await first.host.close() }
  const second = await open()
  try {
    const before = await second.call('session/list') as { sessions: { id: string; turnCount: number }[] }
    expect(before.sessions.find(row => row.id === sessionId)?.turnCount).toBe(1)
    await second.call('session/prompt', { sessionId, prompt: 'second' })
    const after = await second.call('session/list') as { sessions: { id: string; turnCount: number }[] }
    expect(after.sessions.find(row => row.id === sessionId)?.turnCount).toBe(2)
  } finally { await second.host.close() }
}, 90000)