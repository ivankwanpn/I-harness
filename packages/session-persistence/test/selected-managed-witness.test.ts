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
  let revoked=0,reentered=false;const witness=retainSelectedSourceRead(document,ownership,()=>{revoked++;try{retainSelectedSourceRead(document,ownership,()=>{});reentered=true}catch{}});expect(witness.view).toBe(document.view);witness.assertCurrent()
  const write=document.metadata.enterPlan('proposal');await Promise.resolve();await Promise.resolve();expect(revoked).toBe(1);expect(reentered).toBe(false);expect(()=>witness.assertCurrent()).toThrow();await write;witness.unsubscribe();await document.close().catch(()=>{})
 }finally{await claim.release()}
})
it('connects the genuine document witness to the original retained binding across two uses',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-connected-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('source')
 try{
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13})
  const {createBindingObservations}=await import('../src/coordinator/binding-observation.ts'),bindings=createBindingObservations(backend,ownership),retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']})
  const document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{})
  let revoked=false;const witness=retainSelectedSourceRead(document,ownership,()=>{retained.revoke();revoked=true});let first:unknown,second:unknown
  await retained.use(async()=>{witness.assertCurrent();first=witness.view});await retained.use(async()=>{witness.assertCurrent();second=witness.view});expect(second).toBe(first)
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();const active=retained.use(async()=>{entered.resolve();await leave.promise}).catch(error=>error);await entered.promise
  const write=document.metadata.enterPlan('proposal');await Promise.resolve();await Promise.resolve();expect(revoked).toBe(true);let disposed=false;const disposal=retained.release().then(()=>{disposed=true});await Promise.resolve();expect(disposed).toBe(false);leave.resolve();await active;await disposal;expect(()=>retained.assertCurrent()).toThrow();await write;witness.unsubscribe();await document.close().catch(()=>{});await bindings.closeAdmission()()
 }finally{await claim.release()}
})

it('rejects a forged document or other ownership and revokes on close admission',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'witness-owner-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('source')
 try{
  const document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{}),other=createOwnership({lockRoot:root},{lock:{enabled:true}})
  expect(()=>retainSelectedSourceRead({...document},ownership,()=>{})).toThrow();expect(()=>retainSelectedSourceRead(document,other,()=>{})).toThrow()
  let calls=0;const witness=retainSelectedSourceRead(document,ownership,()=>calls++);document.revokeNewWork();expect(calls).toBe(1);expect(()=>witness.assertCurrent()).toThrow();witness.unsubscribe();await document.close()
 }finally{await claim.release()}
})

it.each(['revoke','admit'] as const)('retires automatically when the genuine source %s occurs inside its active selected use',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-self-revoke-')),backend=createJsonlBackend(root),real=createOwnership({lockRoot:root},{lock:{enabled:true}}),released=Promise.withResolvers<void>()
 let original!:Awaited<ReturnType<typeof real.acquireLease>>
 const ownership={...real,async acquireLease(name:string){original=await real.acquireLease(name);return {...original,get held(){return original.held},async release(){await original.release();released.resolve()}}}},claim=await ownership.pinOwnership('source')
 const {createBindingObservations}=await import('../src/coordinator/binding-observation.ts'),bindings=createBindingObservations(backend,ownership)
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13})
  const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{})
  const witness=retainSelectedSourceRead(document,ownership,retained.revoke),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>()
  let write:Promise<unknown>|undefined
  const running=retained.use(async()=>{
   if(mode==='revoke')document.revokeNewWork();else write=document.metadata.enterPlan('proposal')
   expect(()=>witness.assertCurrent()).toThrow();expect(()=>retained.assertCurrent()).toThrow()
   await expect(retained.release()).rejects.toMatchObject({reason:'conflict'});expect(original.held).toBe(true);entered.resolve();await leave.promise
  }).catch(error=>error)
  await entered.promise;expect(original.held).toBe(true);await expect(retained.use(async()=>{})).rejects.toMatchObject({reason:'revoked'})
  leave.resolve();expect(await running).toMatchObject({reason:'revoked'});await released.promise;expect(original.held).toBe(false)
  const mutation=bindings.beginMutation(['source'],[]);await mutation.join();mutation.finish()
  await write;witness.unsubscribe();await document.close()
 } finally {await bindings.closeAdmission()();await claim.release()}
})

it('rejects witness acquisition while a managed admission is suspended before queue insertion',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'witness-admission-gap-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('source')
 try {
  const document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{})
  const write=document.metadata.enterPlan('proposal')
  expect(()=>retainSelectedSourceRead(document,ownership,()=>{})).toThrow()
  await write;await document.close().catch(()=>{})
 } finally {await claim.release()}
})

it('releases the original binding automatically when its genuine managed source changes while idle',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-idle-revoke-')),backend=createJsonlBackend(root),real=createOwnership({lockRoot:root},{lock:{enabled:true}}),released=Promise.withResolvers<void>()
 let original!:Awaited<ReturnType<typeof real.acquireLease>>
 const ownership={...real,async acquireLease(name:string){original=await real.acquireLease(name);return {...original,get held(){return original.held},async release(){await original.release();released.resolve()}}}},claim=await ownership.pinOwnership('source')
 const {createBindingObservations}=await import('../src/coordinator/binding-observation.ts'),bindings=createBindingObservations(backend,ownership)
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13})
  const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{})
  const witness=retainSelectedSourceRead(document,ownership,retained.revoke)
  await retained.use(async()=>{witness.assertCurrent()});expect(original.held).toBe(true)
  const write=document.metadata.enterPlan('proposal');expect(()=>retained.assertCurrent()).toThrow();await released.promise
  expect(original.held).toBe(false);await expect(retained.use(async()=>{})).rejects.toMatchObject({reason:'revoked'})
  await write;witness.unsubscribe();await document.close()
 } finally {await bindings.closeAdmission()();await claim.release()}
})

