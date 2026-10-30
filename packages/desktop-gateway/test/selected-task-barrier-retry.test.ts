import { expect,it,vi } from 'vitest'
const fault=vi.hoisted(()=>({path:'',fail:false,hits:0}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return {...real,async open(...args:Parameters<typeof real.open>){const handle=await real.open(...args);if(String(args[0])===fault.path&&(args[1]==='r+'||args[1]==='wx')){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(fault.fail){fault.fail=false;fault.hits++;throw Error('header sync post-effect')}}}return handle}}})
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'
it('reconciles the same selected header after unknown publication without recapturing source',async()=>{
 const f=await createGatewayForkFixture({},undefined,true)
 try{
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-retry',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  const flush=vi.spyOn(f.coordinator,'flush');fault.path=join(f.sessions,'target.jsonl');fault.fail=true;fault.hits=0
  try{
   expect((await holder.captureFirst()).kind).toBe('captured');expect(fault.hits).toBe(1);const task=await readFile(join(f.sessions,'task-target.doc.jsonl')),header=await readFile(fault.path)
   flush.mockClear();expect((await holder.captureWarm()).kind).toBe('captured');expect(flush).not.toHaveBeenCalled();expect(await readFile(join(f.sessions,'task-target.doc.jsonl'))).toEqual(task);expect(await readFile(fault.path)).toEqual(header)
   expect((await holder.publishWarm()).kind).toBe('ready')
  }finally{fault.path='';fault.fail=false;flush.mockRestore();await holder.close()}
 }finally{await f.close()}
},30000)
