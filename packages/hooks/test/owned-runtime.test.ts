import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createSession} from '@i-harness/core-session'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createManagedAgentModelOriginOwner} from '../../core-agent/src/tool-batch/model-origin.ts'
import {claudeRuntimeService,isOwnedClaudeRuntime} from '../src/claude-runtime.ts'
function ownedRuntime(ctx:ReturnType<typeof createContext>){const runtime=claudeRuntimeService(ctx);if(!isOwnedClaudeRuntime(runtime))throw Error('Original owned hook runtime missing');return runtime}
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-hooks-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await c.create({sessionId:'main'});const execution=await acquireManagedExecution(c,'main'),ctx=createContext(),domain=createManagedAgentModelOriginOwner(ctx,execution).domain;return {c,execution,ctx,domain}}

it('original hooks engine declares owned slot and isolates public/owned queues with original caps and validity',async()=>{
 const {c,ctx,domain}=await fixture(),runtime=ownedRuntime(ctx),session=createSession()
 try{
  const channel=captureExecutionHookChannel(ctx)
  runtime.queueContext(session,'public',()=>true)
  runtime.queueContextExecution(domain,'owned',()=>true);runtime.queueContextExecution(domain,'revoked',()=>false)
  expect(channel.drainContext(domain)).toEqual(['owned']);expect(channel.drainContext(domain)).toEqual([])
  expect(runtime.drainContext(session)).toEqual(['public'])
  for(let i=0;i<40;i++)runtime.queueContextExecution(domain,String(i),()=>true)
  expect(channel.drainContext(domain)).toEqual([Array.from({length:32},(_,i)=>String(i+8)).join('\n\n')])
  runtime.queueContextExecution(domain,'x'.repeat(70000),()=>true);expect(channel.drainContext(domain)[0]).toHaveLength(65536)
  let getters=0
  expect(()=>runtime.queueContextExecution(Object.defineProperty({...domain},'assertCurrent',{get(){getters++;throw Error('Copied domain getter')}}),'bad',()=>true)).toThrow()
  expect(getters).toBe(0)
 }finally{await c.close()}
})

it('same original Stop engine preserves adapter order, falsey failure and complete-only legacy handlers',async()=>{
 const {c,ctx,domain}=await fixture(),runtime=ownedRuntime(ctx),session=createSession(),order:string[]=[]
 try{
  const a=runtime.registerStopAdapter({session:async()=>{order.push('public-a');return 'public'},execution:async input=>{expect(input.domain).toBe(domain);order.push('owned-a');return 'a'}})
  const b=runtime.registerStopAdapter({session:async()=>undefined,execution:async()=>{order.push('owned-b');return 'b'}})
  const input=Object.freeze({domain,sessionId:'main',finalText:'done',turns:1,stopHookActive:false})
  expect(await captureExecutionHookChannel(ctx).beforeStop(input)).toEqual({reason:'a\n\nb'})
  expect(order).toEqual(['owned-a','owned-b'])
  expect(await runtime.beforeStop({session,finalText:'done',turns:1,stopHookActive:false})).toEqual({reason:'public'})
  a();b();let failed=false,error:unknown
  const remove=runtime.registerStopAdapter({session:async()=>undefined,execution:async()=>{throw undefined}})
  await runtime.beforeStopExecution(input).catch(value=>{failed=true;error=value});expect(failed).toBe(true);expect(error).toBeUndefined();remove()
  let legacy=0;const legacyHandler=async()=>{legacy++;return 'legacy'};runtime.registerStop(legacyHandler);runtime.registerStop(legacyHandler)
  expect(()=>captureExecutionHookChannel(ctx)).toThrow()
  await expect(runtime.beforeStopExecution(input)).rejects.toThrow('complete')
  expect(legacy).toBe(0)
  expect(await runtime.beforeStop({session,finalText:'done',turns:1,stopHookActive:false})).toEqual({reason:'legacy'});expect(legacy).toBe(1)
 }finally{await c.close()}
})

it('owned Stop await retains original domain currency and never continues callbacks after parent retirement',async()=>{
 const {c,ctx,domain,execution}=await fixture(),runtime=ownedRuntime(ctx),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let later=0
 runtime.registerStopAdapter({session:async()=>undefined,execution:async()=>{entered.resolve();await release.promise;return 'must not publish'}})
 runtime.registerStopAdapter({session:async()=>undefined,execution:async()=>{later++;return 'must not run'}})
 const running=runtime.beforeStopExecution(Object.freeze({domain,sessionId:'main',finalText:'done',turns:1,stopHookActive:false}));void running.catch(()=>{})
 try{await entered.promise;execution.revokeNewWork();release.resolve();await expect(running).rejects.toThrow();expect(later).toBe(0)}
 finally{release.resolve();await c.close()}
})
