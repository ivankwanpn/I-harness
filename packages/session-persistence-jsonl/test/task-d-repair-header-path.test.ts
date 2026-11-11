import { expect,it,vi } from 'vitest'
const fault=vi.hoisted(()=>({path:'',hits:0}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return {...real,async open(...args:Parameters<typeof real.open>){const handle=await real.open(...args);if(String(args[0])===fault.path&&args[1]==='r+'){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();fault.hits++;const raw=await real.readFile(fault.path);await real.rename(fault.path,fault.path+'.detached');await real.writeFile(fault.path,raw)}}return handle}}})
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createBootstrapCaptureBackend } from '../src/backend/bootstrap-capture.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { heldFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createSelectedResultsIntent,readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { codecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { encodeFactBatch, decodeFactBatch } from '@i-harness/core-session'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
it.each([false,true])('selected birth header exact path acknowledgment: replacement=%s',async replace=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-header-path-')),path=join(root,'target.jsonl'),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('target'),held=heldFactOwner({sessionId:'target',incarnation:'original'},ownership,()=>claim.assertHeld()),backend=createBootstrapCaptureBackend(id=>join(root,id+'.jsonl'),async()=>{},root)
 const seed=compileSelectedResultsSemanticSeed(codecSeed('public-completed'))
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}},built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed},{version:1,kind:'semantic-bootstrap-selected-results-capture',request:route.request}),operation={invocation,target:{kind:'new' as const},stageBytes:Buffer.from(built.stageBytes),headerBytes:Buffer.from(built.headerBytes)}
 // Header acknowledgment qualifies a completed original birth. Header/stage
 // bytes alone must not bypass its seed and completion frame proof.
 const meta=JSON.parse(built.headerBytes)
 const first=encodeFactBatch('bootstrap:op:seed',meta.journal.legacyPrefixDigest,seed.records)
 const complete=encodeFactBatch('bootstrap:op:complete',decodeFactBatch(first.bytes).prefixDigest,[{type:'session/bootstrap',version:1,seq:seed.records.length,operationId:'op',manifestDigest:meta.semanticSeed.manifestDigest,dependencyClosureDigest:seed.dependencyDigest,seedLength:seed.records.length}])
 const birthBytes=Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes),Buffer.from(complete.bytes)])
 try{await writeFile(path,birthBytes);await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes);fault.path=replace?path:'';fault.hits=0
 const result=await backend.confirmSelectedBirthHeader('target',held,route,operation,14)
 if(replace){expect(fault.hits).toBe(1);expect(result.kind).toBe('unknown');claim.assertHeld();expect(await readFile(path)).toEqual(birthBytes);fault.path='';expect((await backend.confirmSelectedBirthHeader('target',held,route,operation,14)).kind).toBe('unknown')}else expect(result.kind).toBe('committed')
 await backend.settleBootstrapCaptureIO('target',held)
 }finally{fault.path='';await claim.release();await rm(root,{recursive:true,force:true})}
})
import { copyFile,readdir } from 'node:fs/promises'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { inspectColdSelectedTarget } from '../../session-persistence/src/selected-source-owner.ts'
const fixtures=process.env.IH_TASK_D_PREDECESSOR_FIXTURES
it.skipIf(!fixtures)('cold selected same-byte replacement during original sync cannot advance qualification',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-cold-replacement-')),source=join(fixtures!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!,path=join(root,'target.jsonl')
 await copyFile(join(source,'target.jsonl'),path);await copyFile(join(source,stageName),join(root,stageName))
 const stage=JSON.parse(await readFile(join(root,stageName),'utf8')),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},first=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 await first.loadOwned('target');await first.close()
 const before=await readFile(path),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{fault.path=path;fault.hits=0;expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('blocked');expect(fault.hits).toBe(1);expect(await readFile(path)).toEqual(before);await expect(coordinator.openManagedDocument('target')).rejects.toThrow();await expect(coordinator.withProcessReadObservation!('target',{documentKeys:[]},async()=>true,async value=>value)).rejects.toThrow()
 fault.path='';expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('blocked');await expect(coordinator.openManagedDocument('target')).rejects.toThrow();await coordinator.closeManagedDocument!('target')
 }finally{fault.path='';await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
