import { expect, it } from 'vitest'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
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
