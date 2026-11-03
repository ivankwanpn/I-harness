import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createToolRegistryWithModelOrigin } from '../src/model-origin.ts'

it('attaches only an original prepared member of its paired registry once', async () => {
  const ctx=createContext(), view=createSession(), factOwner=createNondurableFactOwner(view), action=factOwner.beginAction()
  const source=action.registerSettlementSource(async()=>{}), proof=Object.freeze({}), seen: unknown[]=[]
  const verifier={take(p: object, expected: any){expect(p).toBe(proof);seen.push(expected);return {assertCurrent(){}}}}
  const options={executionOwner:{view,factOwner,context:ctx}}
  const pair=createToolRegistryWithModelOrigin(ctx,options,verifier), other=createToolRegistryWithModelOrigin(ctx,options,verifier)
  for (const {registry} of [pair,other]) registry.register({name:'shell',description:'',inputSchema:{},execute:async()=> 'ok'})
  const prepared=await pair.registry.prepare({name:'shell',args:{x:1}},action.signal,{session:view,callId:'c',callEventSeq:1,settlementSource:source})
  expect(()=>other.driver.attach(prepared,proof)).toThrow()
  const attach=pair.driver.attach
  expect(()=>attach(prepared,proof)).toThrow()
  pair.driver.attach(prepared,proof)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({registry:pair.registry,prepared,view,source,callId:'c',callEventSeq:1,name:'shell',args:{x:1}})
  expect(()=>pair.driver.attach(prepared,proof)).toThrow()
  await source.close();action.finish();await ctx.scope.unmount()
})

it('rechecks the permit at entry and refuses reentry', async () => {
  const ctx=createContext(),view=createSession(),factOwner=createNondurableFactOwner(view),action=factOwner.beginAction(),source=action.registerSettlementSource(async()=>{})
  let current=true, bodies=0
  const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{view,factOwner,context:ctx}},{take(){return {assertCurrent(){if(!current)throw new Error('expired')}}}})
  pair.registry.register({name:'shell',description:'',inputSchema:{},execute:async()=>{bodies++;return 'ok'}})
  const make=()=>pair.registry.prepare({name:'shell',args:{}},action.signal,{session:view,callId:'c',callEventSeq:1,settlementSource:source})
  const first=await make(); pair.driver.attach(first,{}); current=false
  await expect(pair.registry.dispatch(first)).rejects.toThrow('expired'); expect(bodies).toBe(0)
  current=true; const second=await make(); pair.driver.attach(second,{})
  expect(await pair.registry.dispatch(second)).toBe('ok')
  await expect(pair.registry.dispatch(second)).rejects.toThrow(); expect(bodies).toBe(1)
  await source.close();action.finish();await ctx.scope.unmount()
})
