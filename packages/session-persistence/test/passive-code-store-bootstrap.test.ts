import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportConversationSeed, type SessionEvent } from '@i-harness/core-session'
import { semanticSeedFromRecords } from '@i-harness/core-session/internal/bootstrap'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, compileSemanticSeed, readForkRequestCore, createBootstrapRequestIntent, type SessionCoordinator, type BootstrapGuards, type BootstrapRequest, type ManagedDocument } from '../src/index.ts'
import { createContext } from '../../core-plugin/src/index.ts'
import { createToolRegistry } from '../../core-tools/src/index.ts'
import { registerCodeMode } from '../../code-mode/src/register.ts'

const roots: string[] = [], coordinators: SessionCoordinator[] = []
afterEach(async () => { for (const coordinator of coordinators.splice(0)) await coordinator.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const guards: BootstrapGuards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('No artifacts') }, async reconcile() { throw Error('No artifacts') } } }
async function setup(root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'ih-passive-b2-')); roots.push(root) }
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }); coordinators.push(coordinator)
  return { root, backend, coordinator }
}
function captureRequest(sourceSessionId = 'source', targetSessionId = 'target') {
  const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId, selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
  const intent = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  return { invocation: { version: 1 as const, operationId: 'passive-' + targetSessionId, targetSessionId, createdAt: '2026-10-27T00:00:00.000Z', requestDigest: intent.requestDigest }, core, requestIntent: intent.intent }
}
function payload(document: ManagedDocument, sourceSessionId = 'source', targetSessionId = 'target'): BootstrapRequest {
  const view = document.view, events = view.events, count = events.length
  const owner = { kind: 'held-public-fork' as const, sourceSessionId, view, factOwner: document, assertCurrent() {
    document.assertReady(); if (document.view !== view || view.events !== events || events.length !== count) throw Error('Source changed')
  } }
  const exported = exportConversationSeed(view, { kind: 'session', sessionId: sourceSessionId }, { kind: 'completed' }, { kind: 'public-completed-passive', owner })
  if (exported.kind !== 'seed') throw Error(JSON.stringify(exported))
  return { invocation: captureRequest(sourceSessionId, targetSessionId).invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: sourceSessionId }, seed: compileSemanticSeed(exported) }
}
async function source(coordinator: SessionCoordinator) {
  await coordinator.create({ sessionId: 'source' })
  await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'one' },
    { type: 'code/store', version: 1, cellId: 'c', sessionId: 'source', writes: [['x', { z: 7, a: 1 }]] },
    { type: 'code/cell', cellId: 'c', sessionId: 'source', state: 'completed' }, { type: 'turn/end' }])
  return coordinator.openManagedDocument('source')
}
it('publishes V2 through original B2 once, cold resumes original bytes and keeps header/stage/frame layout', async () => {
  const { coordinator, root } = await setup(), document = await source(coordinator), request = captureRequest(); let captures = 0
  const outcome = await coordinator.bootstrapSemanticTargetWithCapture!(request, guards, async () => { captures++; return payload(document) })
  expect(outcome.kind).toBe('ready'); expect(captures).toBe(1)
  const before = await readFile(join(root, 'target.jsonl')), names = await readdir(root), stageName = names.find(name => name.startsWith('target.jsonl.bootstrap-') && name.endsWith('.stage'))!
  const stage = await readFile(join(root, stageName)), lines = before.toString().trimEnd().split('\n').map(line => JSON.parse(line)), header = lines[0]
  expect(header.formatVersion).toBe(13); expect(header.semanticSeed).toMatchObject({ version: 2, codec: 'semantic-seed-v2', seedLength: 2, groupCount: 1 })
  expect(Buffer.byteLength(JSON.stringify(header))).toBeLessThanOrEqual(65536); expect(stage.length).toBeLessThanOrEqual(262144)
  expect(JSON.parse(stage.toString())).toMatchObject({ version: 1, kind: 'semantic-bootstrap-header' })
  expect(lines.slice(1).map(line => line.batchId)).toEqual(['bootstrap:passive-target:seed', 'bootstrap:passive-target:complete'])
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(request, guards, async () => { captures++; throw Error('Reentry') })).kind).toBe('already-ready')
  expect(captures).toBe(1); expect(await readFile(join(root, 'target.jsonl'))).toEqual(before)
  await coordinator.close(); coordinators.splice(coordinators.indexOf(coordinator), 1)
  const cold = await setup(root)
  const resumed = await cold.coordinator.resumeSemanticTarget(request.invocation, { ...guards, assertCurrent() { throw Error('Source unavailable') } })
  expect(resumed.kind).toBe('already-ready')
  if (resumed.kind !== 'already-ready') throw Error(JSON.stringify(resumed))
  const seed = semanticSeedFromRecords(resumed.document.view.header!.semanticSeed!, resumed.document.view.events)
  expect(seed.version).toBe(2)
  if (seed.version !== 2) throw Error('V2 required')
  expect(seed.passive.codeStore.values).toEqual([{ valueJson: '{"z":7,"a":1}' }])
  expect(await readFile(join(root, stageName))).toEqual(stage); expect(await readFile(join(root, 'target.jsonl'))).toEqual(before)
})
it('rejects corrupt persisted V2 codec or body before a cold document becomes ready', async () => {
  for (const field of ['codec', 'body']) {
    const { coordinator, root } = await setup(), document = await source(coordinator)
    expect((await coordinator.bootstrapSemanticTarget(payload(document), guards)).kind).toBe('ready')
    await coordinator.close(); coordinators.splice(coordinators.indexOf(coordinator), 1)
    const path = join(root, 'target.jsonl'), before = await readFile(path, 'utf8')
    const changed = field === 'codec' ? before.replace('semantic-seed-v2', 'semantic-seed-v3') : before.replace('valueJson', 'valueJsox')
    expect(changed).not.toBe(before); await writeFile(path, changed)
    const cold = await setup(root)
    await expect(cold.coordinator.openManagedDocument('target')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(changed)
  }
})
it('admits genuine loadOwned positional views and preserves append seq assignment', async () => {
  const { coordinator, root } = await setup()
  for (const id of ['missing', 'nonpositional']) {
    const events: SessionEvent[] = [{ type: 'user/message', text: 'legacy', ...(id === 'nonpositional' ? { seq: 9 } : {}) }]
    const body = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    await writeFile(join(root, id + '.jsonl'), JSON.stringify({ formatVersion: 5, sessionId: id, createdAt: 'original' }) + '\n' + body.toString())
  }
  const document = await coordinator.openManagedDocument('missing')
  expect(document.view.events.map(event => event.seq)).toEqual([0])
  const action = document.beginAction()
  try { expect((await action.facts.agent.lifecycle({ type: 'turn/start' })).kind).toBe('committed') } finally { action.finish() }
  expect(document.view.events.map(event => event.seq)).toEqual([0, 1])
  await expect(coordinator.openManagedDocument('nonpositional')).rejects.toThrow('sequence invariant')
  expect(JSON.parse((await readFile(join(root, 'missing.jsonl'), 'utf8')).split('\n')[1]!).seq).toBe(0)
})
it('restores actual same-owner B2 x7, commits x8, cold recaptures x8 and excludes source globals', async () => {
  const { coordinator, root } = await setup(), document = await source(coordinator)
  const mount = (document: ManagedDocument, id: string) => {
    const context = createContext(), tools = createToolRegistry(context)
    return { tools, code: registerCodeMode(context, tools, { session: document.view, factOwner: document, sessionId: id, config: { mode: 'only' } }) }
  }
  const run = async (mounted: ReturnType<typeof mount>, code: string) => (await mounted.tools.execute({ name: 'code_exec', args: { code } })).output
  const original = mount(document, 'source')
  try { expect(await run(original, 'store("x",7);globalThis.secret=99;')).toMatchObject({ status: 'completed' }) } finally { await original.code.dispose() }
  const child = await coordinator.bootstrapSemanticTarget(payload(document), guards)
  if (child.kind !== 'ready') throw Error(JSON.stringify(child))
  expect(child.document.view.events.every(event => !event.type.startsWith('code/') && !event.type.startsWith('agent/delivery-'))).toBe(true)
  let current = mount(child.document, 'target')
  try { expect(await run(current, 'text(load("x"));text(typeof secret);store("x",8);')).toMatchObject({ status: 'completed', text: '7\nundefined' }) } finally { await current.code.dispose() }
  await coordinator.close(); coordinators.splice(coordinators.indexOf(coordinator), 1)
  const cold = await setup(root), restored = await cold.coordinator.openManagedDocument('target')
  current = mount(restored, 'target')
  try { expect(await run(current, 'text(load("x"));text(typeof secret);')).toMatchObject({ status: 'completed', text: '8\nundefined' }) } finally { await current.code.dispose() }
  const grandchild = await cold.coordinator.bootstrapSemanticTarget(payload(restored, 'target', 'grandchild'), guards)
  if (grandchild.kind !== 'ready') throw Error(JSON.stringify(grandchild))
  expect(grandchild.document.view.events.every(event => !event.type.startsWith('code/'))).toBe(true)
  const next = mount(grandchild.document, 'grandchild')
  try { expect(await run(next, 'text(load("x"));text(typeof secret);')).toMatchObject({ status: 'completed', text: '8\nundefined' }) } finally { await next.code.dispose() }
  const unchanged = mount(await cold.coordinator.openManagedDocument('source'), 'source')
  try { expect(await run(unchanged, 'text(load("x"));text(typeof secret);')).toMatchObject({ status: 'completed', text: '7\nundefined' }) } finally { await unchanged.code.dispose() }
})
it('uses actual target configured/default quotas on complete loaded V2 entry bytes including Unicode and escaping', async () => {
  const max = 4 * 1024 * 1024, overhead = Buffer.byteLength(JSON.stringify([['x', '']])), chunk = 'é"\\', width = Buffer.byteLength(JSON.stringify(chunk)) - 2
  const valueAt = (bytes: number) => chunk.repeat(Math.floor((bytes - overhead) / width)) + 'a'.repeat((bytes - overhead) % width)
  for (const example of [{ bytes: 64, limit: 63, accepted: false }, { bytes: 1024 * 1024 + 1, limit: undefined, accepted: false }, { bytes: max, limit: max, accepted: true }, { bytes: max + 1, limit: max, accepted: false }]) {
    const { coordinator } = await setup(), value = valueAt(example.bytes)
    expect(Buffer.byteLength(JSON.stringify([['x', value]]))).toBe(example.bytes)
    await coordinator.create({ sessionId: 'source' }); await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'one' }, { type: 'code/store', version: 1, cellId: 'c', sessionId: 'source', writes: [['x', value]] }, { type: 'code/cell', cellId: 'c', sessionId: 'source', state: 'completed' }, { type: 'turn/end' }])
    const target = await coordinator.bootstrapSemanticTarget(payload(await coordinator.openManagedDocument('source')), guards)
    if (target.kind !== 'ready') throw Error(JSON.stringify(target))
    const context = createContext(), tools = createToolRegistry(context), code = registerCodeMode(context, tools, { session: target.document.view, factOwner: target.document, sessionId: 'target', config: { mode: 'only', maxStoreBytes: example.limit } })
    try {
      const execution = tools.get('code_exec')!.execute({ code: 'text(load("x").length);' }, { sessionId: 'target' })
      if (example.accepted) expect(await execution).toMatchObject({ status: 'completed', text: String(value.length) })
      else await expect(execution).rejects.toThrow('Session store transfer limit exceeded')
    } finally { await code.dispose() }
  }
}, 30000)
it('captures overflow exposed by removing a reducing completion and restores exact fault or later independent ordinary cut', async () => {
  const { coordinator } = await setup(), huge = 'a'.repeat(2_100_000)
  await coordinator.create({ sessionId: 'source' })
  // Explicit persisted concurrent history qualifies the capture fold. These
  // facts do not claim a runtime can commit new writes against a fault base.
  await coordinator.append('source', [
    { type: 'turn/start' }, { type: 'user/message', text: 'one' },
    { type: 'code/store', version: 1, cellId: 'a', sessionId: 'source', writes: [['x', huge]] }, { type: 'code/cell', cellId: 'a', sessionId: 'source', state: 'completed' },
    { type: 'code/store', version: 1, cellId: 'b', sessionId: 'source', writes: [['x', 0]] },
    { type: 'code/store', version: 1, cellId: 'c', sessionId: 'source', writes: [['y', huge]] }, { type: 'code/cell', cellId: 'c', sessionId: 'source', state: 'completed' },
    { type: 'code/cell', cellId: 'b', sessionId: 'source', state: 'completed' }, { type: 'turn/end' },
    { type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq: 7, mode: 'conversation', fileOps: [] },
    { type: 'turn/start' }, { type: 'user/message', text: 'two' },
    { type: 'code/store', version: 1, cellId: 'd', sessionId: 'source', writes: [['y', 0]] }, { type: 'code/cell', cellId: 'd', sessionId: 'source', state: 'completed' }, { type: 'turn/end' },
  ])
  const request = payload(await coordinator.openManagedDocument('source')), target = await coordinator.bootstrapSemanticTarget(request, guards)
  if (target.kind !== 'ready') throw Error(JSON.stringify(target))
  const seed = semanticSeedFromRecords(target.document.view.header!.semanticSeed!, target.document.view.events)
  if (seed.version !== 2) throw Error('V2 required')
  expect(seed.passive.codeStore.cuts[seed.passive.codeStore.groups[1]!]!.overLimit).toBe(true)
  expect(seed.passive.codeStore.cuts[seed.passive.codeStore.latest]!.overLimit).toBeUndefined()
  const context = createContext(), tools = createToolRegistry(context), code = registerCodeMode(context, tools, { session: target.document.view, factOwner: target.document, sessionId: 'target', config: { mode: 'only', maxStoreBytes: 4 * 1024 * 1024 } })
  const run = (code: string) => tools.get('code_exec')!.execute({ code }, { sessionId: 'target' })
  const rewind = async (anchorSeq: number) => { const action = target.document.beginAction(); try { expect((await action.facts.compaction.commit([{ type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq, mode: 'conversation', fileOps: [] }])).kind).toBe('committed') } finally { action.finish() } }
  try {
    expect(await run('text(load("x").length);text(load("y"));')).toMatchObject({ status: 'completed', text: '2100000\n0' })
    await rewind(2)
    await expect(run('store("x",0);')).rejects.toThrow('Session store transfer limit exceeded')
    await rewind(1)
    expect(await run('text(typeof load("x"));text(typeof load("y"));')).toMatchObject({ status: 'completed', text: 'undefined\nundefined' })
  } finally { await code.dispose() }
}, 30000)

export { setup, payload, captureRequest, guards }
