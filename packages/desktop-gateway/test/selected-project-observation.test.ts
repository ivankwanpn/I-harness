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
import { setImmediate as turn } from 'node:timers/promises'
it('retains the original broker getter across uses and revokes on reference change',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-project-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root)
 try{
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),retained=await broker.retainSelectedBindingRead(['source'],binding,'source')
  const getter=retained.sourceGetter,document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{}),scopes=createResultObservationScope(),result=scopes.retainSelected({sessionId:'source',sessionIds:['source'],observation:binding.observation,document,currentSource(){getter();return {sourceId:'source',readonly:true}},assertHostCurrent(){retained.assertCurrent()}});let failClose=true,closeCalls=0;retained.attachResult({revoke(){result.revoke()},async close(){closeCalls++;if(failClose){failClose=false;throw Error('close failure')}await result.close()}});let first:unknown,second:unknown
  await binding.use(()=>retained.use(()=>result.use(async()=>{first=scopes.current('source')})));await binding.use(()=>retained.use(()=>result.use(async()=>{second=scopes.current('source')})));expect(second).toBe(first);expect(retained.sourceGetter).toBe(getter)
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();const active=binding.use(()=>retained.use(()=>result.use(async()=>{entered.resolve();await leave.promise}))).catch(error=>error);await entered.promise;await broker.configureReferences([]);expect(()=>retained.assertCurrent()).toThrow();let released=false;const release=binding.release().then(()=>{released=true}).catch(()=>{});await Promise.resolve();expect(released).toBe(false);leave.resolve();await active;await release;await binding.release();expect(closeCalls).toBe(2);await document.close();await broker.close();await bindings.closeAdmission()()
 }finally{await coordinator.close()}
})

it.each([1,2])('joins original project acquisition paused at visibility call %s before binding release',async cut=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'project-acquiring-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),real=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>()
 let original!:Awaited<ReturnType<typeof real.acquireLease>>,calls=0
 const ownership={...real,async acquireLease(name:string){original=await real.acquireLease(name);return original}},bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root,async()=>{if(++calls===cut){entered.resolve();await leave.promise}return true})
 let acquisition:Promise<unknown>|undefined,closing:Promise<unknown>|undefined
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13})
  const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']})
  acquisition=broker.retainSelectedBindingRead(['source'],binding,'source').catch(error=>error);await entered.promise
  const update=broker.configureReferences([]);expect(()=>binding.assertCurrent()).toThrow()
  let settled=false;closing=binding.release().then(()=>{settled=true});await turn()
  expect(original.held).toBe(true);expect(settled).toBe(false)
  leave.resolve();expect(await acquisition).toBeInstanceOf(Error);await closing;await update;expect(original.held).toBe(false)
 } finally {leave.resolve();await acquisition;await closing;await broker.close();await bindings.closeAdmission()();await coordinator.close()}
})

it('refuses project-only callback self-close instead of joining its own use',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'project-self-close-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root)
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),project=await broker.retainSelectedBindingRead(['source'],binding,'source')
  let pending:Promise<unknown>|undefined
  try {await project.use(async()=>{pending=project.close().catch(error=>error);const value=await Promise.race([pending,turn().then(()=> 'pending')]);expect(value).toMatchObject({reason:'conflict'})})}
  finally {await pending;await project.close()}
 } finally {await broker.close();await bindings.closeAdmission()();await coordinator.close()}
})

