import { createResultObservationScope } from '../../session-executor/src/lifecycle/result-observation.ts'
import { createManagedDocument } from '../../session-persistence/src/coordinator/managed-document.ts'
import { createSession,legacyPrefixDigest } from '@i-harness/core-session'
import { it,expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createBindingObservations } from '../../session-persistence/src/coordinator/binding-observation.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'
it('retains the original broker getter across uses and revokes on reference change',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-project-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root)
 try{
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),retained=await broker.retainSelectedBindingRead(['source'],binding,'source')
  const getter=retained.sourceGetter,document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{}),scopes=createResultObservationScope(),result=scopes.retainSelected({sessionId:'source',sessionIds:['source'],observation:binding.observation,document,currentSource(){getter();return {sourceId:'source',readonly:true}},assertHostCurrent(){retained.assertCurrent()}});let failClose=true,closeCalls=0;retained.attachResult({revoke(){result.revoke()},async close(){closeCalls++;if(failClose){failClose=false;throw Error('close failure')}await result.close()}});let first:unknown,second:unknown
  await binding.use(()=>retained.use(()=>result.use(async()=>{first=scopes.current('source')})));await binding.use(()=>retained.use(()=>result.use(async()=>{second=scopes.current('source')})));expect(second).toBe(first);expect(retained.sourceGetter).toBe(getter)
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();const active=binding.use(()=>retained.use(()=>result.use(async()=>{entered.resolve();await leave.promise}))).catch(error=>error);await entered.promise;await broker.configureReferences([]);expect(()=>retained.assertCurrent()).toThrow();let released=false;const release=binding.release().then(()=>{released=true}).catch(()=>{});await Promise.resolve();expect(released).toBe(false);leave.resolve();await active;await release;await binding.release();expect(closeCalls).toBe(2);await document.close();await broker.close();await bindings.closeAdmission()()
 }finally{await coordinator.close()}
})




it('revokes an idle retained project without a warm retry',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-project-idle-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root)
 try{
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),project=await broker.retainSelectedBindingRead(['source'],binding,'source');let revoked=0;binding.onRevoke(()=>revoked++)
  await binding.use(()=>project.use(async()=>{project.sourceGetter()}));const update=broker.configureReferences([]);expect(revoked).toBe(1);await update;const other=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),pin=await other.pinOwnership('source');await pin.release();await binding.release();expect(()=>project.assertCurrent()).toThrow();await broker.close();await bindings.closeAdmission()()
 }finally{await coordinator.close()}
})

