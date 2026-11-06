import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createDesktopHost } from '../src/host.ts'

it('rewinds a conversation that has run a turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-probe-rewind-turn-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    const created = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'first turn' })
    const points = await call('desktop/rewind/points', { sessionId: created.sessionId }) as { turnIndex: number; preview: string; files: number }[]
    expect(points).toEqual([{ turnIndex: 0, preview: 'first turn', files: 0 }])
    const plan = await call('desktop/rewind/plan', { sessionId: created.sessionId, target: 0, mode: 'conversation' }) as { fingerprint: string }
    expect(plan.fingerprint).toBeTruthy()
    expect(await call('desktop/rewind/execute', { sessionId: created.sessionId, target: 0, mode: 'conversation', fingerprint: plan.fingerprint })).toMatchObject({ truncated: true, eventAppended: true })
    const probe = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const events = (await probe.load(created.sessionId)).session.events
      expect(events.map(event => event.type)).toContain('rewind/point')
    } finally { await probe.close() }
    const deleted = await call('desktop/session/batch', { command: { action: 'delete', sessionIds: [created.sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(deleted.results[0]!.ok).toBe(true)
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).not.toContain(created.sessionId)
  } finally { await host.close() }
}, 90000)