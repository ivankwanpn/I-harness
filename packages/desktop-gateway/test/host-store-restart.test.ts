import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

// The store chosen from settings must survive a host restart: the setting is
// the only source of the choice (no option, no environment variable here).
it('keeps a settings-selected commit log across a host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-store-restart-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ sessionStore: 'commit-log', autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_RESTART_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }), 'utf8')
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_RESTART_KEY: 'controlled' } }), 'utf8')
  const previous = process.env.IH_SESSION_STORE
  delete process.env.IH_SESSION_STORE
  const open = async () => {
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: (frame: RpcMessage) => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() {
      request.signal?.throwIfAborted()
      yield { type: 'text/chunk', text: 'restart answer' }
      yield { type: 'end' }
    } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
    let serial = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++serial
      await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const reply = frames.findLast(frame => 'id' in frame && frame.id === id)
      if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
      return reply.result
    }
    return { host, call }
  }
  try {
    const first = await open()
    let sessionId = ''
    try {
      await first.call('initialize')
      sessionId = ((await first.call('session/create')) as { sessionId: string }).sessionId
      await first.call('session/prompt', { sessionId, prompt: 'restart me' })
      expect((await first.call('desktop/environment/diagnostics', {}) as { sessionStore?: string }).sessionStore).toBe('commit-log')
    } finally { await first.host.close() }
    const second = await open()
    try {
      await second.call('initialize')
      const listed = await second.call('session/list') as { sessions: { id: string }[] }
      expect(listed.sessions.map(row => row.id)).toContain(sessionId)
      const history = await second.call('session/history', { sessionId, afterSeq: 0, limit: 50 }) as { events: { type: string; text?: string }[] }
      expect(history.events.some(event => event.type === 'user/message' && event.text === 'restart me')).toBe(true)
      expect((await second.call('desktop/environment/diagnostics', {}) as { sessionStore?: string }).sessionStore).toBe('commit-log')
    } finally { await second.host.close() }
  } finally {
    if (previous === undefined) delete process.env.IH_SESSION_STORE
    else process.env.IH_SESSION_STORE = previous
  }
}, 90000)
