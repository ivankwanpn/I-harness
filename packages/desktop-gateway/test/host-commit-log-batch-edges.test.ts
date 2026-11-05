import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('handles repeated archive and delete of an archived session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-batch-edges-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    const sessionId = created.sessionId
    const first = await call('desktop/session/batch', { command: { action: 'archive', sessionIds: [sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(first.results[0]!.ok).toBe(true)
    const again = await call('desktop/session/batch', { command: { action: 'archive', sessionIds: [sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(again.results[0]!.ok).toBe(true)
    const archived = await call('desktop/session/archived') as { id: string }[]
    expect(archived.map(row => row.id)).toContain(sessionId)
    const deleted = await call('desktop/session/batch', { command: { action: 'delete', sessionIds: [sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(deleted.results[0]!.ok).toBe(true)
    expect(deleted.results[0]!.ok).toBe(true)
    const after = await call('desktop/session/archived') as { id: string }[]
    expect(after.map(row => row.id)).not.toContain(sessionId)
    const restoreGone = await call('desktop/session/batch', { command: { action: 'restore', sessionIds: [sessionId] } }) as { results: { ok: boolean; error?: string }[] }
    expect(restoreGone.results[0]!.ok).toBe(false)
    expect(restoreGone.results[0]!.error).toContain('does not exist')
  } finally { await host.close() }
}, 90000)