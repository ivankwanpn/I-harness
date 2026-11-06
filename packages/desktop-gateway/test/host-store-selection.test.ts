import { expect, it } from 'vitest'
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

type Diagnostics = { sessionStore?: string }

async function open(root: string, settings: Record<string, unknown>, option?: 'jsonl' | 'commit-log') {
  const workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace, { recursive: true })
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify(settings), 'utf8')
  await writeFile(credentialsPath, JSON.stringify({ refs: {} }), 'utf8')
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, ...(option ? { sessionStore: option } : {}), onWrite: (frame: RpcMessage) => frames.push(frame) } as never)
  let id = 0
  const call = async (method: string, params: unknown = {}) => {
    const requestId = ++id
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
    const reply = frames.findLast(frame => 'id' in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  return { host, sessionDir, call, workspace }
}

it('selects the session store from settings and honours the host option over it', async () => {
  const previous = process.env.IH_SESSION_STORE
  delete process.env.IH_SESSION_STORE
  try {
    const root = await mkdtemp(join(tmpdir(), 'ih-store-select-'))
    const first = await open(join(root, 'a'), { sessionStore: 'commit-log' })
    try {
      await first.call('initialize')
      const { sessionId } = await first.call('session/create') as { sessionId: string }
      expect((await first.call('desktop/environment/diagnostics', {}) as Diagnostics).sessionStore).toBe('commit-log')
      // The commit log writes one generation directory per session.
      const generation = await stat(join(first.sessionDir, sessionId, 'session.v15.jsonl'))
      expect(generation.isFile()).toBe(true)
    } finally { await first.host.close() }
    const second = await open(join(root, 'b'), { sessionStore: 'commit-log' }, 'jsonl')
    try {
      await second.call('initialize')
      const { sessionId } = await second.call('session/create') as { sessionId: string }
      expect((await second.call('desktop/environment/diagnostics', {}) as Diagnostics).sessionStore).toBe('jsonl')
      const legacy = await stat(join(second.sessionDir, `${sessionId}.jsonl`))
      expect(legacy.isFile()).toBe(true)
    } finally { await second.host.close() }
  } finally {
    if (previous === undefined) delete process.env.IH_SESSION_STORE
    else process.env.IH_SESSION_STORE = previous
  }
}, 60000)