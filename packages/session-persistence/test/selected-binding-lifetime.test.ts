import { it,expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
it('retains one original binding across uses and revokes it before idle mutation joins',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership)
 await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']});let first:unknown,second:unknown,revoked=0
 retained.onRevoke(()=>revoked++);await retained.use(async()=>{first=retained.observation;expect(retained.observation.metadata('source').sessionId).toBe('source')});await retained.use(async()=>{second=retained.observation});expect(second).toBe(first)
 expect(()=>retained.installRetirementDependency({revoke(){},async close(){}})).toThrow()
 const mutation=bindings.beginMutation(['source'],[]);expect(revoked).toBe(1);await mutation.join();expect(()=>retained.assertCurrent()).toThrow();mutation.finish()
 let old:any;await bindings.withExistingSessionBindingObservation({sessionIds:['source']},async observation=>{old=observation});expect(()=>old.assertCurrent()).toThrow()
 await retained.release();await bindings.closeAdmission()()
})
it('revokes immediately but joins an active use before releasing the original locks',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-active-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership)
 await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>()
 const running=retained.use(async()=>{entered.resolve();await leave.promise}).catch(error=>error);await entered.promise
 const mutation=bindings.beginMutation(['source'],[]);let joined=false;const joining=mutation.join().then(()=>{joined=true});await Promise.resolve();expect(joined).toBe(false);expect(()=>retained.assertCurrent()).toThrow();leave.resolve();await running;await joining;expect(joined).toBe(true);mutation.finish();await retained.release();await bindings.closeAdmission()()
})
it('retries the same original lock after a release failure',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-cleanup-')),backend=createJsonlBackend(root),real=createOwnership({lockRoot:root},{lock:{enabled:true}});let attempts=0
 const ownership={...real,async acquireLease(name:string){const lock=await real.acquireLease(name);return {...lock,get held(){return lock.held},async release(){if(++attempts===1)throw Error('injected release');await lock.release()}}}}
 const bindings=createBindingObservations(backend,ownership);await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']});let closes=0
 retained.installRetirementDependency({revoke(){},async close(){if(++closes>1)throw Error('dependent already closed')}})
 try {
  const error=await retained.release().catch(error=>error);expect(error).toBeInstanceOf(AggregateError);const cleanup=bindings.cleanupForError(error);expect(cleanup).toBeDefined();await cleanup!.retry();expect(attempts).toBe(2);expect(closes).toBe(1)
 } finally {await bindings.closeAdmission()().catch(()=>{})}
})
it('does not leave a completed use in inherited binding ALS',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-als-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership)
 await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),go=Promise.withResolvers<void>();let escaped!:Promise<void>
 await retained.use(async()=>{escaped=(async()=>{await go.promise;const mutation=bindings.beginMutation(['source'],[]);await mutation.join();mutation.finish()})()})
 go.resolve();await escaped;await retained.release();await bindings.closeAdmission()()
})

it.each(['lease','pin','both'] as const)('returns original cleanup debt when acquisition and its first %s release fail',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-acquire-debt-')),backend=createJsonlBackend(root),real=createOwnership({lockRoot:root},{lock:{enabled:true}})
 let acquisitions=0,attempts=0,profiles=0,pins=0,pinAttempts=0;let original!:Awaited<ReturnType<typeof real.acquireLease>>
 const failLease=mode!=='pin',failPin=mode!=='lease'
 const ownership={...real,async acquireLease(name:string){acquisitions++;original=await real.acquireLease(name);return {...original,get held(){return original.held},async release(){if(++attempts===1&&failLease)throw Error('original lease close failed');await original.release()}}},async pinOwnership(id:string){pins++;const pin=await real.pinOwnership(id);return {...pin,async release(){if(++pinAttempts===1&&failPin)throw Error('original pin close failed');await pin.release()}}}}
 const bindings=createBindingObservations({...backend,async profile(id:string){profiles++;await backend.profile(id);throw Error('source profile failed')}},ownership)
 await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 try {
  const error=await bindings.acquireSelectedBindingRead({sessionIds:['source']}).catch(error=>error)
  expect(error).toBeInstanceOf(AggregateError);expect(original.held).toBe(failLease);expect(real.ownerOf('source')).toBe(failPin)
  const cleanup=bindings.cleanupForError(error);expect(cleanup).toBeDefined();await cleanup!.retry()
  expect(original.held).toBe(false);expect(real.ownerOf('source')).toBe(false);expect({acquisitions,pins,profiles}).toEqual({acquisitions:1,pins:1,profiles:1})
  expect(attempts).toBe(failLease?2:1);expect(pinAttempts).toBe(failPin?2:1)
  await cleanup!.retry();expect(attempts).toBe(failLease?2:1);expect(pinAttempts).toBe(failPin?2:1)
 } finally {await bindings.closeAdmission()()}
})

