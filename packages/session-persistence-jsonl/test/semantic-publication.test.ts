import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectConversation } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/index.ts'
import { literalReady } from '../../core-session/test/fixtures/format11-seed.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(ready: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-publication-')); roots.push(root)
  const backend = createJsonlBackend(root), id = 'session', path = join(root, id + '.jsonl')
  await backend.create(id, { formatVersion: CURRENT_FORMAT_VERSION, sessionId: id, createdAt: '2026-10-23T00:00:00.000Z', title: 'original', ...(ready ? structuredClone(literalReady.header) : {}) })
  if (ready) await backend.replaceEvents!(id, structuredClone(literalReady.events))
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
  const {backend,id,path,loaded} = await fixture(true)
  // Provision complete supported birth metadata before the public update;
  // the target still has the same validated literal seed and body.
  const beforeText = await readFile(path,'utf8'), end = beforeText.indexOf('\n')
  const header = {...JSON.parse(beforeText.slice(0,end)),parentSession:'parent',origin:'subagent',delegationDepth:1,subagentProtocolVersion:1}
  await writeFile(path,JSON.stringify(header)+beforeText.slice(end))
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
