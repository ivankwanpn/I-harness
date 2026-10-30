import { expect, it, vi } from 'vitest'
import { createSessionCoordinator } from '../src/index.ts'
it('refuses unsupported generic durable writes before backend effects at format 14',async()=>{
 const backend:any={id:'custom',create:vi.fn(),append:vi.fn(),updateMeta:vi.fn(),read:vi.fn(async()=>({version:13,events:[],meta:{sessionId:'p',formatVersion:13,createdAt:'x'}})),repair:vi.fn(),list:vi.fn(async()=>['p']),putDocument:vi.fn(),getDocument:vi.fn()}
 const coordinator=createSessionCoordinator(backend,{lock:{enabled:false}})
 try{
  await expect(coordinator.create({sessionId:'p'})).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED')
  await expect(coordinator.append('p',[{type:'user/message',text:'x'}])).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED')
  expect(()=>coordinator.enqueue('p',[{type:'user/message',text:'x'}])).toThrow('TASK_TRANSITION_UNSUPPORTED')
  await expect(coordinator.ensureWritableFormat!('p')).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED')
  await expect(coordinator.loadOwned('p')).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED')
  await expect(coordinator.adoptOwnership('p')).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED')
  expect(await coordinator.bootstrapSemanticTarget({} as any,{} as any)).toEqual({kind:'not-issued',reason:'unsupported'})
  expect((await coordinator.snapshot!('p')).session.formatVersion).toBe(14)
  expect(await coordinator.list()).toEqual(['p']);expect(backend.create).not.toHaveBeenCalled();expect(backend.append).not.toHaveBeenCalled();expect(backend.updateMeta).not.toHaveBeenCalled();expect(backend.repair).not.toHaveBeenCalled();expect(backend.putDocument).not.toHaveBeenCalled()
 } finally {await coordinator.close()}
})
