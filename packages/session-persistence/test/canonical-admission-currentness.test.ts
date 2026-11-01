import { expect, it } from 'vitest'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
import type { OriginalColdBootstrap } from '../src/coordinator/cold-finalization-types.ts'

it('cold own-ticket exemption retains an alias mutation admitted during prior-owner revocation',async()=>{
  const key='desktop-session-project-'+(await import('node:crypto')).createHash('sha256').update('target').digest('hex')
  let alias:ReturnType<ReturnType<typeof createBindingObservations>['beginMutation']>|undefined,started=false,removed=false,effects=0
  const observations=createBindingObservations({async putDocument(){},async getDocument(){},async profile(){throw Error('profile forbidden')},async readDocumentObserved(){effects++;return {kind:'absent'}}},{lockEnabled:true,async acquireLease(){effects++;return {held:true,async release(){}}},async pinOwnership(){effects++;return {assertHeld(){},retainLive(){},async release(){}}},async withSessionOperation(_id,run){return run()},exclusionScope(ids,keys){return {keys:[...ids.map(id=>'session:'+id),...keys.map(value=>'document:'+(value==='alias-binding'?key:value))],assertCurrent(){}}}})
  const registration=observations.registerOwnedDocumentOperation('target',key,{revoke(){if(!started){started=true;alias=observations.beginMutation([],['alias-binding'])}},async close(){if(!removed){removed=true;registration.unregister()}},async retryClose(){},assertOutside(){}})
  await registration.join()
  // Trusted constructor fixture isolates the binding ticket, without granting
  // product readiness or replacing the original admission/physical matcher.
  const access={identity:{},route:{request:{invocation:{targetSessionId:'target'}}},assertCurrent(){},assertOutside(){},async use(work:(value:unknown)=>Promise<void>){await work({metadata:{sessionId:'target',formatVersion:14,createdAt:'now'}})},async settle(){},commit(){throw Error('not a readiness test')},attach(){},detach(){}}
  const factory=observations.createColdFinalizationFactory({capture(){return access}} as unknown as OriginalColdBootstrap,{begin(){return {async qualify(){effects++},sealWhileActive(){},async settle(){},assertSettledCurrent(){},revoke(){},async close(){}}}})
  const attempt=factory.begin({kind:'cold-selected-target'})
  expect(started).toBe(true)
  try{await expect((async()=>attempt.use())()).rejects.toThrow();expect(effects).toBe(0)}
  finally{await alias?.join();alias?.finish('settled');await attempt.close()}
})
it('owned admission retains its original directory incarnation rather than recapturing into a replacement', async () => {
  let incarnation=0, revoked=0
  const observations=createBindingObservations({async putDocument(){},async getDocument(){}},{lockEnabled:false,async acquireLease(){throw Error('unused')},exclusionScope(ids,keys){const captured=incarnation;return{keys:[...ids,...keys].map(key=>captured+':'+key),assertCurrent(){if(captured!==incarnation)throw Error('changed namespace')}}}})
  const registration=observations.registerOwnedDocumentOperation('parent','task-parent',{revoke(){revoked++},async close(){},async retryClose(){}})
  await registration.join(); incarnation++
  expect(()=>observations.beginMutation([],['task-parent'])).toThrow('changed namespace')
  expect(revoked).toBe(0); registration.unregister()
})

it.each(['ticket','mutation'] as const)('transition registration retains ready incarnation before later %s admission', async route => {
  let incarnation=0, effects=0
  const observations=createBindingObservations({async putDocument(){},async getDocument(){}},{lockEnabled:false,async acquireLease(){throw Error('unused')},exclusionScope(ids,keys){const captured=incarnation;return{keys:[...ids,...keys].map(key=>captured+':'+key),assertCurrent(){if(captured!==incarnation)throw Error('changed namespace')}}}})
  const ticket=observations.beginTaskTransition('parent',{revoke(){effects++},assertOutside(){effects++},async close(){effects++},async retryClose(){effects++}})
  await ticket.join(); incarnation++
  expect(route==='ticket'?()=>ticket.assertCurrent():()=>observations.beginMutation([],['task-parent'])).toThrow('changed namespace')
  expect(effects).toBe(0); ticket.finish('settled')
})
