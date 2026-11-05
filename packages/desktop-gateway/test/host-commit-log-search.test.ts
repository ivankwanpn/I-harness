import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

it('searches a commit-log session transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-search-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
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
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'unique-search-token please' })
    const hits = await call('desktop/session/search', { query: 'unique-search-token' }) as { hits: { sessionId: string; snippet: string }[] }
    expect(hits.hits.some(hit => hit.sessionId === created.sessionId && hit.snippet.includes('unique-search-token'))).toBe(true)
    const missing = await call('desktop/session/search', { query: 'token-that-is-not-there' }) as { hits: unknown[] }
    expect(missing.hits).toEqual([])
    const contextHits = await call('desktop/context/search', { contextKind: 'sessions', query: 'unique-search-token', offset: 0 }) as { items: { kind: string; sessionId: string; seq: number; excerpt?: string }[]; total: number }
    expect(contextHits.total).toBe(1)
    expect(contextHits.items[0]).toMatchObject({ kind: 'session', sessionId: created.sessionId })
    expect(contextHits.items[0]!.excerpt).toContain('unique-search-token')
    const item = contextHits.items[0]!
    await writeFile(join(workspace, 'notes.txt'), 'context file token\n', 'utf8')
    const fileHits = await call('desktop/context/search', { contextKind: 'files', query: 'notes', offset: 0 }) as { items: { kind: string; path?: string }[]; total: number }
    expect(fileHits.items.some(entry => entry.kind === 'file' && entry.path === 'notes.txt')).toBe(true)
    await expect(call('desktop/context/read', { reference: { kind: 'session', workspaceId: workspace, sessionId: item.sessionId, seq: item.seq }, projectId: 'other' })).rejects.toThrow(/outside the current project/)
    const ctxRead = await call('desktop/context/read', { reference: { kind: 'session', workspaceId: workspace, sessionId: item.sessionId, seq: item.seq } }) as { text: string; truncated: boolean }
    expect(ctxRead.text).toContain('unique-search-token')
    expect(ctxRead.truncated).toBe(false)
    await call('desktop/session/manage', { sessionId: created.sessionId, action: 'archive' })
    const archivedSearch = await call('desktop/context/search', { contextKind: 'sessions', query: 'unique-search-token', offset: 0 }) as { items: { sessionId: string }[] }
    expect(archivedSearch.items).toEqual([])
    await expect(call('desktop/context/read', { reference: { kind: 'session', workspaceId: workspace, sessionId: item.sessionId, seq: item.seq } })).rejects.toThrow(/outside the current project/)
  } finally { await host.close() }
}, 90000)