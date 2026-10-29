import { it,expect,vi } from 'vitest'
import { mkdtemp,mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireSessionLock } from '@i-harness/fs-lock'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
vi.mock('@i-harness/fs-lock',async original=>{const fs=await original<typeof import('@i-harness/fs-lock')>();return {...fs,acquireSessionLock:vi.fn(fs.acquireSessionLock)}})
it('retains failed original binding cleanup from a partial native acquisition until runtime close',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-source-debt-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}});await coordinator.create({sessionId:'source'});const projects=createProjectScopeBroker(coordinator,workspace,async()=>{throw Error('source denied')}),runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 const native=await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock');let failures=2,attempts=0
 vi.mocked(acquireSessionLock).mockImplementation(async options=>{const lock=await native.acquireSessionLock(options);return {get held(){return lock.held},async release(){attempts++;if(failures){failures--;throw Error('original lock debt')}await lock.release()}}})
 try{await expect(runtime.acquireSelectedSourceObservation('source')).rejects.toThrow();expect(failures).toBe(0);expect(()=>runtime.acquireSelectedSourceObservation('source')).toThrow('cleanup unresolved');await runtime.close();expect(attempts).toBeGreaterThanOrEqual(3)}finally{vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock);await runtime.close();await projects.close();await coordinator.close()}
})

