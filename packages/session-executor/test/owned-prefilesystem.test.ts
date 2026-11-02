import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import {createManagedExecutionRuntimeWithRegistry} from '../src/managed-assembly.ts'
import {controlledModel} from './controlled-model.ts'

it('retains original pre-FS owner before awaiting and registers FS only after it returns',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'pre-fs-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),cleanups:Array<()=>Promise<void>>=[];let retained=false,resolved=false
 const model=controlledModel(async function*(){yield {type:'end'}})
 const pending=createManagedExecutionRuntimeWithRegistry({execution:entry.execution,workspace:root,systemPrompt:'system',tools:[],originalFilesystem:true,assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),async prepareFilesystem(original){expect(original.tools.get('write')).toBeUndefined();original.retain(async()=>{retained=true});entered.resolve();await release.promise;return {take(){return {blobId:null,isNewFile:true}}}},configureRegistry(original){expect(original.tools.get('write')).toBeDefined()},resolveModel(){resolved=true;return {model}}})
 try{await entered.promise;expect(resolved).toBe(false);release.resolve();const runtime=await pending;expect(resolved).toBe(true);await runtime.close();for(const cleanup of cleanups.reverse())await cleanup();expect(retained).toBe(true)}finally{release.resolve();await cache.closeAll();await coordinator.close()}
},30000)
it('closes the original retention window when pre-FS preparation fails',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'pre-fs-failed-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>Promise<void>>=[];let original:import('../src/managed-assembly.ts').ManagedRegistryConstruction|undefined
 try{await expect(createManagedExecutionRuntimeWithRegistry({execution:entry.execution,workspace:root,systemPrompt:'system',tools:[],originalFilesystem:true,assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),async prepareFilesystem(value){original=value;throw Error('pre-FS failed')},configureRegistry(){throw Error('unexpected registry')},resolveModel(){return {model:controlledModel(async function*(){yield {type:'end'}})}}})).rejects.toThrow('pre-FS failed');expect(()=>original!.retain(async()=>{})).toThrow('retention expired');for(const cleanup of cleanups.reverse())await cleanup()}finally{await cache.closeAll();await coordinator.close()}
},30000)
