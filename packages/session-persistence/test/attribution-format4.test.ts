import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, createSession, contextUsageAnchorId, type ContextUsageCheckpointV2 } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, ownedContextReadiness, remapConversationSeed } from '../src/index.ts'
import { conversationIndexes } from '../../core-session/src/events/state.ts'
const roots: string[] = [], d = 'a'.repeat(64)
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function history() {
  const session = createSession()
  const request = { version: 1 as const, ownerSessionId: 's', observationLifetimeId: 'live', candidateId: 'A', sendId: 'send1', semanticId: d, payloadId: d, payloadKind: 'http-json-body' as const, executionEpochId: 'E', coldCompatible: false as const, snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 0 }
  append(session, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(session, { type: 'step/start', actionId: 'action', attemptId: 'attempt' })
  append(session, { type: 'assistant/message', text: 'answer' })
  append(session, { type: 'model/exchange-accepted', version: 2, request, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt', stepStartSeq: 1, assistantSeq: 2, callSeqs: [] })
  const facts = { version: 2 as const, accepted: { acceptedSeq: 3, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt' }, request, bindingId: d, shapeId: d, pricingVersion: 'projected-pricing-v2', normalizationVersion: 'input-usage-v1' as const, usageSemantics: 'includes-cache' as const, prefixId: d, unitCount: 1, heuristicPrefixTokens: 10, reportedInputTokens: 100 }
  const checkpoint: ContextUsageCheckpointV2 = { ...facts, anchorId: contextUsageAnchorId(facts) }
  return { session, sample: { type: 'context/usage' as const, version: 2 as const, op: 'sample' as const, checkpoint, seq: 4 } }
}
async function store(version = 3) {
  const root = await mkdtemp(join(tmpdir(), 'ih-r2b2-')); roots.push(root)
  const path = join(root, 's.jsonl'); await writeFile(path, JSON.stringify({ formatVersion: version, sessionId: 's', createdAt: 'fixture' }) + '\n')
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { maxDelayMs: 60000 })
  return { backend, coordinator, path }
}
it('makes backend3 durable4 before memory4 can append v2 and cold-loads exact lineage', async () => {
  const { backend, coordinator } = await store(), { session, sample } = history()
  const calls = vi.spyOn(backend, 'upgradeSessionFormat')
  await ownedContextReadiness(coordinator, 's', session)()
  expect((await backend.profile('s')).meta.formatVersion).toBe(4); expect(calls).toHaveBeenCalledTimes(1)
  await coordinator.append('s', session.events); await coordinator.append('s', [sample])
  const cold = (await coordinator.snapshot!('s')).session
  expect(cold.events[4]).toEqual(sample)
  expect((cold.events[4] as typeof sample).checkpoint.request.coldCompatible).toBe(false)
  await coordinator.close()
})
it('rereads accepted facts from each current durable prefix, after index creation', async () => {
  const { coordinator, path } = await store(4), { session, sample } = history()
  await coordinator.append('s', session.events)
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n'), accepted = JSON.parse(lines[4]!)
  accepted.request.sendId = 'mutated'; lines[4] = JSON.stringify(accepted); await writeFile(path, lines.join('\n') + '\n')
  await expect(coordinator.append('s', [sample])).rejects.toThrow(/conversation/)
  expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(5)
  await coordinator.close()
})
it('refuses unsupported or interrupted readiness before any v2 append', async () => {
  const { backend, coordinator, path } = await store(), raw = await readFile(path, 'utf8')
  backend.upgradeSessionFormat = undefined
  await expect(coordinator.ensureWritableFormat!('s')).rejects.toThrow(/cannot upgrade/)
  expect(await readFile(path, 'utf8')).toBe(raw)
  const s = createSession()
  await expect(ownedContextReadiness({ ...coordinator, ensureWritableFormat: undefined }, 's', s)()).rejects.toThrow(/must support/)
  await coordinator.close()
})
it('central seed drops all operational facts and inherited accepted receipts even without rewind', () => {
  const { session, sample } = history(); append(session, sample)
  const seed = remapConversationSeed({ source: session.events, retained: session.events, sourceFormat: 4 })
  expect(seed.some(e => e.type === 'context/usage')).toBe(false)
  const accepted = seed.find(e => e.type === 'model/exchange-accepted')
  expect(accepted?.version).toBe(1); expect(accepted).not.toHaveProperty('request')
  expect(JSON.stringify(seed)).not.toMatch(/send1|"E"|observationLifetimeId/)
})
it('rebuilds an already cached format3 Session index after its durable owner upgrades memory in place', async () => {
  const { backend, coordinator } = await store(3), prepared = history()
  const session = createSession(); session.formatVersion = 3
  for (const event of prepared.session.events.slice(0, 3)) append(session, event)
  const cached = conversationIndexes.get(session)!
  expect(cached.formatVersion).toBe(3)
  expect(cached.index.formatVersion).toBe(3)
  await backend.append('s', session.events)
  await ownedContextReadiness(coordinator, 's', session)()
  expect(session.formatVersion).toBe(4)
  expect((await backend.profile('s')).meta.formatVersion).toBe(4)
  expect(conversationIndexes.get(session)).toBe(cached)
  append(session, prepared.session.events[3]!)
  append(session, prepared.sample)
  expect(conversationIndexes.get(session)).not.toBe(cached)
  expect(conversationIndexes.get(session)?.index.formatVersion).toBe(4)
  await coordinator.append('s', session.events.slice(3))
  expect((await coordinator.snapshot!('s')).session.events).toEqual(session.events)
  await coordinator.close()
})
it('refuses undeclared DTO payloads before durable append and refuses an imported malformed DTO before repair', async () => {
  const { backend, coordinator, path } = await store(4), prepared = history()
  await coordinator.append('s', prepared.session.events)
  const event = structuredClone(prepared.sample)
  Object.defineProperty(event.checkpoint, 'constructor', { value: { payload: 'unexpected-private-payload' }, enumerable: true })
  const before = await readFile(path, 'utf8')
  await expect(coordinator.append('s', [event])).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(before)
  const imported = before + JSON.stringify(event) + '\n'
  await writeFile(path, imported)
  const repair = vi.spyOn(backend, 'repair')
  await expect(coordinator.snapshot!('s')).rejects.toThrow()
  await expect(coordinator.loadOwned('s')).rejects.toThrow()
  expect(repair).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(imported)
  await coordinator.close()
})
it('refuses durable step identity mutation when the current operation loads its acceptance prefix', async () => {
  const { coordinator, path } = await store(4), prepared = history()
  await coordinator.append('s', prepared.session.events)
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
  const start = JSON.parse(lines[2]!); start.actionId = 'mutated'; lines[2] = JSON.stringify(start)
  const changed = lines.join('\n') + '\n'; await writeFile(path, changed)
  await expect(coordinator.append('s', [prepared.sample])).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(changed)
  await coordinator.close()
})
