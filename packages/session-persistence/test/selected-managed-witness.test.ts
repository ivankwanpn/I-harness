import { it,expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSession,legacyPrefixDigest } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createManagedDocument,retainSelectedSourceRead } from '../src/coordinator/managed-document.ts'
it('notifies the real selected source witness when managed admission begins',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-witness-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('source')
 try{
  const session=createSession(),prefix={eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},document=createManagedDocument('source',session,prefix,backend,ownership,undefined,()=>{})
  let revoked=0;const witness=retainSelectedSourceRead(document,ownership,()=>revoked++);expect(witness.view).toBe(document.view);witness.assertCurrent()
  const write=document.metadata.enterPlan('proposal');await Promise.resolve();await Promise.resolve();expect(revoked).toBe(1);expect(()=>witness.assertCurrent()).toThrow();await write;witness.unsubscribe();await document.close().catch(()=>{})
 }finally{await claim.release()}
})
it('connects the genuine document witness to the original retained binding across two uses',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-connected-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('source')
 try{
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13})
  const {createBindingObservations}=await import('../src/coordinator/binding-observation.ts'),bindings=createBindingObservations(backend,ownership),retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']})
  const document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{})
  let disposal:Promise<void>|undefined;const witness=retainSelectedSourceRead(document,ownership,()=>{disposal=retained.release()});let first:unknown,second:unknown
  await retained.use(async()=>{witness.assertCurrent();first=witness.view});await retained.use(async()=>{witness.assertCurrent();second=witness.view});expect(second).toBe(first)
  const write=document.metadata.enterPlan('proposal');await Promise.resolve();await Promise.resolve();expect(disposal).toBeDefined();await disposal;expect(()=>retained.assertCurrent()).toThrow();await write;witness.unsubscribe();await document.close().catch(()=>{});await bindings.closeAdmission()()
 }finally{await claim.release()}
})
