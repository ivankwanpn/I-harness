import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createDesktopHost } from '../src/host.ts'

it('searches a mixed legacy and commit-log store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-mixed-search-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TURN_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TURN_KEY: 'controlled' } }))
  const legacy = createJsonlTaskTransitionCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }, taskDocumentStorageContract)
  try {
    await legacy.create({ sessionId: 'legacy-source' })
    await legacy.append('legacy-source', [{ type: 'user/message', text: 'mixed-store-token in a legacy session' }])
  } finally { await legacy.close() }
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
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'mixed-store-token in a commit log session' })
    const hits = await call('desktop/session/search', { query: 'mixed-store-token' }) as { hits: { sessionId: string }[] }
    const ids = hits.hits.map(hit => hit.sessionId)
    expect(ids).toContain('legacy-source')
    expect(ids).toContain(created.sessionId)
    expect(new Set(ids).size).toBe(ids.length)
    // The legacy session comes from the file-backed index (negative bm25), the
    // commit-log session from the coordinator fallback (bm25 0).
    expect(hits.hits.find(hit => hit.sessionId === 'legacy-source')).toMatchObject({ bm25: expect.any(Number) })
    expect((hits.hits.find(hit => hit.sessionId === 'legacy-source') as { bm25: number }).bm25).toBeLessThanOrEqual(0)
    expect(hits.hits.find(hit => hit.sessionId === created.sessionId)).toMatchObject({ bm25: 0 })
  } finally { await host.close() }
}, 90000)