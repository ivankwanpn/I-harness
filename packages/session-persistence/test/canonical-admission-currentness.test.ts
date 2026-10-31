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
