import { expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { createSessionService } from '@i-harness/session-executor'
import { createSdkServer } from '../src/server.ts'
import { HarnessClient } from '../src/client.ts'
import { decodeFrame, encodeFrame, makeRequest } from '../src/protocol.ts'
import type { ManagedArtifactRef } from '@i-harness/core-session'

const frame: ManagedArtifactRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 1234, contentDigest: 'c'.repeat(64), completeness: 'complete' }
const catalog: ManagedArtifactRef = { ...frame, id: 'ctxv1_' + 'd'.repeat(64), codec: 'json-utf8-v1' }

it('advertises v2 only for an explicit capable host and rejects downgrade before custom-reader admission', async () => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: 'test-mock' })
  let admissions = 0
  const readResultPage = async () => { admissions++; return { kind: 'unavailable' as const, reason: 'not-found' as const } }
  const v1 = createSdkServer(service, { readResultPage })
  const v2 = createSdkServer(service, { readResultPage, supportsResultDependencyMembership: true })
  let serial = 0
  const call = async (server: typeof v1, method: string, params = {}) => decodeFrame((await server.handleLine(encodeFrame(makeRequest(++serial, method, params))))!) as any
  try {
    expect((await call(v1, 'initialize')).result.capabilities['session-result-read']).toEqual(['1'])
    expect((await call(v2, 'initialize')).result.capabilities['session-result-read']).toEqual(['1', '2'])
    expect(await call(v1, 'session/result/read', { sessionId: 's', ref: frame, viaCatalog: catalog })).toMatchObject({ error: { code: -32602 } })
    expect(admissions).toBe(0)
    expect(await call(v2, 'session/result/read', { sessionId: 's', ref: frame, viaCatalog: catalog })).toMatchObject({ result: { kind: 'unavailable', reason: 'not-found' } })
    expect(admissions).toBe(1)
    expect(await call(v1, 'session/result/read', { sessionId: 's', ref: frame })).toMatchObject({ result: { kind: 'unavailable' } })
    expect(admissions).toBe(2)
    const input = new PassThrough(), replies = new PassThrough(), client = new HarnessClient(replies, input)
    input.on('data', line => { void v1.handleLine(String(line).trim()).then(reply => { if (reply) replies.write(reply + '\n') }) })
    try {
      await client.initialize()
      await expect(client.readResultPage('s', { ref: frame, viaCatalog: catalog })).rejects.toThrow(/supported|capab|version/i)
      expect(admissions).toBe(2)
    } finally { await client.close() }
  } finally { await v1.close(); await v2.close(); await service.close() }
})
