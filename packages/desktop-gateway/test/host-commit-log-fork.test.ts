import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcMessage } from '@i-harness/sdk'
import { createForkOperation } from '@i-harness/session-persistence'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { createDesktopHost } from '../src/host.ts'

it('forks through the gateway fork routes on the commit log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-gateway-scl-fork-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json')
  await writeFile(settingsPath, '{}')
  const seed = asSessionCoordinator(createJsonlCommitCoordinator(sessionDir, { lock: { enabled: true, lockRoot: sessionDir } }))
  await seed.create({ sessionId: 'source' })
  await seed.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'real Gateway source' }, { type: 'turn/end' }])
  await seed.close()
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, sessionStore: 'commit-log', onWrite: frame => frames.push(frame), buildProviderClient() { throw new Error('Fork must not assemble a provider') } })
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id) as { result?: any; error?: unknown }
    if (frame.error) throw new Error(JSON.stringify(frame.error))
    return frame.result
  }
  try {
    const init = await call('initialize')
    expect(init.capabilities['session-fork-bootstrap']).toEqual(['1'])
    await call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } })
    await call('desktop/session/project/bind', { sessionId: 'source', projectId: 'p' })
    const prepared = await call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    console.error('DBG prepared', JSON.stringify((prepared as any)?.prepared?.requestIntent))
    if (prepared.kind !== 'prepared') throw new Error('preparation refused: ' + JSON.stringify(prepared))
    const operation = createForkOperation(prepared.prepared, { operationId: 'scl-fork', targetSessionId: 'child', createdAt: new Date().toISOString() })
    const begun = await call('session/fork/begin', { operation })
    expect(begun).toMatchObject({ kind: 'ready', sessionId: 'child' })
    const listed = await call('session/list')
    expect((listed.sessions as { id: string }[]).map(row => row.id)).toContain('child')
    expect(await call('desktop/session/project/state', { sessionId: 'child' })).toEqual({ sessionId: 'child', projectId: 'p' })
    const nested = await call('session/fork/prepare', { version: 1, sourceSessionId: 'child' })
    if (nested.kind !== 'prepared') throw new Error('nested preparation refused: ' + JSON.stringify(nested))
    const grandchildOperation = createForkOperation(nested.prepared, { operationId: 'scl-fork-nested', targetSessionId: 'grandchild', createdAt: new Date().toISOString() })
    expect(await call('session/fork/begin', { operation: grandchildOperation })).toMatchObject({ kind: 'ready', sessionId: 'grandchild' })
    // SCL birth is one committed create; the legacy staged resume has no
    // counterpart, so a passive replay refuses instead of pretending to adopt.
    expect(await call('session/fork/retry', { operation })).toMatchObject({ kind: 'not-issued', reason: 'unsupported' })
  } finally {
    await host.close()
  }
}, 60000)