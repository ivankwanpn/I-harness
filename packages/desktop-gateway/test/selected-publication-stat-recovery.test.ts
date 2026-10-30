import {it,expect,vi} from 'vitest'
import {lstat,readFile,readdir} from 'node:fs/promises'
import {dirname,join,basename} from 'node:path'
import {selectedLegacyTransferFor} from '../../context-output/src/service.ts'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
const cut=vi.hoisted(()=>({name:'',path:''}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args);if(args[1]==='wx+'&&basename(String(args[0])).startsWith(cut.name+'.')&&String(args[0]).endsWith('.pending')){cut.path=String(args[0]);const stat=handle.stat.bind(handle);let first=true;handle.stat=(async(...args:Parameters<typeof stat>)=>{if(first&&cut.name){first=false;cut.name='';throw Error('Original publication first stat cut')}return stat(...args)}) as typeof handle.stat}return handle}}})
it.each([['binding.json','warm'],['binding.json','passive'],['applied.json','warm'],['applied.json','passive']] as const)('retains original %s through first stat failure for %s settlement',async(name,mode)=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'retained',complete:true,source});if(!ref)throw Error('Legacy source unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-passive-application',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)

  expect((await holder.captureFirst()).kind).toBe('captured');expect((await holder.confirmTarget()).kind).toBe('confirmed');cut.name=name;cut.path=''
  expect((await holder.confirmLegacyDependencies()).kind).toBe('blocked');expect(cut.name).toBe('');expect(cut.path).not.toBe('')
  const original=await lstat(cut.path,{bigint:true}),flush=vi.spyOn(f.coordinator,'flush'),owner=selectedLegacyTransferFor(f.runtime.contextOutput),reconcile=vi.spyOn(owner,'reconcile')
  if(mode==='warm')expect((await holder.confirmLegacyDependencies()).kind).toBe('confirmed')
  await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke')
  const sourceReads=vi.spyOn(f.runtime.observations,'current')
  const before=await readdir(dirname(cut.path)),outcome=await holder.reconcilePassive();expect(outcome.kind).toBe(mode==='warm'?'committed':'unknown');expect(flush).not.toHaveBeenCalled();expect(sourceReads.mock.calls.filter(([id])=>id==='source')).toHaveLength(0);expect(reconcile).toHaveBeenCalled()
  const final=join(dirname(cut.path),name),published=mode==='warm'||name==='binding.json',current=await lstat(published?final:cut.path,{bigint:true});expect(current.dev).toBe(original.dev);expect(current.ino).toBe(original.ino)
  if(mode==='passive'&&name==='applied.json'){expect(JSON.parse(await readFile(cut.path,'utf8'))).toMatchObject({version:2,kind:'legacy-fork-applied',observationCount:1,distinctRefCount:1});expect(JSON.parse(await readFile(join(dirname(dirname(dirname(cut.path))),'owners',ref.id+'.json'),'utf8'))).toEqual(['source']);await expect(lstat(final)).rejects.toMatchObject({code:'ENOENT'});expect(await readdir(dirname(cut.path))).toEqual(before)}
  if(mode==='passive'&&name==='binding.json'){await expect(lstat(join(dirname(final),'plan.json'))).rejects.toMatchObject({code:'ENOENT'})}
  sourceReads.mockRestore();flush.mockRestore();reconcile.mockRestore();await holder.close()
 }finally{cut.name='';await f.close()}
},90000)
