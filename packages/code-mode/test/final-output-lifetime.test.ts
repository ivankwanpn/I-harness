import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createNondurableFactOwner, createSession } from '@i-harness/core-session'
import { registerCodeMode } from '../src/register.ts'
import { observeOriginalCellFinalizations } from '../src/finalization.ts'
import type { OriginalCellFinalization } from '../src/finalization.ts'
import { createFinalOutputLifetime } from '../src/final-output-lifetime.ts'
import { originalCodeCommit } from '../src/event-facts/commit-proof.ts'

it('refuses copied record/outcome DTOs as original queue commit authority',()=>{
  expect(()=>originalCodeCommit({originalEvent:{type:'code/output',cellId:'copied'},nativeOutcome:{kind:'committed',seqs:[0]}})).toThrow('Original Code queue commit required')
})

it('joins independent external observers of the same original pending source',async()=>{
 const session=createSession(),owner=createNondurableFactOwner(session),ctx=createContext(),tools=createToolRegistry(ctx)
 const mount=registerCodeMode(ctx,tools,{session,factOwner:owner,config:{mode:'mixed'}})
 const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let calls=0
 let lifetime!:ReturnType<typeof createFinalOutputLifetime<string>>
 const off=observeOriginalCellFinalizations(mount,(_id,handle)=>{lifetime=createFinalOutputLifetime(owner,handle,()=>({async finish(){calls++;entered.resolve();await gate.promise;return 'original'}}))})
 try{
  await tools.get('code_exec')!.execute({code:'text(1)',yield_time_ms:60000},{session})
  const first=lifetime.settle();void first.catch(()=>{});await entered.promise
  const second=lifetime.settle();void second.catch(()=>{});expect(second).toBe(first);expect(calls).toBe(1)
  gate.resolve();expect(await first).toBe('original');expect(await second).toBe('original')
  expect(await lifetime.settle()).toBe('original');expect(calls).toBe(1);expect(()=>lifetime.assertHeld()).toThrow()
 }finally{gate.resolve();off();await mount.dispose()}
})
it('closes the independent retention source only after original cell ACK without making that cell await manifest finish', async () => {
  const session = createSession(), owner = createNondurableFactOwner(session), ctx = createContext(), tools = createToolRegistry(ctx)
  const finish = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const mount = registerCodeMode(ctx, tools, { session, factOwner: owner, config: { mode: 'mixed' } })
  let lifetime!: ReturnType<typeof createFinalOutputLifetime<string>>, settled!: Promise<string>, originalHandle!:OriginalCellFinalization,cells = 0
  const off = observeOriginalCellFinalizations(mount, (_id, original) => {
    cells++
    originalHandle=original
    lifetime = createFinalOutputLifetime(owner, original, assertHeld => ({ async finish() {
      assertHeld(); entered.resolve(); await finish.promise; assertHeld(); return 'original retained result'
    } }))
    settled = lifetime.settle() // Begin close BEFORE guest effects; no backedge.
  })
  try {
    const output = await tools.get('code_exec')!.execute({ code: 'text("program value")', yield_time_ms: 60000 }, { session })
    expect(output).toMatchObject({ status: 'completed', text: 'program value' })
    expect(()=>createFinalOutputLifetime(owner,{...originalHandle},()=>({async finish(){return 'forged'}}))).toThrow('Original matching')
    expect(()=>createFinalOutputLifetime(createNondurableFactOwner(session),originalHandle,()=>({async finish(){return 'foreign'}}))).toThrow('Original matching')
    await entered.promise
    lifetime.assertHeld() // Cell output source has already closed, this has not.
    let done = false; void settled.then(() => { done = true })
    await Promise.resolve(); expect(done).toBe(false)
    finish.resolve(); expect(await settled).toBe('original retained result')
    expect(await lifetime.settle()).toBe('original retained result')
    expect(() => lifetime.assertHeld()).toThrow()
    expect(cells).toBe(1)
  } finally { finish.resolve(); off(); await mount.dispose() }
})
