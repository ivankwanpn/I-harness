import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createDesktopHost } from '../src/host.ts'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'

// Current asymmetry, pinned deliberately: a legacy host only scans `<id>.jsonl`
// files, so sessions written by the commit log are on disk but not listed. They
// remain visible again when the commit log is selected.
it('does not list a commit-log session on a legacy host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-store-legacy-invisible-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const seed = asSessionCoordinator(createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }))
  await seed.create({ sessionId: 'scl-only', title: 'Commit log session' })
  await seed.append('scl-only', [{ type: 'user/message', text: 'only in the commit log' }])
  await seed.close()
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ sessionStore: 'jsonl', autoTitle: false, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' } }), 'utf8')
  await writeFile(credentialsPath, JSON.stringify({ refs: {} }), 'utf8')
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: (frame: RpcMessage) => frames.push(frame), buildProviderClient: () => controlledModel(request => ({ async *stream() { yield { type: 'text/chunk', text: 'unused' }; yield { type: 'end' } } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
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
    const listed = await call('session/list') as { sessions: { id: string }[] }
    expect(listed.sessions.map(row => row.id)).not.toContain('scl-only')
  } finally { await host.close() }
}, 60000)