it('preserves original cleanup debt after construction callback self-release refuses and setup fails',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'project-construction-debt-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),real=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}})
 let original!:Awaited<ReturnType<typeof real.acquireLease>>,acquisitions=0,releases=0,visibility=0,selfError:unknown,binding!:Awaited<ReturnType<ReturnType<typeof createBindingObservations>['acquireSelectedBindingRead']>>
 const ownership={...real,async acquireLease(name:string){acquisitions++;original=await real.acquireLease(name);return {...original,get held(){return original.held},async release(){if(++releases===1)throw Error('original close failed');await original.release()}}}},bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root,async()=>{visibility++;selfError=await binding.release().catch(error=>error);throw Error('visibility failed')})
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']})
  const error=await broker.retainSelectedBindingRead(['source'],binding,'source').catch(error=>error)
  expect(selfError).toMatchObject({reason:'conflict'});expect(error).toBeInstanceOf(AggregateError);expect(original.held).toBe(true)
  const cleanup=bindings.cleanupForError(error);expect(cleanup).toBeDefined();await cleanup!.retry();expect(original.held).toBe(false)
  await cleanup!.retry();expect({acquisitions,releases,visibility}).toEqual({acquisitions:1,releases:2,visibility:1})
 } finally {await broker.close();await bindings.closeAdmission()();await coordinator.close()}
})

it('expires project-only use ALS without rediscovering its getter or binding',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'project-escaped-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root)
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),project=await broker.retainSelectedBindingRead(['source'],binding,'source'),getter=project.sourceGetter,go=Promise.withResolvers<void>();let escaped!:Promise<unknown>
  await project.use(async()=>{escaped=(async()=>{await go.promise;return broker.resultReadScopeFor('source')})()});go.resolve();await expect(escaped).rejects.toThrow('expired')
  await project.use(async()=>{expect(project.sourceGetter).toBe(getter);getter()});await project.close()
 } finally {await broker.close();await bindings.closeAdmission()();await coordinator.close()}
})

it.each(['success','failure'] as const)('expires escaped initial visibility ALS after setup %s while retaining only the original getter',async outcome=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'project-setup-escaped-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),go=Promise.withResolvers<void>()
 let visibility=0,escaped!:Promise<unknown>
 const broker=createProjectScopeBroker(coordinator,root,async()=>{if(++visibility===1){escaped=(async()=>{await go.promise;return broker.resultReadScopeFor('source')})();if(outcome==='failure')throw Error('visibility failed')}return true})
 try {
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']})
  const acquisition=broker.retainSelectedBindingRead(['source'],binding,'source')
  if(outcome==='failure')await expect(acquisition).rejects.toThrow('visibility failed')
  const project=outcome==='success'?await acquisition:undefined,calls=visibility
  go.resolve();await expect(escaped).rejects.toThrow('Project observation expired');expect(visibility).toBe(calls)
  if(project){
   const getter=project.sourceGetter,document=createManagedDocument('source',createSession(),{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())},backend,ownership,undefined,()=>{}),scopes=createResultObservationScope();let captures=0
   const result=scopes.retainSelected({sessionId:'source',sessionIds:['source'],observation:binding.observation,document,currentSource(){captures++;getter();return {sourceId:'source',readonly:true}},assertHostCurrent(){project.assertCurrent()}});project.attachResult(result);let first:unknown,second:unknown
   await project.use(()=>result.use(async()=>{expect(project.sourceGetter).toBe(getter);getter();first=scopes.current('source')}))
   await project.use(()=>result.use(async()=>{expect(project.sourceGetter).toBe(getter);getter();second=scopes.current('source')}))
   expect(first).toBe(second);expect(captures).toBe(1);expect(visibility).toBe(calls);await project.close();await document.close()
  }
 } finally {go.resolve();await escaped?.catch(()=>{});await broker.close();await bindings.closeAdmission()();await coordinator.close()}
})




it('revokes an idle retained project without a warm retry',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-project-idle-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),ownership=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership),broker=createProjectScopeBroker(coordinator,root)
 try{
  await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:13});const binding=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),project=await broker.retainSelectedBindingRead(['source'],binding,'source');let revoked=0;binding.onRevoke(()=>revoked++)
  await binding.use(()=>project.use(async()=>{project.sourceGetter()}));const update=broker.configureReferences([]);expect(revoked).toBe(1);await update;const other=createOwnership({lockRoot:join(root,'sessions')},{lock:{enabled:true}}),pin=await other.pinOwnership('source');await pin.release();await binding.release();expect(()=>project.assertCurrent()).toThrow();await broker.close();await bindings.closeAdmission()()
 }finally{await coordinator.close()}
})