it('refuses a dependent close joining its own binding retirement',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-dependent-self-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership)
 await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 try {
  const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']});let selfError:unknown
  retained.installRetirementDependency({revoke(){},async close(){selfError=await retained.release().catch(error=>error)}})
  await retained.release();expect(selfError).toMatchObject({reason:'conflict'})
 } finally {await bindings.closeAdmission()()}
})

it('drains the original dependent after active use and before binding resources',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-dependent-')),backend=createJsonlBackend(root),real=createOwnership({lockRoot:root},{lock:{enabled:true}}),order:string[]=[]
 const ownership={...real,async acquireLease(name:string){const original=await real.acquireLease(name);return {...original,get held(){return original.held},async release(){order.push('lock');await original.release()}}},async pinOwnership(id:string){const original=await real.pinOwnership(id);return {...original,async release(){order.push('pin');await original.release()}}}}
 const bindings=createBindingObservations(backend,ownership);await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),closing=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>()
 try {
  retained.installRetirementDependency({revoke(){order.push('revoke')},async close(){closing.resolve();await closed.promise;order.push('dependent')}})
  const running=retained.use(async()=>{entered.resolve();await leave.promise}).catch(error=>error);await entered.promise
  const mutation=bindings.beginMutation(['source'],[]);expect(order).toEqual(['revoke']);let joined=false;const joining=mutation.join().then(()=>{joined=true})
  leave.resolve();expect(await running).toMatchObject({reason:'revoked'});await closing.promise;expect(order).toEqual(['revoke']);expect(joined).toBe(false)
  closed.resolve();await joining;expect(order).toEqual(['revoke','dependent','lock','pin']);mutation.finish();await retained.release()
 } finally {leave.resolve();closed.resolve();await bindings.closeAdmission()()}
})

it('keeps the original resources when dependent close fails and retries that same dependency',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-dependent-debt-')),backend=createJsonlBackend(root),real=createOwnership({lockRoot:root},{lock:{enabled:true}})
 let attempts=0,acquisitions=0,releases=0
 const ownership={...real,async acquireLease(name:string){acquisitions++;const original=await real.acquireLease(name);return {...original,get held(){return original.held},async release(){releases++;await original.release()}}}}
 const bindings=createBindingObservations(backend,ownership);await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 try {
  const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']});let revoked=0
  retained.installRetirementDependency({revoke(){revoked++},async close(){if(++attempts===1)throw Error('dependent close failed')}})
  expect(()=>retained.installRetirementDependency({revoke(){},async close(){}})).toThrow()
  const error=await retained.release().catch(error=>error);expect(error).toBeInstanceOf(AggregateError);expect({revoked,releases,attempts}).toEqual({revoked:1,releases:0,attempts:1})
  const cleanup=bindings.cleanupForError(error);expect(cleanup).toBeDefined();await cleanup!.retry();expect({revoked,releases,attempts,acquisitions}).toEqual({revoked:1,releases:1,attempts:2,acquisitions:1})
  await retained.release();await cleanup!.retry();expect(attempts).toBe(2)
 } finally {await bindings.closeAdmission()()}
})
