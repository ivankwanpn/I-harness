import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createArtifactWriter } from '../src/artifact/writer.ts'
import type { ArtifactOperation } from '../src/artifact/types.ts'
import { createContextOutputService } from '../src/index.ts'
import { createNondurableFactOwner, createSession } from '@i-harness/core-session'
const state=vi.hoisted(()=>({root:'',faults:new Map<string,unknown>(),gates:new Map<string,Promise<void>>(),entered:new Map<string,()=>void>(),calls:new Map<string,number>(),opens:0}))
vi.mock('node:fs/promises',async original=>{
  const real=await original<typeof import('node:fs/promises')>()
  return {...real,async open(...args:Parameters<typeof real.open>){
    const handle=await real.open(...args),path=String(args[0]),name=basename(path)
    if(state.root&&path.startsWith(state.root)&&args[1]==='wx+'&&['body','leaves'].includes(name)){
      state.opens++
      const close=handle.close.bind(handle)
      handle.close=async()=>{
        state.calls.set(name,(state.calls.get(name)??0)+1)
        state.entered.get(name)?.()
        await state.gates.get(name)
        await close()
        if(state.faults.has(name))throw state.faults.get(name)
      }
    }
    return handle
  }}
})
async function setup(faults:Map<string,unknown>) {
  state.root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'refusal-close-'))
  state.faults=faults;state.gates.clear();state.entered.clear();state.calls.clear();state.opens=0
  const closed=vi.fn(),cancel=vi.fn(async()=>{})
  const operation:ArtifactOperation={version:1,id:'original',owner:{operationId:'original',sessionId:'s',callId:'c'},codec:'code-output-manifest-v1',phase:'capturing',encodedBytes:0}
  const sink=await createArtifactWriter({directory:state.root,operation,async mutate(work){return work()},async reserve(){},lifetime:()=> 'current',recoveryAllowed:()=>true,cancelPublication:cancel,closed})
  await sink.write(Buffer.from('original bytes'))
  return {sink,closed,cancel}
}
it('keeps a lost consuming close reply unknown and attempts its independent sibling exactly once',async()=>{
  const {sink,closed,cancel}=await setup(new Map([['body',false]]))
  try{
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'recovery-required',operationId:'original',cause:false})
    expect(state.calls.get('body')).toBe(1);expect(state.calls.get('leaves')).toBe(1)
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'recovery-required',cause:false})
    expect(await sink.finish('complete')).toMatchObject({kind:'recovery-required',cause:false})
    await expect(sink.suspend()).rejects.toBe(false)
    expect(state.calls.get('body')).toBe(1);expect(state.calls.get('leaves')).toBe(1)
    expect(state.opens).toBe(2);expect(closed).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled()
  }finally{state.root=''}
})
it('retains both original falsey cleanup failures while refusing repeated numeric-handle cleanup',async()=>{
  const {sink,closed}=await setup(new Map<string,unknown>([['body',false],['leaves',undefined]]))
  try{
    const first=await sink.refuse!('capture-canceled')
    expect(first.kind).toBe('recovery-required')
    if(first.kind!=='recovery-required')throw new Error('Expected original cleanup debt')
    expect(first.cause).toBeInstanceOf(AggregateError);expect((first.cause as AggregateError).errors).toEqual([false,undefined])
    const again=await sink.refuse!('capture-canceled')
    expect(again).toMatchObject({kind:'recovery-required',cause:first.cause})
    await expect(sink.suspend()).rejects.toBe(first.cause)
    expect([...state.calls]).toEqual([['body',1],['leaves',1]]);expect(closed).not.toHaveBeenCalled()
  }finally{state.root=''}
})
it('acknowledges known original closes once and keeps subsequent refusal and suspend idempotent',async()=>{
  const {sink,closed,cancel}=await setup(new Map())
  try{
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'refused',reason:'encoding'})
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'refused',reason:'encoding'})
    await sink.suspend()
    expect([...state.calls]).toEqual([['body',1],['leaves',1]])
    expect(closed).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalledTimes(1)
  }finally{state.root=''}
})
it('retains a separately held original close ACK while its failed sibling remains unknown',async()=>{
  const {sink,closed}=await setup(new Map([['leaves',false]])),held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
  state.gates.set('body',held.promise)
  state.entered.set('leaves',entered.resolve)
  try{
    let done=false
    const pending=sink.refuse!('encoding').then(value=>{done=true;return value})
    // Both exact original close calls begin even though body has not ACKed.
    await entered.promise
    expect(done).toBe(false);expect([...state.calls]).toEqual([['body',1],['leaves',1]])
    held.resolve()
    expect(await pending).toMatchObject({kind:'recovery-required',cause:false})
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'recovery-required',cause:false})
    expect([...state.calls]).toEqual([['body',1],['leaves',1]]);expect(closed).not.toHaveBeenCalled()
  }finally{held.resolve();state.root=''}
})
it('keeps original finish and reconciliation incomplete after a consuming close loses its reply',async()=>{
  const {sink,closed}=await setup(new Map([['body',false]]))
  try{
    expect(await sink.finish('complete')).toMatchObject({kind:'recovery-required',cause:false})
    expect(await sink.reconcile()).toMatchObject({kind:'recovery-required',cause:false})
    await expect(sink.suspend()).rejects.toBe(false)
    expect([...state.calls]).toEqual([['body',1],['leaves',1]]);expect(closed).not.toHaveBeenCalled()
  }finally{state.root=''}
})
it('retains the same original writer debt through repeated actual service cleanup',async()=>{
  state.root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'service-refusal-close-'))
  state.faults=new Map([['body',false]]);state.calls.clear();state.gates.clear();state.entered.clear();state.opens=0
  const action=createNondurableFactOwner(createSession()).beginAction(),source=action.registerSettlementSource(async()=>{});action.finish()
  const service=createContextOutputService({root:state.root,workspaceId:'original'})
  const scope=service.registerResultScope({operationId:'original',sessionId:'s',callId:'c'},()=>{source.assertHeld();return true})
  try{
    const sink=await service.beginResult(scope,'code-output-manifest-v1');await sink.write(Buffer.from('original'))
    expect(await sink.refuse!('encoding')).toMatchObject({kind:'recovery-required',cause:false})
    await expect(service.close()).rejects.toBe(false)
    await expect(service.close()).rejects.toBe(false)
    expect([...state.calls]).toEqual([['body',1],['leaves',1]]);expect(state.opens).toBe(2)
  }finally{await source.close();state.root=''}
})
