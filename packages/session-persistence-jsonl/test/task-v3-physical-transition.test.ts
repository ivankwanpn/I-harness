import { expect, it, vi } from 'vitest'
const effects=vi.hoisted(()=>({repair:0,append:0,replaceEvents:0,upgradeSessionFormat:0,task:0,header:0,upgrade:0}))
vi.mock('../../session-persistence/src/coordinator/load.ts',async original=>{
 const real=await original<typeof import('../../session-persistence/src/coordinator/load.ts')>()
 return {...real,createLoads(...args:Parameters<typeof real.createLoads>){const original=args[0],port={...original};for(const key of ['repair','append','replaceEvents','upgradeSessionFormat'] as const){const method=original[key];if(method)Object.defineProperty(port,key,{value:(...input:unknown[])=>{effects[key]++;return Reflect.apply(method,original,input)}})}args[0]=port;return real.createLoads(...args)}}
})
vi.mock('../src/backend/document-write.ts',async original=>{const real=await original<typeof import('../src/backend/document-write.ts')>();return {...real,createOwnedDocumentWrite(...args:Parameters<typeof real.createOwnedDocumentWrite>){effects.task++;return real.createOwnedDocumentWrite(...args)}}})
vi.mock('../src/backend/format-upgrade.ts',async original=>{const real=await original<typeof import('../src/backend/format-upgrade.ts')>();return {...real,async stageOwnedUpgrade(...args:Parameters<typeof real.stageOwnedUpgrade>){effects.upgrade++;return real.stageOwnedUpgrade(...args)}}})
vi.mock('../src/backend/session-io.ts',async original=>{const real=await original<typeof import('../src/backend/session-io.ts')>();return {...real,stageOwnedSessionFile(...args:Parameters<typeof real.stageOwnedSessionFile>){effects.header++;return real.stageOwnedSessionFile(...args)}}})
function resetEffects(){for(const key of Object.keys(effects) as (keyof typeof effects)[])effects[key]=0}
function expectNoEffects(){expect(effects).toEqual({repair:0,append:0,replaceEvents:0,upgradeSessionFormat:0,task:0,header:0,upgrade:0})}
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'

it('refuses a physical 13 with task 3 before repairing its torn tail', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-physical-'))
  const path = join(root, 'p.jsonl'), task = join(root, 'task-p.doc.jsonl')
  await copyFile(join(import.meta.dirname, 'fixtures/original13-empty.jsonl'), path)
  await appendFile(path, '{"torn":')
  const literal = '{"formatVersion":3,"tasks":[],"notifications":[]}\n'
  await writeFile(task, literal)
  const before = await readFile(path), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    resetEffects()
    await expect(coordinator.loadOwned('p')).rejects.toThrow()
    expectNoEffects()
    expect(await readFile(path)).toEqual(before)
    expect(await readFile(task, 'utf8')).toBe(literal)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('loads physical 14 with valid task 3 without rewriting its task bytes', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'v3-physical14-'))
  const backend = createJsonlBackend(root), task = join(root, 'task-p.doc.jsonl')
  await backend.create('p', {sessionId:'p',formatVersion:14,createdAt:'x'})
  const literal = '{ "formatVersion": 3, "tasks": [], "notifications": [] }\n'
  await writeFile(task, literal)
  const coordinator = createJsonlTaskTransitionCoordinator(root, {lock:{enabled:true}}, taskDocumentStorageContract)
  try {
    const result = await coordinator.loadOwned('p')
    expect(result.session.formatVersion).toBe(14)
    expect(await readFile(task,'utf8')).toBe(literal)
  } finally { await coordinator.close(); await rm(root,{recursive:true,force:true}) }
})

it.each(['bootstrap13-public','empty13-target'])('refuses physical13 task3 on original %s bootstrap before effects',async population=>{
 const {readdir}=await import('node:fs/promises'),{createHash}=await import('node:crypto'),{EMPTY_SEMANTIC_SEED_DIGEST,EMPTY_SEMANTIC_DEPENDENCY_DIGEST,legacyPrefixDigest}=await import('@i-harness/core-session')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'v3-bootstrap-'))
 for(const name of await readdir(join(import.meta.dirname,'fixtures',population)))await copyFile(join(import.meta.dirname,'fixtures',population,name),join(root,name))
 const path=join(root,'target.jsonl'),task=join(root,'task-target.doc.jsonl'),before=await readFile(path),literal='{"formatVersion":3,"tasks":[],"notifications":[]}\n';await writeFile(task,literal)
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),invocation={version:1 as const,operationId:population==='bootstrap13-public'?'public':'op',targetSessionId:'target',createdAt:'2026-10-23T00:00:00.000Z',requestDigest:'a'.repeat(64)},guards={assertCurrent(){},dependencies:{async confirm(){throw Error('unused')},async reconcile(){throw Error('unused')}}}
 try{
  resetEffects()
  const result=await Promise.allSettled([population==='bootstrap13-public'?coordinator.resumeSemanticTarget(invocation,guards):coordinator.bootstrapSemanticTarget({invocation,target:{kind:'existing-empty',expectedHeaderDigest:createHash('sha256').update(before).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}},metadata:{},lineage:{origin:'fork',parentSession:'parent'},seed:{digest:EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none'},records:[]}},guards)])
  expect(result[0]).toMatchObject({status:'fulfilled',value:{kind:'blocked'}});expectNoEffects();expect(await readFile(path)).toEqual(before);expect(await readFile(task,'utf8')).toBe(literal)
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
