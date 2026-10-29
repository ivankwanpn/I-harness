import { it,expect,vi } from 'vitest'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'
it('retains the original native source across first and warm and never accesses it in passive',async()=>{
 const f=await createGatewayForkFixture();try{
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}})
 const holder=f.runtime.createSelectedSourceHolder(operation),flush=vi.spyOn(f.coordinator,'flush');let source:unknown,reader:unknown,escaped!:()=>void
 await holder.first(async h=>{source=h.source;reader=h.source.inherited;escaped=h.assertCurrent;h.assertCurrent()});expect(flush).toHaveBeenCalledTimes(1);expect(()=>escaped()).toThrow('expired');await expect(holder.first(async()=>{})).rejects.toThrow();flush.mockClear()
 await holder.warm(async h=>{expect(h.source).toBe(source);expect(h.source.inherited).toBe(reader);h.assertCurrent()});await holder.passive(async h=>{expect('source' in h).toBe(false);expect(()=>h.assertCurrent()).toThrow()});expect(flush).not.toHaveBeenCalled();expect(()=>f.runtime.createSelectedSourceHolder(operation)).toThrow();await holder.close();flush.mockRestore()
 }finally{await f.close()}
})

