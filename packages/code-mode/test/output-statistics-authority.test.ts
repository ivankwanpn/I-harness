import { expect, it } from 'vitest'
import * as finalization from '../src/finalization.ts'
import { createCodeModeRuntime } from '../src/runtime.ts'
import { instructionReplan } from '@i-harness/core-tools'
import { originalObservationReplan } from '../src/runtime/replan-observation.ts'

it('only the runtime constructor certifies output statistics before observer publication', async () => {
  const unsafe=finalization as unknown as {bindOriginalOutputLifetime?: (handle:finalization.OriginalCellFinalization, read:()=>unknown)=>void}
  const fake=finalization.createCellFinalizations('runtime-retirement').reserve('fake',async()=>{})
  unsafe.bindOriginalOutputLifetime?.(fake,()=>({accepted:999,truncated:false}))
  expect(()=>finalization.readOriginalOutputLifetime(fake)).toThrow()
  const runtime=createCodeModeRuntime({tools:()=>[],invoke:async()=>undefined})
  let handle!:finalization.OriginalCellFinalization, atPublication:unknown
  const off=finalization.observeOriginalCellFinalizations(runtime,(_id,original)=>{
    handle=original
    unsafe.bindOriginalOutputLifetime?.(original,()=>({accepted:999,truncated:false}))
    try { atPublication=finalization.readOriginalOutputLifetime(original) } catch { atPublication='unavailable' }
  })
  try {
    await runtime.exec({code:'text("one");text("two")',yield_time_ms:60000})
    await handle.settle()
    expect(atPublication).toMatchObject({accepted:0,truncated:false})
    expect(unsafe.bindOriginalOutputLifetime).toBeUndefined()
    expect(finalization.readOriginalOutputLifetime(handle)).toMatchObject({accepted:2,truncated:false})
    expect(Object.hasOwn(finalization.readOriginalOutputLifetime(handle),'instructionReplan')).toBe(false)
    expect(Object.isFrozen(finalization.readOriginalOutputLifetime(handle))).toBe(true)
    expect(()=>finalization.readOriginalOutputLifetime({...handle})).toThrow()
  } finally { off();await runtime.dispose() }
})

it('keeps real truncation and replan statistics on their original runtime handles',async()=>{
  const error=instructionReplan({code:'INSTRUCTIONS_REPLAN_REQUIRED',reason:'changed-dependency',currentFingerprint:'current'})
  const originalData=error.data
  const runtime=createCodeModeRuntime({tools:()=>[{name:'stale',description:'',inputSchema:{}}],invoke:async()=>{throw error}})
  const handles:finalization.OriginalCellFinalization[]=[]
  const off=finalization.observeOriginalCellFinalizations(runtime,(_id,handle)=>handles.push(handle))
  try {
    await runtime.exec({code:'for (let i=0;i<300;i++) text("x")',yield_time_ms:60000})
    await handles[0]!.settle()
    expect(finalization.readOriginalOutputLifetime(handles[0]!)).toMatchObject({accepted:256,truncated:true})
    const observation=await runtime.exec({code:'await tools.stale({})',yield_time_ms:60000})
    await handles[1]!.settle()
    const stats=finalization.readOriginalOutputLifetime(handles[1]!)
    expect(stats.instructionReplan).toBe(true)
    expect(Reflect.set(stats,'instructionReplan',undefined)).toBe(false)
    expect(Reflect.set(stats,'instructionReplan',error)).toBe(false)
    expect(Reflect.set(stats,'accepted',999)).toBe(false)
    expect(originalObservationReplan(observation)).toBe(error)
    expect(observation.instructionReplan).toEqual(error.data)
    expect(Object.isFrozen(error)).toBe(false) // Do not freeze caller-owned errors.
    expect(error.data).toBe(originalData)
    expect(error.data.reason).toBe('changed-dependency')
    expect(finalization.readOriginalOutputLifetime(handles[1]!)).toMatchObject({accepted:0,truncated:false,instructionReplan:true})
  } finally {off();await runtime.dispose()}
})
