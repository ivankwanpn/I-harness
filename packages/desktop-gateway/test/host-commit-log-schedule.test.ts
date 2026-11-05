import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

// Schedule create/list/delete is a live tool write on the commit log; this test
// also reopens a second host on the same store so the schedule document has to
// survive a restart, and the first host must release its capability lock when
// it closes (otherwise the second host's cold delete times out on the lock).
it('keeps a schedule across a host restart on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-turn-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
      yield { type: 'text/chunk', text: 'controlled answer' }
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
    const created = await first.call('session/create') as { sessionId: string }
    sessionId = created.sessionId
    await first.call('session/prompt', { sessionId, prompt: 'hello there' })
    expect(requests).toBeGreaterThan(0)
    await first.call('desktop/schedule/create', { sessionId, command: { prompt: 'later', after_seconds: 600 } })
    expect((await first.call('desktop/schedule/list', { sessionId }) as { schedules: unknown[] }).schedules).toHaveLength(1)
  } finally { await first.host.close() }
  const second = await open()
  try {
    const restored = await second.call('desktop/schedule/list', { sessionId }) as { schedules: { id: string }[] }
    expect(restored.schedules).toHaveLength(1)
    await second.call('desktop/schedule/delete', { sessionId, id: restored.schedules[0]!.id })
    expect((await second.call('desktop/schedule/list', { sessionId }) as { schedules: unknown[] }).schedules).toHaveLength(0)
  } finally { await second.host.close() }
}, 90000)
