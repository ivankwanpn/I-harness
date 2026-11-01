import { expect, it, vi } from 'vitest'
const control = vi.hoisted(() => ({ mode: 'constructor' as 'constructor' | 'attach', terminations:0 }))
vi.mock('node:worker_threads', async original => ({ ...await original<typeof import('node:worker_threads')>(), Worker: class {
  constructor() { if (control.mode === 'constructor') throw new Error('constructor fault') }
  on() { throw new Error('attach fault') }
  terminate() { control.terminations++;return Promise.resolve(0) }
} }))
import { createCodeModeRuntime } from '../src/runtime.ts'
import * as finalization from '../src/finalization.ts'
type UnsafeBinder = { bindOriginalWorkerAcquisition?: (handle:finalization.OriginalCellFinalization,read:()=> 'acquired'|'not-acquired')=>void }
const importedBinder=()=> (finalization as unknown as UnsafeBinder).bindOriginalWorkerAcquisition

it('refuses imported fake finalization handles even when an importer attempts to certify them',()=>{
  const fake={scope:'runtime-retirement' as const,async settle(){}}
  importedBinder()?.(fake,()=> 'acquired')
  expect(()=>finalization.readOriginalWorkerAcquisition(fake)).toThrow(/unavailable/)
  const observation=finalization.createCellFinalizations('runtime-retirement').reserve('same-cell',async()=>{})
  importedBinder()?.(observation,()=> 'acquired')
  expect(()=>finalization.readOriginalWorkerAcquisition(observation)).toThrow(/unavailable/)
  expect(importedBinder()).toBeUndefined()
})
it('publishes the original acquisition association before observers and refuses imported rebinding',async()=>{
  control.mode='constructor'
  const runtime=createCodeModeRuntime({tools:()=>[],invoke:async()=>undefined})
  let original!:finalization.OriginalCellFinalization,published='unavailable'
  const off=finalization.observeOriginalCellFinalizations(runtime,(_id,handle)=>{
    original=handle
    importedBinder()?.(handle,()=> 'acquired')
    try{published=finalization.readOriginalWorkerAcquisition(handle)}catch{/* Recorded below, not swallowed as proof. */}
  })
  try{
    await expect(runtime.exec({code:'text(1)'})).rejects.toThrow('constructor fault')
    expect(published).toBe('unknown')
    expect(finalization.readOriginalWorkerAcquisition(original)).toBe('not-acquired')
    importedBinder()?.(original,()=> 'acquired')
    expect(finalization.readOriginalWorkerAcquisition(original)).toBe('not-acquired')
    expect(()=>finalization.readOriginalWorkerAcquisition({...original})).toThrow(/unavailable/)
  }finally{off();await runtime.dispose()}
})

it.each(['constructor', 'attach'] as const)('records the original Worker acquisition at the constructor boundary: %s failure', async mode => {
  control.mode = mode
  control.terminations=0
  const runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => undefined })
  let handle!: finalization.OriginalCellFinalization
  const off = finalization.observeOriginalCellFinalizations(runtime, (_id, original) => { handle = original })
  try {
    await expect(runtime.exec({ code: 'text(1)' })).rejects.toThrow(mode === 'constructor' ? 'constructor fault' : 'attach fault')
    expect(finalization.readOriginalWorkerAcquisition(handle)).toBe(mode === 'constructor' ? 'not-acquired' : 'acquired')
    expect(() => finalization.readOriginalWorkerAcquisition({ ...handle })).toThrow()
    await runtime.dispose()
    await handle.settle()
    expect(control.terminations).toBe(mode==='attach'?1:0)
    expect(finalization.readOriginalWorkerAcquisition(handle)).toBe(mode==='constructor'?'not-acquired':'acquired')
  } finally { off();await runtime.dispose() }
})

