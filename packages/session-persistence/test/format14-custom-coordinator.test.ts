import { expect, it, vi } from 'vitest'
import { createSessionCoordinator, createReadOnlySessionCoordinator, SessionLockUnsupportedError, type PersistenceBackend } from '../src/index.ts'
it('refuses unsupported generic durable writes before backend effects at format 14',async()=>{
 const meta={sessionId:'p',formatVersion:13,createdAt:'x'}
 const backend={id:'jsonl' as const,capabilities:{seekableRead:false,rawArtifacts:false},create:vi.fn(async()=>{}),append:vi.fn(async()=>{}),updateMeta:vi.fn(async()=>meta),read:vi.fn(async()=>({version:13,events:[],meta})),repair:vi.fn(async()=>({version:13,events:[],meta})),profile:vi.fn(async()=>({meta,blank:true})),list:vi.fn(async()=>['p']),putDocument:vi.fn(async()=>{}),getDocument:vi.fn(async()=>undefined)} satisfies PersistenceBackend
 expect(()=>createSessionCoordinator(backend,{lock:{enabled:false}})).toThrow(SessionLockUnsupportedError)
 expect(()=>createSessionCoordinator(backend,{lock:{enabled:true}})).toThrow('original writable coordinator factory')
 const coordinator=createReadOnlySessionCoordinator(backend,{lock:{enabled:false}})
 try{
  expect(coordinator.access).toBe('read')
  for(const method of ['create','append','enqueue','ensureWritableFormat','loadOwned','adoptOwnership','bootstrapSemanticTarget','openManagedDocument'])expect(method in coordinator).toBe(false)
  expect((await coordinator.snapshot('p')).session.formatVersion).toBe(14)
  expect(await coordinator.list()).toEqual(['p']);expect(backend.create).not.toHaveBeenCalled();expect(backend.append).not.toHaveBeenCalled();expect(backend.updateMeta).not.toHaveBeenCalled();expect(backend.repair).not.toHaveBeenCalled();expect(backend.putDocument).not.toHaveBeenCalled()
 } finally {await coordinator.close()}
})
