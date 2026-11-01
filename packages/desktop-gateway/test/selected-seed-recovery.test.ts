import {it,expect,vi} from 'vitest'
const fault=vi.hoisted(()=>({sync:false}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args);if(typeof args[0]!=='string'||!args[0].endsWith('target.jsonl')||args[1]!=='r+')return handle;return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{if(fault.sync){fault.sync=false;throw Error('selected seed sync cut')}return target.sync()};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}}})
import {join} from 'node:path'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
import {readBootstrapFactJournal} from '@i-harness/core-session/internal/bootstrap'
it('passively reconciles only the original uncertain seed after source revoke',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-seed-cut',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation),captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Capture unavailable')
  fault.sync=true;expect((await holder.publishWarm()).kind).toBe('blocked');expect(fault.sync).toBe(false)
  const {readFile}=await import('node:fs/promises'),path=join(f.sessions,'target.jsonl'),before=await readFile(path),meta=JSON.parse(captured.headerBytes),decoded=readBootstrapFactJournal(before.subarray(Buffer.byteLength(captured.headerBytes)),meta.journal,meta.formatVersion,meta);expect(decoded.frames).toHaveLength(1)
  await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke');const flush=vi.spyOn(f.coordinator,'flush');expect((await holder.reconcilePassive()).kind).toBe('committed');expect(flush).not.toHaveBeenCalled();expect(await readFile(path)).toEqual(before);await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow();flush.mockRestore();await holder.close()
 }finally{fault.sync=false;await f.close()}
},60000)
