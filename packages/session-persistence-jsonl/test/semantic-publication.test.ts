import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectConversation } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/index.ts'
import { literalReady, literalSeed } from '../../core-session/test/fixtures/format11-seed.ts'
import { createSessionCoordinator, compileSemanticSeed, type SessionCoordinator } from '@i-harness/session-persistence'

const roots: string[] = [], coordinators: SessionCoordinator[] = []

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(ready: boolean, completeLineage = false) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-publication-')); roots.push(root)
  const backend = createJsonlBackend(root), id = 'session', path = join(root, id + '.jsonl')
  if (ready) {
    // Use complete native birth so publication checks retain the original
    // stage, phase frames and completion manifest for this mutable target.
    const origin = literalSeed.origins[0]
    if (origin?.kind !== 'session') throw Error('Original literal source required')
    const seed = compileSemanticSeed({ kind: 'seed', seed: structuredClone(literalSeed), digest: literalReady.header!.semanticSeed!.seedDigest, sourceObservationDigest: origin.revision })
    expect(seed.records).toEqual(literalReady.events.slice(0, 2))
    const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }); coordinators.push(coordinator)
    const born = await coordinator.bootstrapSemanticTarget({
      invocation: { version: 1, operationId: 'literal', targetSessionId: id, createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
      target: { kind: 'new' }, metadata: { title: 'original' },
      lineage: completeLineage ? { origin: 'subagent', parentSession: 'parent', delegationDepth: 1, subagentProtocolVersion: 1 } : { origin: 'import' },
      seed,
    }, { assertCurrent() {}, dependencies: { async confirm() { throw Error('Literal has no external artifacts') }, async reconcile() { throw Error('Literal has no external artifacts') } } })
    expect(born.kind).toBe('ready')
  } else {
    await backend.create(id, { formatVersion: CURRENT_FORMAT_VERSION, sessionId: id, createdAt: '2026-10-23T00:00:00.000Z', title: 'original' })
  }
  const loaded = await backend.read(id)
  expect(projectConversation({ formatVersion: loaded.version, header: loaded.meta, events: loaded.events }).items).toHaveLength(ready ? 2 : 0)
  return { backend, id, path, loaded }
}
it.each(['append-orphan', 'append-extra', 'replace-orphan', 'replace-partial'])('refuses %s before changing any bytes', async kind => {
  const ready = kind === 'append-extra' || kind === 'replace-partial', { backend, id, path } = await fixture(ready)
  const before = await readFile(path)
  const operation = kind === 'append-orphan' ? () => backend.append(id, [structuredClone(literalReady.events[0]!)])
    : kind === 'append-extra' ? () => backend.append(id, [{ ...structuredClone(literalReady.events[1]!), seq: 3 }])
      : kind === 'replace-orphan' ? () => backend.replaceEvents!(id, [structuredClone(literalReady.events[0]!)])
        : () => backend.replaceEvents!(id, structuredClone(literalReady.events.slice(0, -1)))
  await expect(operation()).rejects.toThrow(/semantic seed|bootstrap-incomplete/)
  expect(await readFile(path)).toEqual(before)
  expect((await backend.read(id)).events).toHaveLength(ready ? 3 : 0)
})
it('keeps ready ordinary append and canonical whole-event replacement supported', async () => {
  const { backend, id } = await fixture(true)
  await backend.append(id, [{ type: 'user/message', text: 'local continuation' }])
  const loaded = await backend.read(id)
  expect(loaded.events.at(-1)).toMatchObject({ type: 'user/message', text: 'local continuation', seq: 3 })
  await backend.replaceEvents!(id, loaded.events)
  expect((await backend.read(id)).events).toEqual(loaded.events)
})
it.each(['seedDigest', 'remove', 'seedLength', 'parentSession', 'origin', 'delegationDepth', 'subagentProtocolVersion', 'sessionId', 'createdAt'])('protects reserved birth field %s before metadata publication', async key => {
  const { backend, id, path, loaded } = await fixture(true), before = await readFile(path)
  const patch = key === 'seedDigest' ? { semanticSeed: { ...loaded.meta!.semanticSeed!, seedDigest: '0'.repeat(64) } }
    : key === 'remove' ? { semanticSeed: undefined } : { [key]: key === 'seedLength' ? 3 : key === 'delegationDepth' || key === 'subagentProtocolVersion' ? 1 : 'changed' }
  await expect(backend.updateMeta(id, patch)).rejects.toThrow()
  expect(await readFile(path)).toEqual(before)
})
it('refuses reservation introduction on a plain target', async () => {
  const { backend, id, path } = await fixture(false), before = await readFile(path)
  await expect(backend.updateMeta(id, { seedLength: 2, semanticSeed: structuredClone(literalReady.header!.semanticSeed!) })).rejects.toThrow()
  expect(await readFile(path)).toEqual(before)
})
it.each(['parentSession','origin','delegationDepth','subagentProtocolVersion','createdAt'])('rejects removal of an existing reserved %s', async key => {
  const {backend,id,path,loaded} = await fixture(true, true)
  // These protected fields belong to the original stage from birth. Do not
  // retrofit different reserved lineage into an already committed stage.
  expect(loaded.meta).toMatchObject({parentSession:'parent',origin:'subagent',delegationDepth:1,subagentProtocolVersion:1})
  expect((await backend.read(id)).events).toEqual(loaded.events)
  const before = await readFile(path)
  await expect(backend.updateMeta(id,{[key]:undefined})).rejects.toThrow()
  expect(await readFile(path)).toEqual(before)
})
it.each(['slot', 'nested'])('rejects protected %s accessors without evaluating them', async kind => {
  const { backend, id, path, loaded } = await fixture(true), before = await readFile(path)
  let reads = 0
  const patch: any = kind === 'slot' ? {} : { semanticSeed: structuredClone(loaded.meta!.semanticSeed!) }
  Object.defineProperty(kind === 'slot' ? patch : patch.semanticSeed, kind === 'slot' ? 'semanticSeed' : 'seedDigest', { enumerable: true, get() { reads++; return kind === 'slot' ? loaded.meta!.semanticSeed : loaded.meta!.semanticSeed!.seedDigest } })
  await expect(backend.updateMeta(id, patch)).rejects.toThrow()
  expect(reads).toBe(0); expect(await readFile(path)).toEqual(before)
})
it('permits equivalent protected no-op and ordinary metadata edits while preserving a torn body', async () => {
  const { backend, id, path, loaded } = await fixture(true)
  const raw = await readFile(path, 'utf8'), body = raw.slice(raw.indexOf('\n') + 1) + '{"recordKind":"torn'
  await writeFile(path, raw.slice(0, raw.indexOf('\n') + 1) + body)
  await backend.updateMeta(id, { semanticSeed: structuredClone(loaded.meta!.semanticSeed!), seedLength: 2, sessionId: id, createdAt: loaded.meta!.createdAt, title: 'new title', archived: true, workspaceId: 'workspace', modelSelection: { provider: 'test', model: 'model' } })
  const after = await readFile(path, 'utf8')
  expect(after.slice(after.indexOf('\n') + 1)).toBe(body)
  const header = JSON.parse(after.slice(0, after.indexOf('\n')))
  expect(header).toMatchObject({ title: 'new title', archived: true, workspaceId: 'workspace', modelSelection: { provider: 'test', model: 'model' }, semanticSeed: loaded.meta!.semanticSeed })
})
it('refuses a computed title that mutates an already-checked reservation before publication',async()=>{
  const {backend,id,path,loaded}=await fixture(true),before=await readFile(path)
  const patch:any={semanticSeed:structuredClone(loaded.meta!.semanticSeed!)}
  let reads=0
  Object.defineProperty(patch,'title',{enumerable:true,get(){reads++;patch.semanticSeed.seedDigest='0'.repeat(64);return 'computed title'}})
  await expect(backend.updateMeta(id,patch)).rejects.toThrow()
  expect(reads).toBe(1);expect(await readFile(path)).toEqual(before)
  expect((await backend.read(id)).events).toEqual(loaded.events)
})
it('materializes an ordinary computed title once and returns detached protected metadata',async()=>{
  const {backend,id,path,loaded}=await fixture(true),before=await readFile(path,'utf8')
  const patch:any={semanticSeed:structuredClone(loaded.meta!.semanticSeed!)}
  let reads=0
  Object.defineProperty(patch,'title',{enumerable:true,get(){reads++;return 'computed title'}})
  const returned=await backend.updateMeta(id,patch)
  expect(reads).toBe(1);expect(returned.title).toBe('computed title')
  expect(returned.semanticSeed).not.toBe(patch.semanticSeed)
  patch.semanticSeed.seedDigest='0'.repeat(64)
  expect(returned.semanticSeed!.seedDigest).toBe(loaded.meta!.semanticSeed!.seedDigest)
  const after=await readFile(path,'utf8');expect(after.slice(after.indexOf('\n')+1)).toBe(before.slice(before.indexOf('\n')+1))
  expect((await backend.read(id)).meta!.semanticSeed).toEqual(loaded.meta!.semanticSeed)
})
it.each(['nested','whole-drop'])('binds the final header despite %s serialization callbacks',async kind=>{
  const {backend,id,path,loaded}=await fixture(true),before=await readFile(path)
  const patch:any={semanticSeed:structuredClone(loaded.meta!.semanticSeed!)}
  let calls=0
  if(kind==='nested') patch.modelSelection={toJSON(){calls++;patch.semanticSeed.seedDigest='0'.repeat(64);return {provider:'test',model:'model'}}}
  else patch.toJSON=function(){calls++;const value={...this};delete value.semanticSeed;return value}
  // Serialize the ordinary callback before semanticSeed so its mutation is
  // actually present in the final bytes, not merely in a discarded alias.
  if(kind==='nested') {
    patch.toJSON=function(){return {modelSelection:this.modelSelection,...this}}
  }
  await expect(backend.updateMeta(id,patch)).rejects.toThrow()
  expect(calls).toBe(1);expect(await readFile(path)).toEqual(before)
})
