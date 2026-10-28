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
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),error=await retained.release().catch(error=>error);expect(error).toBeInstanceOf(AggregateError);const cleanup=bindings.cleanupForError(error);expect(cleanup).toBeDefined();await cleanup!.retry();expect(attempts).toBe(2);await bindings.closeAdmission()()
})
it('does not leave a completed use in inherited binding ALS',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'retained-als-')),backend=createJsonlBackend(root),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),bindings=createBindingObservations(backend,ownership)
 await backend.create('source',{sessionId:'source',createdAt:'2026-10-28T00:00:00.000Z',formatVersion:CURRENT_FORMAT_VERSION})
 const retained=await bindings.acquireSelectedBindingRead({sessionIds:['source']}),go=Promise.withResolvers<void>();let escaped!:Promise<void>
 await retained.use(async()=>{escaped=(async()=>{await go.promise;const mutation=bindings.beginMutation(['source'],[]);await mutation.join();mutation.finish()})()})
 go.resolve();await escaped;await retained.release();await bindings.closeAdmission()()
})
