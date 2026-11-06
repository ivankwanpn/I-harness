import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopHost } from '../src/host.ts'

async function countFiles(root: string): Promise<number> {
  let total = 0
  async function walk(dir: string) {
    let entries: { name: string; isDirectory(): boolean }[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name))
      else total++
    }
  }
  await walk(root)
  return total
}

// Deleting a session must not leave its per-session result artifacts behind
// under the shared native-context store.
it('cleans a deleted session\'s result artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-probe-artifacts-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_ART_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_ART_KEY: 'controlled' } }))
  await writeFile(join(workspace, 'big.txt'), 'x'.repeat(200 * 1024))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() {
    request.signal?.throwIfAborted()
    if (request.messages.at(-1)?.role === 'tool') { yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' }; return }
    if (request.messages.at(-1)?.content === 'read big') { yield { type: 'tool_call', call: { id: 'c', name: 'read', args: { path: 'big.txt' } } }; yield { type: 'end' }; return }
    yield { type: 'text/chunk', text: 'ok' }; yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const reply = frames.findLast(frame => 'id' in frame && frame.id === id)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    await call('initialize')
    const { sessionId } = await call('session/create') as { sessionId: string }
    await call('session/prompt', { sessionId, prompt: 'read big' })
    const storeRoot = join(sessionDir, 'native-context')
    const before = await countFiles(storeRoot)
    await call('desktop/session/batch', { command: { action: 'delete', sessionIds: [sessionId] } })
    const after = await countFiles(storeRoot)
    expect(before).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
  } finally { await host.close() }
}, 90000)