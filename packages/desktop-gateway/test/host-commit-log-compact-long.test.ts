import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createDesktopHost } from '../src/host.ts'

// Repro for Plan 29: compaction of a long commit-log session does not settle.
// On a short session the summarizer blocks with no-progress (nothing to shrink);
// with a real history the compact request fails and host close reports
// "session service cleanup incomplete". Kept skipped so the scenario is ready.
it.skip('compacts a long session on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-compact-long-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_COMPACT_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_COMPACT_KEY: 'controlled' } }))
  const seed = asSessionCoordinator(createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }))
  await seed.create({ sessionId: 'long' })
  const history: Record<string, unknown>[] = []
  for (let turn = 0; turn < 12; turn++) {
    history.push({ type: 'turn/start' }, { type: 'user/message', text: 'question ' + turn + ' ' + 'x'.repeat(400) }, { type: 'assistant/message', text: 'answer ' + turn + ' ' + 'y'.repeat(400) }, { type: 'turn/end' })
  }
  await seed.append('long', history as never)
  await seed.close()
  const model = controlledModel(request => ({ async *stream() {
    request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
    const compaction = String(request.systemPrompt).includes('compaction engine') || String(request.messages.at(-1)?.content ?? '').includes('compaction engine')
    yield { type: 'text/chunk', text: compaction ? checkpointOfLength(600, 'compacted work summary line') : 'answer' }
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
    const compacted = await call('desktop/session/compact', { sessionId: 'long' }) as { compacted?: boolean }
    expect(compacted.compacted).toBe(true)
  } finally {
    await host.close()
  }
}, 60000)
