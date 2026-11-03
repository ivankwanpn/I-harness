import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const publication=vi.hoisted(()=>({fail:false,calls:0}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return {...real,async rename(...args:Parameters<typeof real.rename>){if(publication.fail&&String(args[1]).endsWith('ordinary.jsonl')){publication.calls++;throw undefined}return real.rename(...args)}}})
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import * as managed from '../src/coordinator/managed-document.ts'

it.each([false,true])('invalidates original ready metadata witnesses synchronously at supported admission, failed write=%s',async fail=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'meta-witness-'))
 const backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 const factory=vi.spyOn(managed,'createManagedDocument')
 try{
  await coordinator.create({sessionId:'ordinary'})
  const document=await coordinator.openManagedDocument('ordinary'),ownership=factory.mock.calls.at(-1)![4]
  const fixed=managed.captureManagedReadyObservation(document,ownership),parent=managed.captureManagedParentReadiness(document,ownership)
  let revoked=0
  const selected=managed.retainSelectedSourceRead(document,ownership,()=>revoked++)
  fixed.assertCurrent();parent.assertCurrent();selected.assertCurrent()
  publication.fail=fail;publication.calls=0
  const changing=coordinator.updateMeta('ordinary',{title:'current title'})
  expect(()=>fixed.assertCurrent()).toThrow();expect(()=>parent.assertCurrent()).toThrow();expect(()=>selected.assertCurrent()).toThrow();expect(revoked).toBe(1)
  expect(()=>managed.captureManagedReadyObservation(document,ownership)).toThrow()
  if(fail){await expect(changing).rejects.toThrow();expect(publication.calls).toBe(1)}
  else expect(await changing).toMatchObject({title:'current title'})
  expect(()=>fixed.assertCurrent()).toThrow();expect(()=>parent.assertCurrent()).toThrow()
  // The original metadata object stays frozen in its own lifetime; retirement
  // and a fresh owner supply the next current witness.
  selected.unsubscribe();await coordinator.closeManagedDocument('ordinary')
  if(!fail){const fresh=await coordinator.openManagedDocument('ordinary');expect(fresh).not.toBe(document);managed.captureManagedReadyObservation(fresh,factory.mock.calls.at(-1)![4]).assertCurrent()}
 }finally{publication.fail=false;await coordinator.close();factory.mockRestore()}
})
