import { expect,it,vi } from 'vitest'
import { mkdtemp,readdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskDocumentCoordinator } from '../src/task-document-factory.ts'
import { createSelectedRuntimeCapture } from '../../session-persistence/src/selected-source-owner.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
it.each(['generic','validator-only'] as const)('refuses selected runtime assembly for native %s before original operation/export or any effects',async kind=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-selected-capability-'))
 const coordinator=kind==='generic'?createSessionCoordinatorCore(createJsonlBackend(root),{lock:{enabled:true}}):createJsonlTaskDocumentCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 const make=vi.fn(()=>{throw Error('original operation must not be constructed')})
 try{expect(()=>createSelectedRuntimeCapture(coordinator,make)).toThrow('TASK_TRANSITION_UNSUPPORTED');expect(make).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([])}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})

import { createJsonlBackend } from '../src/backend-factory.ts'
import { createSessionCoordinatorCore } from '../../session-persistence/src/coordinator-factory.ts'
import { createSelectedResultsIntent,readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { codecSeed } from '../../core-session/test/fixtures/selected-results.ts'
it('original selected owner refuses before capture export or native header issue without a transition',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-selected-original-owner-')),backend=createJsonlBackend(root)
 let managed:Parameters<NonNullable<Parameters<typeof createSessionCoordinatorCore>[3]>>[0]['managed']|undefined
 const coordinator=createSessionCoordinatorCore(backend,{lock:{enabled:true}},{async capture(){throw Error('unused observational port')},async captureManagedAuxiliary(){throw Error('unused observational port')}},owners=>{managed=owners.managed})
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}},capture=vi.fn(async()=>({invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed:compileSelectedResultsSemanticSeed(codecSeed('public-completed'))}))
 try{await expect(Promise.resolve().then(()=>managed!.captureSelected(route,{},()=>{},capture))).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED');expect(capture).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([])}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
