import { it,expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSession,legacyPrefixDigest,CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createBindingObservations } from '../../session-persistence/src/coordinator/binding-observation.ts'
import { createManagedDocument } from '../../session-persistence/src/coordinator/managed-document.ts'
import { createResultObservationScope } from '../src/lifecycle/result-observation.ts'
it('retains one result source across uses and expires escaped use entries',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'result-retained-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('source'),bindings=createBindingObservations(backend,ownership)
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
  const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{}),scope=createResultObservationScope();let gets=0
  const retained=scope.retainSelected({sessionId:'source',sessionIds:['source'],observation:binding.observation,document,currentSource(){gets++;return {sourceId:'source',readonly:true}},assertHostCurrent(){binding.assertCurrent()}}),gate=Promise.withResolvers<void>();let escaped!:Promise<unknown>,first:unknown,second:unknown;binding.installRetirementDependency(retained)
  await binding.use(()=>retained.use(async()=>{first=scope.current('source');escaped=(async()=>{await gate.promise;return scope.current('source')})()}));await binding.use(()=>retained.use(async()=>{second=scope.current('source')}));expect(first).toBe(second);expect(gets).toBe(1)
  gate.resolve();await expect(escaped).rejects.toThrow('expired');const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();const active=binding.use(()=>retained.use(async()=>{entered.resolve();await leave.promise})).catch(error=>error);await entered.promise;let closed=false;binding.revoke();const closing=binding.release().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);leave.resolve();await active;await closing;expect(closed).toBe(true);await binding.release();await document.close();await bindings.closeAdmission()()
 }finally{await claim.release()}
})


