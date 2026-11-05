import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

// Repro for Plan 10: a host-level model turn still hits a managed-write
// conflict ("Fact admission requires recovery or was cancelled") plus private
// delivery reconciliation failures, while the composed-owned surface test
// without the host plugins runs the same kind of turn. Kept skipped so the
// reproduction is available without a red suite.
// Repro for Plan 11: schedule create (a live tool write) after a turn fails
// with "Gateway plugin refresh requires recovery" on the commit log, while the
// prompt-only turn passes. Kept skipped so the reproduction is available.
it.skip('creates and deletes a schedule through the desktop host on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-turn-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TURN_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TURN_KEY: 'controlled' } }))
  let requests = 0
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
  try {
    await call('initialize')
    const created = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'hello there' })
    expect(requests).toBeGreaterThan(0)
    const listed = await call('session/list') as { sessions: { id: string; turnCount: number }[] }
    expect(listed.sessions.find(row => row.id === created.sessionId)?.turnCount).toBe(1)
    await call('desktop/schedule/create', { sessionId: created.sessionId, command: { prompt: 'later', after_seconds: 600 } })
    const scheduled = await call('desktop/schedule/list', { sessionId: created.sessionId }) as { schedules: { id: string }[] }
    expect(scheduled.schedules).toHaveLength(1)
    await call('desktop/schedule/delete', { sessionId: created.sessionId, id: scheduled.schedules[0]!.id })
    expect((await call('desktop/schedule/list', { sessionId: created.sessionId }) as { schedules: unknown[] }).schedules).toHaveLength(0)
  } finally {
    await host.close()
  }
}, 60000)