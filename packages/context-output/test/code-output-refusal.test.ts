import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createContextOutputService } from '../src/index.ts'
const state=vi.hoisted(()=>({root:'',lost:false,bodyOpens:0,bodyCloses:0}))
vi.mock('node:fs/promises',async original=>{
  const real=await original<typeof import('node:fs/promises')>()
  return {...real,async open(...args:Parameters<typeof real.open>){
    const handle=await real.open(...args),path=String(args[0])
    if(state.root&&path.startsWith(state.root)&&basename(path)==='body'){
      state.bodyOpens++
      const close=handle.close.bind(handle)
      handle.close=async()=>{state.bodyCloses++;await close();if(!state.lost){state.lost=true;throw false}}
    }
    return handle
  }}
})
it('retains the same serialized refusal owner after a falsey consumed body-close reply and never fabricates known cleanup',async()=>{
  const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'refusal-close-'))
  state.root=root
  const action=createNondurableFactOwner(createSession()).beginAction(),source=action.registerSettlementSource(async()=>{});action.finish()
  const service=createContextOutputService({root,workspaceId:'original'})
  const scope=service.registerResultScope({operationId:'original',sessionId:'s',callId:'c'},()=>{source.assertHeld();return true})
  try{
    const sink=await service.beginResult(scope,'code-output-manifest-v1')
    await sink.write(Buffer.from('original bytes'))
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'recovery-required',operationId:'original',cause:false})
    source.assertHeld();expect(state.bodyOpens).toBe(1)
    expect(await service.beginResult(scope,'code-output-manifest-v1')).toBe(sink)
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'refused',reason:'encoding'})
    const closed=state.bodyCloses
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'refused'})
    expect(state.bodyOpens).toBe(1);expect(state.bodyCloses).toBe(closed)
  }finally{state.root='';await source.close();await service.close()}
})
