import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { contextWorkspaceLocation, contextSourceIdentity, createContextOutputService } from '@i-harness/context-output'
import { createDesktopHost } from '../src/host.ts'
import { encodeFrame, makeRequest, type RpcMessage } from '@i-harness/sdk'

it('wires the actual fresh Gateway host to its original durable artifact owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'result-host-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await mkdir(sessionDir); await writeFile(settingsPath, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'conversation' }); await coordinator.create({ sessionId: 'hidden', origin: 'subagent', parentSession: 'conversation', seedLength: 0 }); await coordinator.flush('conversation')
  const location = await contextWorkspaceLocation(workspace, sessionDir)
  const owner = createContextOutputService({ root: location.serviceRoot, workspaceId: location.workspaceKey, authorizeResult: async () => true })
  const scope = owner.registerResultScope({ operationId: 'host-original', sessionId: 'conversation', callId: 'c', source: { sourceId: contextSourceIdentity(location.workspaceKey, location.canonical) } }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('actual host retained bytes'))
  const saved = await sink.finish('capture-canceled'); if (saved.kind !== 'committed') throw new Error('Original fixture refused')
  await owner.grant({ sessionId: 'conversation' }, [saved.ref.id], 'hidden')
  await owner.close(); await coordinator.close()
  const frames: RpcMessage[] = [], host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) })
  let id = 0
  const call = async (method: string, params = {}) => { const current = ++id; await host.handleLine(encodeFrame(makeRequest(current, method, params))); return frames.find(frame => 'id' in frame && frame.id === current) as any }
  try {
    const before = await readFile(join(sessionDir, 'conversation.jsonl'))
    expect(await call('initialize')).toMatchObject({ result: { capabilities: { 'session-result-read': ['1', '2'] } } })
    expect(await call('session/result/read', { sessionId: 'conversation', ref: saved.ref })).toMatchObject({ result: { ref: saved.ref, eof: true, data: { text: 'actual host retained bytes' } } })
    expect(await call('session/result/read', { sessionId: 'hidden', ref: saved.ref })).toMatchObject({ result: { kind: 'unavailable' } })
    expect(await call('session/result/read', { sessionId: 'conversation', ref: saved.ref, maxBytes: 64000 })).toMatchObject({ error: { code: -32602 } })
    expect(await readFile(join(sessionDir, 'conversation.jsonl'))).toEqual(before)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)
