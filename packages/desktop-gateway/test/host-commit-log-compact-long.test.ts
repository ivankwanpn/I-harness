import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { createDesktopHost } from '../src/host.ts'

it('compacts a long session built through the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-compact-long-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_COMPACT_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_COMPACT_KEY: 'controlled' } }))
  const model = controlledModel(request => ({ async *stream() {
    request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
    const compaction = String(request.systemPrompt).includes('compaction engine') || String(request.messages.at(-1)?.content ?? '').includes('compaction engine')
    yield { type: 'text/chunk', text: compaction ? checkpointOfLength(600, 'compacted work summary line') : 'answer ' + 'y'.repeat(800) }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => model })
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
    for (let turn = 0; turn < 8; turn++) await call('session/prompt', { sessionId: created.sessionId, prompt: 'question ' + turn + ' ' + 'x'.repeat(600) })
    const todoBefore = await call('desktop/session/todo/write', { sessionId: created.sessionId, input: { items: [{ content: 'compaction todo', status: 'pending' }], expectedRevision: 0 } }) as { todosRevision?: number }
    expect(todoBefore.todosRevision).toBe(1)
    const compacted = await call('desktop/session/compact', { sessionId: created.sessionId }) as { compacted?: boolean; outcome?: string; publication?: string; summary?: string }
    expect(compacted).toMatchObject({ compacted: true, outcome: 'ready', publication: 'committed' })
    expect(compacted.summary).toContain('compacted work summary line')
    const afterWork = await call('desktop/session/work-state', { sessionId: created.sessionId }) as { todos: { content: string }[]; todosRevision?: number }
    expect(afterWork.todosRevision).toBe(1)
    expect(afterWork.todos[0]).toMatchObject({ content: 'compaction todo' })
  } finally {
    await host.close()
  }
}, 120000)