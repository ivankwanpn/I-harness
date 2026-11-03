import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { createSelectedResultsIntent, readSelectedResultsCore, readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'

async function selected(f: Awaited<ReturnType<typeof createGatewayForkFixture>>) {
 await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'})
 const operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'barrier',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}})
 return f.runtime.createSelectedSourceHolder(operation)
}
it('refuses selected header publication when a cold orphan task file exists',async()=>{
 const f=await createGatewayForkFixture({},undefined,true)
 try {
  const bytes='{"formatVersion":2,"tasks":[],"notifications":[]}\n'
  await writeFile(join(f.sessions,'task-target.doc.jsonl'),bytes)
  const holder=await selected(f)
  try { await expect(holder.captureFirst()).rejects.toThrow(); await expect(readFile(join(f.sessions,'target.jsonl'))).rejects.toMatchObject({code:'ENOENT'}); expect(await readFile(join(f.sessions,'task-target.doc.jsonl'),'utf8')).toBe(bytes) }
  finally { await holder.close() }
 } finally { await f.close() }
})
it('initializes the task document before a selected target header',async()=>{
 const f=await createGatewayForkFixture({},undefined,true)
 try {
  const holder=await selected(f)
  try { expect((await holder.captureFirst()).kind).toBe('captured'); expect(JSON.parse(await readFile(join(f.sessions,'task-target.doc.jsonl'),'utf8'))).toEqual({formatVersion:2,tasks:[],notifications:[]}); expect(JSON.parse((await readFile(join(f.sessions,'target.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14) }
  finally { await holder.close() }
 } finally { await f.close() }
})
it('retains the selected owner through publication after its task barrier',async()=>{
 const f=await createGatewayForkFixture({},undefined,true)
 try {
  const holder=await selected(f)
  try { expect((await holder.captureFirst()).kind).toBe('captured'); const result=await holder.publishWarm(); expect(result.kind).toBe('ready'); expect((await holder.publishWarm()).kind).toBe('ready'); expect((await f.coordinator.openManagedDocument('target')).assertReady()).toBeUndefined() }
  finally { await holder.close() }
 } finally { await f.close() }
},30000)
