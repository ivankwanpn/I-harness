import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, createSession, deriveMessages, type SessionEvent } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { captureContextSnapshot } from '../../context-engine/src/index.ts'
import { createSessionCoordinator, ownedContextReadiness, remapConversationSeed, forkSession } from '../src/index.ts'
const roots: string[] = [], d = 'a'.repeat(64)
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const native = { kind: 'bedrock', model: 'fixture', reasoningBlocks: [{ reasoningText: { text: 'plan' } }], contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'answer' }], producerWitness: { version: 1, messagesPrefixId: d, inputSurfaceId: d, callsId: d, callCount: 0 } } as const
function history() {
  const session = createSession()
  for (const event of [{ type: 'turn/start' }, { type: 'user/message', text: 'go' }, { type: 'assistant/message', text: 'answer', providerContinuation: structuredClone(native) }, { type: 'turn/end' }] as unknown as SessionEvent[]) append(session, event)
  return session
}
it('preserves the carrier through seed, snapshot, cold load and actual fork', async () => {
  const session = history()
  const seed = remapConversationSeed({ source: session.events, retained: session.events, sourceFormat: 5 })
  expect(seed[2]).toMatchObject({ providerContinuation: native })
  const captured = captureContextSnapshot(session, { ownerSessionId: 's', surface: { systemPrompt: '', tools: [] } })
  if (captured.kind !== 'captured') throw Error('snapshot required')
  expect(JSON.stringify(captured.snapshot)).toContain(d)
  const root = await mkdtemp(join(tmpdir(), 'ih-native5-')); roots.push(root)
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' }); await coordinator.append('s', session.events)
  expect((await coordinator.snapshot!('s')).session.events[2]).toMatchObject({ providerContinuation: native })
  const child = await forkSession(coordinator, 's')
  const cold = (await coordinator.snapshot!(child.sessionId)).session
  expect(deriveMessages(cold).find(message => message.role === 'assistant')).toMatchObject({ providerContinuation: native })
  await coordinator.close()
})
it.each([1, 2, 3, 4])('reads historical format%s without retrospective proof, then establishes owned durable6 before new native append', async version => {
  const root = await mkdtemp(join(tmpdir(), 'ih-native5-old-')); roots.push(root)
  const path = join(root, 's.jsonl'), body = '{ "type":"user/message", "text":"old", "seq":0 }\n'
  await writeFile(path, JSON.stringify({ formatVersion: version, sessionId: 's', createdAt: 'x' }) + '\n' + body)
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const session = (await coordinator.snapshot!('s')).session
  expect(JSON.stringify(session.events)).not.toContain('producerWitness')
  const document = await coordinator.openManagedDocument('s')
  await ownedContextReadiness(coordinator, 's', document.view)()
  expect((await backend.profile('s')).meta.formatVersion).toBe(6)
  expect((await readFile(path, 'utf8')).split('\n').slice(1).join('\n')).toBe(body)
  const event = history().events[2]!
  if (event.type !== 'assistant/message') throw new Error('Expected assistant fixture')
  expect((await document.agent.auditAssistant(event)).kind).toBe('committed')
  expect((await coordinator.snapshot!('s')).session.events.at(-1)).toMatchObject({ providerContinuation: native })
  await coordinator.close()
})
it('refuses malformed nested metadata before writer mutation and before tail repair on cold load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-native5-bad-')); roots.push(root)
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: 's' })
  const path = join(root, 's.jsonl'), before = await readFile(path, 'utf8')
  const event = { type: 'assistant/message', text: 'answer', providerContinuation: { ...structuredClone(native), producerWitness: { ...native.producerWitness, version: 2 } }, seq: 0 } as unknown as SessionEvent
  await expect(coordinator.append('s', [event])).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(before)
  await writeFile(path, before + JSON.stringify(event) + '\n{"torn":')
  const repair = vi.spyOn(backend, 'repair')
  await expect(coordinator.loadOwned('s')).rejects.toThrow()
  expect(repair).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(before + JSON.stringify(event) + '\n{"torn":')
  await coordinator.close()
})
