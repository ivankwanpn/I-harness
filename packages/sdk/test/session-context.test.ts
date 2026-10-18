import { expect, it } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSdkServer } from "../src/server.ts"
import { decodeFrame, encodeFrame, makeRequest } from "../src/protocol.ts"
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toJSONL, type SessionEvent } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'

it('serves literal replacement records and cold context through actual SDK readers with no model preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-sdk-'))
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'sdk', text: 'S', coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ]
  const text = toJSONL({ formatVersion: 7, header: { origin: 'fixture' }, events }), lines = text.split('\n')
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sessionId: 's', createdAt: 'literal' })
  const raw = lines.join('\n'), path = join(root, 's.jsonl')
  await writeFile(path, raw)
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let preparations = 0
  const service = createSessionService({ workspace: root, coordinator, modelBindingFor: async () => { preparations++; return { status: 'unconfigured', reason: 'read only fixture' } } })
  const server = createSdkServer(service, { coordinator })
  try {
    await server.handleLine(encodeFrame(makeRequest(1, 'initialize', {})))
    const history = decodeFrame((await server.handleLine(encodeFrame(makeRequest(2, 'session/history', { sessionId: 's' }))))!)
    expect(history).toMatchObject({ result: { events, nextSeq: 7 } })
    const context = decodeFrame((await server.handleLine(encodeFrame(makeRequest(3, 'session/context', { sessionId: 's' }))))!)
    expect(context).toHaveProperty('result')
    expect(preparations).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(raw)
  } finally { await server.close(); await service.close(); await coordinator.close() }
})

it("reports estimated active context against the resolved model window", async () => {
  const service = createSessionService({ workspace: process.cwd(), modelBindingFor: async () => ({ status: "ready", binding: {
    providerId: "local", modelId: "mock", label: "Local mock", contextWindow: 100000,
    model: { async *stream() { yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const } },
  } }) })
  const server = createSdkServer(service)
  try {
    const hello = decodeFrame((await server.handleLine(encodeFrame(makeRequest(1, "initialize", {}))))!)
    expect(hello).toMatchObject({ result: { capabilities: { "session-context": ["1"] } } })
    await server.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "context", prompt: "hello" })))
    const state = decodeFrame((await server.handleLine(encodeFrame(makeRequest(3, "session/context", { sessionId: "context" }))))!)
    expect(state).toMatchObject({ result: { kind: "unavailable", observation: { version: 2, freshness: 'awaiting-projection', disposition: 'compatibility', estimate: { kind: 'estimated', source: 'neutral-only' } } } })
    const result = (state as { result: { observation: { estimate: { value: number }; components: { user: number } } } }).result
    expect(result.observation.estimate.value).toBeGreaterThan(0)
    expect(result.observation.components.user).toBeGreaterThan(0)
  } finally { await server.close(); await service.close() }
})
