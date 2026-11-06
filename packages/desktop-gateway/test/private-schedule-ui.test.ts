import * as executorModule from '@i-harness/session-executor'
import * as taskFactory from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import * as commitFactory from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import {expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {isRpcSuccess,type RpcMessage} from '@i-harness/sdk'
import {createDesktopHost} from '../src/host.ts'
import {originalManagedExecutionFor} from '../../session-executor/src/host-managed-execution.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'

it('uses the actual Desktop private schedule owner and preserves cold compatibility',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'desktop-schedule-ui-')),workspace=join(root,'workspace'),sessionDir=join(root,'sessions'),settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json');await mkdir(workspace)
 await writeFile(settingsPath,JSON.stringify({autoTitle:false,sandboxMode:'read-only',compaction:{auto:false},llm:{providers:{fixture:{protocol:'openai-completions',baseURL:'http://127.0.0.1:1',apiKeyEnv:'IH_SCHEDULE_FIXTURE',models:[{id:'fixture',contextWindow:32000}]}},defaultModel:{provider:'fixture',model:'fixture'}}}));await writeFile(credentialsPath,JSON.stringify({refs:{IH_SCHEDULE_FIXTURE:'test-only'}}))
 let service:ReturnType<typeof executorModule.createSessionService>|undefined,coordinator:{snapshot?:(...args:never[])=>Promise<unknown>}|undefined,builds=0,calls=0
 const actualService=executorModule.createSessionService,actualCoordinator=taskFactory.createJsonlTaskTransitionCoordinator,actualCommit=commitFactory.createJsonlCommitCoordinator
 const serviceSpy=vi.spyOn(executorModule,'createSessionService').mockImplementation(options=>service=actualService(options)),coordinatorSpy=vi.spyOn(taskFactory,'createJsonlTaskTransitionCoordinator').mockImplementation((...args)=>coordinator=actualCoordinator(...args) as never),commitSpy=vi.spyOn(commitFactory,'createJsonlCommitCoordinator').mockImplementation((...args)=>coordinator=actualCommit(...args) as never)
 const frames:RpcMessage[]=[],options={workspace,sessionDir,settingsPath,credentialsPath,experimentalUsageObservations:false,onWrite:(frame:RpcMessage)=>frames.push(frame),buildProviderClient:(profile:import('@i-harness/provider').ProviderProfile,model?:string)=>{builds++;return controlledModel(async function*(){calls++;yield {type:'text/chunk' as const,text:'ready'};yield {type:'end' as const}},{modelId:model??profile.defaultModel,providerId:profile.name,executionIdentity:profile.executionIdentity})}}
 let host:Awaited<ReturnType<typeof createDesktopHost>>|undefined,id=0,restorePrivate=()=>{}
 const call=async(method:string,params:unknown={})=>{const requestId=++id;await host!.handleLine(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}));const reply=frames.find(frame=>'id'in frame&&frame.id===requestId);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result}
 try{
  host=await createDesktopHost(options);await call('initialize');const {sessionId}=await call('session/create') as {sessionId:string};await call('session/prompt',{sessionId,prompt:'activate'});expect(calls).toBe(1);const execution=originalManagedExecutionFor(service!,sessionId);expect(execution).toBeDefined();expect(Object.hasOwn(execution!.owner,'view')).toBe(false)
  const live=vi.spyOn(service!,'liveSession').mockImplementation(()=>{throw Error('Private Session read')}),assembly=vi.spyOn(service!,'assemblyFor').mockImplementation(async()=>{throw Error('Private assembly fallback')}),originalSnapshot=coordinator!.snapshot;if(!originalSnapshot)throw Error('Original snapshot unavailable');let snapshotCalls=0;coordinator!.snapshot=async()=>{snapshotCalls++;throw Error('Private snapshot fallback')};restorePrivate=()=>{live.mockRestore();assembly.mockRestore();coordinator!.snapshot=originalSnapshot}
  expect(await call('desktop/schedule/list',{sessionId})).toEqual({schedules:[]});const made=await call('desktop/schedule/create',{sessionId,command:{prompt:'later',after_seconds:3600}}) as {id:string;kind:string};expect(made.kind).toBe('after');expect((await call('desktop/schedule/list',{sessionId}) as {schedules:unknown[]}).schedules).toEqual([expect.objectContaining({id:made.id,prompt:'later'})]);expect(await call('desktop/schedule/delete',{sessionId,id:made.id})).toEqual({deleted:made.id});expect(await call('desktop/schedule/list',{sessionId})).toEqual({schedules:[]});expect(calls).toBe(1);expect(live).not.toHaveBeenCalled();expect(assembly).not.toHaveBeenCalled();expect(snapshotCalls).toBe(0)
  restorePrivate();restorePrivate=()=>{};await host.close();host=undefined;const beforeBuilds=builds,beforeCalls=calls
  host=await createDesktopHost(options);await call('initialize');expect(await call('desktop/schedule/list',{sessionId})).toEqual({schedules:[]});expect(builds).toBe(beforeBuilds);expect(calls).toBe(beforeCalls)
 }finally{restorePrivate();await host?.close();serviceSpy.mockRestore();coordinatorSpy.mockRestore();commitSpy.mockRestore()}
},30000)