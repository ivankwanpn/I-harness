import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createCommitCoordinator } from '../../session-persistence/src/commit/coordinator.ts'
import { codecRef } from '../../core-session/test/fixtures/selected-results.ts'
import { createDesktopHost } from '../src/host.ts'

// Repro for Plan 10: a host-level model turn still hits a managed-write
// conflict ("Fact admission requires recovery or was cancelled") plus private
// delivery reconciliation failures, while the composed-owned surface test
// without the host plugins runs the same kind of turn. Kept skipped so the
// reproduction is available without a red suite.
it('forks a session with selected results on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-turn-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TURN_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TURN_KEY: 'controlled' } }))
  let requests = 0, toolCalls = 0
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream(request) {
    request.signal?.throwIfAborted()
    request.validateBeforeTransport?.()
    requests++
    if (request.messages.at(-1)?.role === 'tool') { yield { type: 'text/chunk', text: 'controlled answer' }; yield { type: 'end' }; return }
    if (request.messages.at(-1)?.content === 'use todo' && toolCalls === 0) {
      toolCalls++
      yield { type: 'tool_call', call: { id: 'call-todo', name: 'todo_write', args: { todos: [{ content: 'do it', status: 'pending' }] } } }
      yield { type: 'end' }
      return
    }
    if (request.messages.at(-1)?.content === 'read big' && toolCalls === 1) {
      toolCalls++
      yield { type: 'tool_call', call: { id: 'call-read', name: 'read', args: { path: 'big.txt' } } }
      yield { type: 'end' }
      return
    }
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
    await writeFile(join(workspace, 'big.txt'), 'x'.repeat(20000), 'utf8')
    const created = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'read big' })
    const prepared = await call('session/fork/prepare', { version: 2, sourceSessionId: created.sessionId, results: 'selected-results-v1' }) as { version?: number; kind?: string; requestDigest?: string }
    expect(prepared).toMatchObject({ version: 2, kind: 'session-fork-prepared' })
    const operation = { version: 2, kind: 'session-fork-operation', prepared,
      invocation: { version: 1, operationId: 'selected-fork', targetSessionId: 'selected-child', createdAt: new Date().toISOString(), requestDigest: prepared.requestDigest } }
    expect(await call('session/fork/begin', { operation })).toMatchObject({ version: 2, kind: 'ready', sessionId: 'selected-child' })
    expect(((await call('session/list')) as { sessions: { id: string }[] }).sessions.map(row => row.id)).toContain('selected-child')
    const observer = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const events = (await observer.load('selected-child')).session.events as { type: string; page?: { rows?: unknown[] } }[]
      expect(events.some(event => event.type === 'conversation/seed-manifest')).toBe(true)
      const pages = events.filter(event => event.type === 'conversation/seed-results')
      expect(pages).toHaveLength(0)
    } finally { await observer.close() }
  } finally {
    await host.close()
  }
}, 60000)
it('forks a source that already references a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-selected-ref-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_SEL_KEY', models: [{ id: 'fixture' }] } } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_SEL_KEY: 'controlled' } }))
  const seeder = createCommitCoordinator({ root: sessionDir })
  try {
    await seeder.create({ sessionId: 'seeded' })
    await seeder.append('seeded', [
      { type: 'turn/start' }, { type: 'step/start' },
      { type: 'tool/call', callId: 'c', name: 'read', args: {} },
      { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
      { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
      { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: { ...codecRef } } } },
      { type: 'context/result-ref', ref: { id: codecRef.id, workspaceId: 'w', sessionId: 'seeded', callId: 'c', label: 'read', revision: codecRef.revision, bytes: 12, originalBytes: 12, complete: true, expiresAt: 0 } },
      { type: 'step/end' }, { type: 'turn/end' },
    ] as never)
  } finally { await seeder.close() }
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(() => ({ async *stream() { yield { type: 'text/chunk', text: 'unused' }; yield { type: 'end' } } } as import('@i-harness/llm-seam').ModelClient).stream({} as never)) })
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
    const prepared = await call('session/fork/prepare', { version: 2, sourceSessionId: 'seeded', results: 'selected-results-v1' }) as { version?: number; kind?: string; requestDigest?: string }
    expect(prepared).toMatchObject({ version: 2, kind: 'session-fork-prepared' })
    const operation = { version: 2, kind: 'session-fork-operation', prepared,
      invocation: { version: 1, operationId: 'selected-ref', targetSessionId: 'ref-child', createdAt: new Date().toISOString(), requestDigest: prepared.requestDigest } }
    expect(await call('session/fork/begin', { operation })).toMatchObject({ version: 2, kind: 'ready', sessionId: 'ref-child' })
    const observer = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const events = (await observer.load('ref-child')).session.events as { type: string }[]
      expect(events.filter(event => event.type === 'conversation/seed-results').length).toBeGreaterThan(0)
    } finally { await observer.close() }
  } finally { await host.close() }
}, 90000)
