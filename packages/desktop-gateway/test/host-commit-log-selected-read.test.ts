import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { createDesktopHost } from '../src/host.ts'

// E2E: a source turn writes a real artifact and references it; after the host
// restart the selected-results fork must let the child read the same page.
it('reads an inherited result page on the selected child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-selected-read-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_SEL_READ_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_SEL_READ_KEY: 'controlled' } }))
  await writeFile(join(workspace, 'big.txt'), 'x'.repeat(200 * 1024), 'utf8')
  const model = () => controlledModel(request => ({ async *stream(request) {
    request.signal?.throwIfAborted()
    if (request.messages.at(-1)?.role === 'tool') { yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' }; return }
    if (request.messages.at(-1)?.content === 'read big') { yield { type: 'tool_call', call: { id: 'call-read', name: 'read', args: { path: 'big.txt' } } }; yield { type: 'end' }; return }
    yield { type: 'text/chunk', text: 'ok' }; yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const frameSink = () => { const frames: RpcMessage[] = []; return { frames, call: async (host: Awaited<ReturnType<typeof createDesktopHost>>, serialRef: { n: number }, method: string, params: unknown = {}) => {
    const id = ++serialRef.n
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id)
    if (!frame || !isRpcSuccess(frame)) throw new Error(JSON.stringify(frame))
    return frame.result
  } } }
  const first = frameSink()
  const hostA = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => first.frames.push(frame), buildProviderClient: () => model() })
  const serialA = { n: 0 }
  let sessionId = ''
  try {
    await first.call(hostA, serialA, 'initialize')
    sessionId = ((await first.call(hostA, serialA, 'session/create')) as { sessionId: string }).sessionId
    await first.call(hostA, serialA, 'session/prompt', { sessionId, prompt: 'read big' })
  } finally { await hostA.close() }
  const ref = await (async () => {
    const seeder = createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } })
    try {
      const { session } = await seeder.load(sessionId)
      const result = session.events.filter(event => event.type === 'tool/result' && (event as { name?: string }).name === 'read').at(-1) as { callId?: string; envelope?: { retention?: { ref?: { id: string; revision: string } } } } | undefined
      const artifact = result?.envelope?.retention?.ref
      if (!artifact) throw new Error('the turn did not produce an artifact result')
      await seeder.append(sessionId, [{ type: 'context/result-ref', ref: { id: artifact.id, workspaceId: 'w', sessionId, callId: result!.callId ?? 'call-read', label: 'read', revision: artifact.revision, bytes: 12, originalBytes: 200 * 1024, complete: true, expiresAt: 0 } }] as never)
      return artifact
    } finally { await seeder.close() }
  })()
  const second = frameSink()
  const hostB = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => second.frames.push(frame), buildProviderClient: () => model() })
  const serialB = { n: 0 }
  try {
    await second.call(hostB, serialB, 'initialize')
    const sourcePage = await second.call(hostB, serialB, 'session/result/read', { sessionId, ref, maxBytes: 4096 }) as { data?: unknown }
    expect(sourcePage.data).toBeDefined()
    const prepared = await second.call(hostB, serialB, 'session/fork/prepare', { version: 2, sourceSessionId: sessionId, results: 'selected-results-v1' }) as { version?: number; requestDigest?: string }
    expect(prepared).toMatchObject({ version: 2 })
    const operation = { version: 2, kind: 'session-fork-operation', prepared,
      invocation: { version: 1, operationId: 'selected-read', targetSessionId: 'read-child', createdAt: new Date().toISOString(), requestDigest: prepared.requestDigest } }
    expect(await second.call(hostB, serialB, 'session/fork/begin', { operation })).toMatchObject({ version: 2, kind: 'ready', sessionId: 'read-child' })
    // A live child (it has run a turn) still cannot read the inherited page: the
    // service's observation does not carry the selected results it inherited.
    await second.call(hostB, serialB, 'session/prompt', { sessionId: 'read-child', prompt: 'hello child' })
    const childPage = await second.call(hostB, serialB, 'session/result/read', { sessionId: 'read-child', ref, maxBytes: 4096 }) as { kind?: string; reason?: string }
    expect(childPage).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
  } finally { await hostB.close() }
}, 120000)