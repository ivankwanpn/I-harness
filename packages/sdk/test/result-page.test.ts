import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'
import { createSessionService } from '@i-harness/session-executor'
import { createSdkServer } from '../src/server.ts'
import { HarnessClient } from '../src/client.ts'
import { decodeFrame, encodeFrame, makeRequest } from '../src/protocol.ts'

it('requires an injected host port, reads a cold original result and refuses malformed pages before host admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-result-')), coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const settings = join(root, 'settings.json'); await writeFile(settings, '{}')
  await coordinator.create({ sessionId: 's' }); await coordinator.flush('s')
  const lease = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: 's', contextOutputSettingsPath: settings }), owner = lease.service!
  const scope = owner.registerResultScope({ operationId: 'sdk', sessionId: 's', callId: 'c', source: await lease.sourceFor!('s') }, () => true)
  const sink = await owner.beginResult(scope, 'json-utf8-v1'); await sink.write(Buffer.from('{"answer":42}'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original fixture refused')
  await lease.release(); await coordinator.close()
  const cold = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  let executions = 0, admissions = 0
  const service = createSessionService({ workspace: root, coordinator: cold, contextOutputSettingsPath: settings, modelBindingFor: async () => { executions++; throw new Error('No model may prepare') } })
  const base = createSdkServer(service), hosted = createSdkServer(service, { readResultPage: (id, query) => { admissions++; return service.readResultPage!(id, query) } })
  let id = 0
  const call = async (server: typeof base, method: string, params = {}) => decodeFrame((await server.handleLine(encodeFrame(makeRequest(++id, method, params))))!) as any
  try {
    expect((await call(base, 'initialize')).result.capabilities['session-result-read']).toBeUndefined()
    expect(await call(base, 'session/result/read', { sessionId: 's', ref: saved.ref })).toMatchObject({ error: { code: -32601 } })
    expect((await call(hosted, 'initialize')).result.capabilities['session-result-read']).toEqual(['1'])
    const before = await readFile(join(root, 's.jsonl'))
    expect(await call(hosted, 'session/result/read', { sessionId: 's', ref: saved.ref })).toMatchObject({ result: { ref: saved.ref, eof: true, data: { kind: 'text', text: '{"answer":42}' } } })
    for (const extra of [{ maxBytes: 64000 }, { cursor: { recordOffset: 0, sliceOffset: 0 } }, { textView: true }, { extra: 1 }]) {
      expect(await call(hosted, 'session/result/read', { sessionId: 's', ref: saved.ref, ...extra })).toMatchObject({ error: { code: -32602 } })
    }
    expect(admissions).toBe(1); expect(executions).toBe(0); expect(service.hasAssembly('s')).toBe(false)
    expect(await readFile(join(root, 's.jsonl'))).toEqual(before)
    const input = new PassThrough(), replies = new PassThrough(), client = new HarnessClient(replies, input)
    input.on('data', line => { void hosted.handleLine(String(line).trim()).then(reply => { if (reply) replies.write(reply + '\n') }) })
    try {
      await client.initialize()
      expect(await client.session('s').readResultPage({ ref: saved.ref })).toMatchObject({ eof: true, data: { text: '{"answer":42}' } })
    } finally { await client.close() }
  } finally { await base.close(); await hosted.close(); await service.close(); await cold.close(); await rm(root, { recursive: true, force: true }) }
})
