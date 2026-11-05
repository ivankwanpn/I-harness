import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createDesktopHost } from '../src/host.ts'

// Repro for Plan 10: a host-level model turn still hits a managed-write
// conflict ("Fact admission requires recovery or was cancelled") plus private
// delivery reconciliation failures, while the composed-owned surface test
// without the host plugins runs the same kind of turn. Kept skipped so the
// reproduction is available without a red suite.
it('runs a full prompt turn through the desktop host on the commit log', async () => {
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
    const created = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'hello there' })
    expect(requests).toBeGreaterThan(0)
    const listed = await call('session/list') as { sessions: { id: string; turnCount: number }[] }
    expect(listed.sessions.find(row => row.id === created.sessionId)?.turnCount).toBe(1)
    const modelState = await call('session/model/set', { sessionId: created.sessionId, selection: { provider: 'fixture', model: 'fixture' } })
    expect(modelState).toBeTruthy()
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'second prompt' })
    expect(requests).toBeGreaterThanOrEqual(2)
    expect(await call('desktop/session/execution/read', { sessionId: created.sessionId, offset: 0, limit: 5 })).toBeTruthy()
    expect(await call('desktop/session/tasks/integrity', { sessionId: created.sessionId })).toBeTruthy()
    expect(await call('desktop/session/tasks/integrity', { sessionId: created.sessionId, reconcile: true })).toBeTruthy()
    const processes = await call('desktop/session/processes/read', { sessionId: created.sessionId }) as { live?: boolean; terminals?: unknown[]; jobs?: unknown[] }
    expect(processes).toMatchObject({ live: false })
    expect(processes.terminals).toEqual([])
    expect(processes.jobs).toEqual([])
    await expect(call('desktop/session/processes/read', { sessionId: 'missing-session' })).rejects.toThrow(/does not exist/)
    await expect(call('desktop/session/execution/read', { sessionId: 'missing-session', offset: 0, limit: 10 })).rejects.toThrow(/does not exist/)
    await expect(call('desktop/session/processes/job-output', { sessionId: created.sessionId, id: 'missing-job' })).rejects.toThrow(/Job output unavailable for this owner/)
    await expect(call('desktop/session/processes/terminal-output', { sessionId: created.sessionId, id: 'missing-terminal' })).rejects.toThrow(/Saved terminal output unavailable for this owner/)
    const executionSurface = await call('desktop/session/execution/read', { sessionId: created.sessionId, offset: 0, limit: 10 }) as { live?: boolean; cells?: unknown[]; total?: number }
    expect(executionSurface).toMatchObject({ live: false, total: 0 })
    expect(executionSurface.cells).toEqual([])
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'use todo' })
    expect(toolCalls).toBe(1)
    await writeFile(join(workspace, 'big.txt'), 'x'.repeat(200 * 1024))
    await call('session/prompt', { sessionId: created.sessionId, prompt: 'read big' })
    expect(toolCalls).toBe(2)
    await expect(call('desktop/session/execution/stop', { sessionId: created.sessionId })).rejects.toThrow(/Execution unavailable/)
    await expect(call('desktop/session/execution/stop', { sessionId: created.sessionId, cellId: 'missing-cell' })).rejects.toThrow(/cold history cannot be stopped/)
    await expect(call('desktop/session/processes/control', { sessionId: created.sessionId, command: { action: 'close', id: 'missing-process' } })).rejects.toThrow(/cold history cannot control a process/)
    const observer = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const { session } = await observer.load(created.sessionId)
      expect(session.events.some(event => event.type === 'tool/call' && event.name === 'todo_write')).toBe(true)
      expect(session.events.some(event => event.type === 'tool/result')).toBe(true)
      const bigResult = session.events.filter(event => event.type === 'tool/result' && (event as { name?: string }).name === 'read').at(-1) as { envelope?: { retention?: { kind?: string; ref?: unknown } } } | undefined
      expect(bigResult?.envelope?.retention).toMatchObject({ kind: 'artifact' })
      const ref = bigResult?.envelope?.retention?.ref
      const page = await call('session/result/read', { sessionId: created.sessionId, ref, maxBytes: 4096 }) as { ref?: { id?: string }; data?: unknown; nextOffset?: number }
      expect(page.ref?.id).toBe((ref as { id?: string }).id)
      expect(typeof page.nextOffset).toBe('number')
      expect(page.data).toBeDefined()
      const chunk = await call('session/result/read', { sessionId: created.sessionId, ref, maxBytes: 4096 }) as { ref?: { id?: string }; data?: unknown; nextOffset?: number; eof?: boolean }
      expect(chunk.nextOffset).toBeGreaterThan(0)
      expect(chunk.data).toBeDefined()
      const next = await call('session/result/read', { sessionId: created.sessionId, ref, offset: chunk.nextOffset, maxBytes: 4096 }) as { nextOffset?: number; eof?: boolean }
      expect(next.nextOffset).toBeGreaterThan(chunk.nextOffset!)
      expect(next.eof).toBe(false)
      const past = await call('session/result/read', { sessionId: created.sessionId, ref, offset: 10_000_000, maxBytes: 4096 }) as { kind?: string; reason?: string }
      expect(past).toMatchObject({ kind: 'unavailable', reason: 'budget' })
      await expect(call('session/result/read', { sessionId: created.sessionId, ref, maxBytes: 1_000_000 })).rejects.toThrow(/Invalid result page query/)
      const unknown = { ...(ref as Record<string, unknown>), contentDigest: 'a'.repeat(64) }
      expect(await call('session/result/read', { sessionId: created.sessionId, ref: unknown, maxBytes: 4096 })).toMatchObject({ kind: 'unavailable' })
      expect(await call('session/result/read', { sessionId: 'missing-session', ref, maxBytes: 4096 })).toMatchObject({ kind: 'unavailable' })
    } finally { await observer.close() }
  } finally {
    await host.close()
  }
}, 60000)